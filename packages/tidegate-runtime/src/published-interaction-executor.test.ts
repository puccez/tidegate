import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  PublishedInteractionArtifactSchema,
  type InvokeInteractionErrorCode,
  type InvokeInteractionRequest,
  type InvokeInteractionResponse,
  type PublishedInteractionArtifact,
} from "@tidegate/contracts";
import { cancelAppointmentPublishedArtifact } from "@tidegate/contracts/fixtures";
import {
  defineAction,
  defineActionsCatalog,
  type AnyRuntimeAction,
  type RuntimeActionExecuteArgs,
  type RuntimeAuthContext,
} from "./action-catalog";
import { computeEffectiveCapabilitySet } from "./effective-capabilities";
import {
  createFakePublishedInteractionExecutor,
  createPublishedInteractionActionCallToken,
  createPublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionPayload,
  type PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor";
import { createTidegateRuntime } from "./runtime";

const auth: RuntimeAuthContext = {
  authMode: "api-key",
  organizationId: "demo-salon",
  tenantId: "demo-salon",
  subjectId: "api_key_demo",
  subjectType: "api_key",
  credentialId: "api_key_demo",
  credentialType: "api_key",
  scopes: ["tidegate:interaction:invoke"],
  permissions: ["booking:write"],
  authorization: {
    permissions: ["booking:write"],
    resourceGrants: [],
  },
};

function validRequest(
  overrides: Partial<InvokeInteractionRequest> = {},
): InvokeInteractionRequest {
  return {
    interactionVersion: "1",
    input: {
      appointmentId: "apt_123",
      reason: "Client requested cancellation",
    },
    surfaceId: "published-executor-test",
    sessionId: "sess_published_executor",
    messageId: "msg_published_executor",
    idempotencyKey: "ix.booking.cancelAppointment:sess_executor:apt_123",
    ...overrides,
  };
}

function cloneArtifact(
  overrides: Partial<PublishedInteractionArtifact> = {},
): PublishedInteractionArtifact {
  return PublishedInteractionArtifactSchema.parse({
    ...structuredClone(cancelAppointmentPublishedArtifact),
    ...overrides,
  });
}

function createBookingActions({
  execute,
}: {
  execute?: (
    args: RuntimeActionExecuteArgs<{
      appointmentId: string;
      reason?: string;
    }>,
  ) => Promise<unknown> | unknown;
} = {}): {
  actions: Map<string, AnyRuntimeAction>;
  getActionCalls: () => number;
} {
  let actionCalls = 0;
  const catalog = defineActionsCatalog({
    "booking.cancel": defineAction({
      id: "booking.cancel",
      description: "Cancel one appointment in the current salon.",
      effects: "write",
      requiredPermissions: ["booking:write"],
      tenantScope: { fromAuth: "tenantId" },
      inputSchema: z.object({
        appointmentId: z.string().min(1),
        reason: z.string().optional(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        appointmentId: z.string(),
      }),
      async execute(args) {
        actionCalls += 1;
        const result =
          execute !== undefined
            ? await execute(args)
            : {
                ok: true,
                appointmentId: args.input.appointmentId,
              };

        return result as { ok: boolean; appointmentId: string };
      },
    }),
  });

  return {
    actions: new Map(Object.entries(catalog)),
    getActionCalls: () => actionCalls,
  };
}

function createRuntime({
  actions = createBookingActions().actions,
  artifact = cloneArtifact(),
  executor,
}: {
  actions?: Map<string, AnyRuntimeAction>;
  artifact?: PublishedInteractionArtifact;
  executor: ReturnType<typeof createFakePublishedInteractionExecutor>;
}) {
  return createTidegateRuntime({
    actions,
    confirmationSecret: "executor-test-confirmation-secret",
    interactions: new Map(),
    publishedInteractionExecutor: executor,
    publishedInteractions: new Map([[artifact.id, artifact]]),
  });
}

async function callCancelAction(
  payload: PublishedInteractionExecutionPayload,
  runtime: PublishedInteractionTrustedRuntime,
  overrides: {
    actionId?: string;
    input?: unknown;
    invocationId?: string;
    actionCallToken?: PublishedInteractionExecutionPayload["actionCallToken"];
  } = {},
) {
  return runtime.callAction({
    invocationId: overrides.invocationId ?? payload.invocationId,
    actionCallToken: overrides.actionCallToken ?? payload.actionCallToken,
    actionId: overrides.actionId ?? "booking.cancel",
    input: overrides.input ?? payload.input,
  });
}

function expectErrorCode(
  response: InvokeInteractionResponse,
  status: "rejected" | "failed",
  code: InvokeInteractionErrorCode,
) {
  expect(response.status).toBe(status);

  if (response.status !== status) {
    throw new Error(`Expected ${status} response.`);
  }

  expect(response.error.code).toBe(code);
}

function expectTimedOut(response: InvokeInteractionResponse) {
  expect(response.status).toBe("timed_out");

  if (response.status !== "timed_out") {
    throw new Error("Expected timed_out response.");
  }

  expect(response.error.code).toBe("interaction_timeout");
}

describe("published interaction executor runtime boundary", () => {
  test("passes an immutable artifact snapshot and capability metadata to the fake executor", async () => {
    let seenPayload: PublishedInteractionExecutionPayload | undefined;
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(({ payload }) => {
      seenPayload = payload;

      return {
        status: "ok",
        output: {
          ok: true,
          appointmentId: "apt_123",
        },
      };
    });
    const runtime = createRuntime({ artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest({ invocationId: "invoke_payload_snapshot" }),
      auth,
    });

    expect(response).toMatchObject({
      status: "ok",
      invocationId: "invoke_payload_snapshot",
      output: {
        ok: true,
        appointmentId: "apt_123",
      },
    });

    if (seenPayload === undefined) {
      throw new Error("Expected fake executor to receive a payload.");
    }

    expect(seenPayload.artifact).toMatchObject({
      kind: "source_snapshot",
      id: artifact.id,
      version: artifact.version,
      sourceHash: artifact.sourceHash,
      source: artifact.source,
      actionCatalogId: artifact.actionCatalogId,
      actionCatalogVersion: artifact.actionCatalogVersion,
    });
    expect(seenPayload.capabilities).toEqual({
      schemaVersion: "tidegate.generatedCapabilities.v1",
      actionCatalogId: artifact.actionCatalogId,
      actionCatalogVersion: artifact.actionCatalogVersion,
      actionIds: ["booking.cancel"],
    });
    expect(seenPayload.allowedActionIds).toEqual(["booking.cancel"]);
    expect(seenPayload.timeout).toEqual(artifact.timeout);
    expect(seenPayload.auth.subjectId).toBe(auth.subjectId);
    expect(seenPayload.actionCallToken).toContain("invoke_payload_snapshot");
    expect(JSON.stringify(seenPayload)).not.toContain("bridge-secret-ref");
    expect(Object.isFrozen(seenPayload)).toBe(true);
    expect(Object.isFrozen(seenPayload.artifact)).toBe(true);
    expect(Object.isFrozen(seenPayload.allowedActionIds)).toBe(true);
  });

  test("validates ok executor output against the artifact output schema", async () => {
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(() => ({
      status: "ok",
      output: {
        ok: "yes",
        appointmentId: "apt_123",
      },
    }));
    const runtime = createRuntime({ artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth,
    });

    expectErrorCode(response, "failed", "output_schema_invalid");
  });

  test("maps structured executor failures to typed invoke responses", async () => {
    const scenarios = [
      {
        result: {
          status: "rejected" as const,
          error: {
            code: "action_not_allowed" as const,
            message: "Executor rejected the call.",
          },
        },
        expectedStatus: "rejected" as const,
        expectedCode: "action_not_allowed" as const,
      },
      {
        result: {
          status: "failed" as const,
          error: {
            code: "interaction_failed" as const,
            message: "Executor failed.",
          },
        },
        expectedStatus: "failed" as const,
        expectedCode: "interaction_failed" as const,
      },
      {
        result: {
          status: "timed_out" as const,
          error: {
            code: "interaction_timeout" as const,
            message: "Executor timed out.",
          },
        },
        expectedStatus: "timed_out" as const,
        expectedCode: "interaction_timeout" as const,
      },
    ];

    for (const scenario of scenarios) {
      const artifact = cloneArtifact({
        id: `ix.booking.cancelAppointment.${scenario.expectedStatus}`,
      });
      const executor = createFakePublishedInteractionExecutor(
        () => scenario.result,
      );
      const runtime = createRuntime({ artifact, executor });
      const response = await runtime.invokeInteraction({
        interactionId: artifact.id,
        request: validRequest({
          idempotencyKey: `executor-error-${scenario.expectedStatus}`,
        }),
        auth,
      });

      if (scenario.expectedStatus === "timed_out") {
        expectTimedOut(response);
      } else {
        expectErrorCode(
          response,
          scenario.expectedStatus,
          scenario.expectedCode,
        );
      }
    }
  });

  test("scopes action call tokens to one invocation and revokes them after execution", async () => {
    const artifact = cloneArtifact();
    let firstPayload: PublishedInteractionExecutionPayload | undefined;
    let firstRuntime: PublishedInteractionTrustedRuntime | undefined;
    const executor = createFakePublishedInteractionExecutor(
      async ({ executionIndex, payload, runtime }) => {
        if (executionIndex === 0) {
          firstPayload = payload;
          firstRuntime = runtime;

          return {
            status: "ok",
            output: {
              ok: true,
              appointmentId: "apt_123",
            },
          };
        }

        return {
          status: "ok",
          output: await callCancelAction(payload, runtime, {
            actionCallToken: firstPayload?.actionCallToken,
          }),
        };
      },
    );
    const runtime = createRuntime({ artifact, executor });

    const first = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest({
        idempotencyKey: "token-scope-first",
        invocationId: "invoke_token_first",
      }),
      auth,
    });

    expect(first.status).toBe("ok");

    if (firstPayload === undefined || firstRuntime === undefined) {
      throw new Error("Expected first invocation callback to be captured.");
    }

    await expect(callCancelAction(firstPayload, firstRuntime)).rejects.toThrow(
      "not valid for this invocation",
    );

    const second = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest({
        idempotencyKey: "token-scope-second",
        invocationId: "invoke_token_second",
      }),
      auth,
    });

    expectErrorCode(second, "rejected", "action_not_allowed");
  });

  test("callback enforces action allowlists before backend execution", async () => {
    const { actions, getActionCalls } = createBookingActions();
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(
      async ({ payload, runtime }) => ({
        status: "ok",
        output: await callCancelAction(payload, runtime, {
          actionId: "booking.refund",
        }),
      }),
    );
    const runtime = createRuntime({ actions, artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth,
    });

    expectErrorCode(response, "rejected", "action_not_allowed");
    expect(getActionCalls()).toBe(0);
  });

  test("callback validates action input before backend execution", async () => {
    const { actions, getActionCalls } = createBookingActions();
    const artifact = cloneArtifact({
      inputSchema: {
        type: "object",
      },
    });
    const executor = createFakePublishedInteractionExecutor(
      async ({ payload, runtime }) => ({
        status: "ok",
        output: await callCancelAction(payload, runtime),
      }),
    );
    const runtime = createRuntime({ actions, artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest({
        input: {
          reason: "Missing appointment id",
        },
      }),
      auth,
    });

    expectErrorCode(response, "failed", "action_input_invalid");
    expect(getActionCalls()).toBe(0);
  });

  test("callback validates action output after backend execution", async () => {
    const { actions, getActionCalls } = createBookingActions({
      execute: () => ({
        ok: "yes",
        appointmentId: "apt_123",
      }),
    });
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(
      async ({ payload, runtime }) => ({
        status: "ok",
        output: await callCancelAction(payload, runtime),
      }),
    );
    const runtime = createRuntime({ actions, artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth,
    });

    expectErrorCode(response, "failed", "action_output_invalid");
    expect(getActionCalls()).toBe(1);
  });

  test("callback enforces permissions, effects, and tenant scope before backend execution", async () => {
    const scenarios = [
      {
        name: "permission",
        artifact: cloneArtifact({ id: "ix.booking.cancelAppointment.permission" }),
        auth: {
          ...auth,
          permissions: [],
          authorization: {
            permissions: [],
            resourceGrants: [],
          },
        },
        expectedCode: "permission_denied" as const,
      },
      {
        name: "effects",
        artifact: cloneArtifact({
          id: "ix.booking.cancelAppointment.effects",
          effects: {
            ...cancelAppointmentPublishedArtifact.effects,
            declared: "read",
          },
        }),
        auth,
        expectedCode: "action_not_allowed" as const,
      },
      {
        name: "tenant",
        artifact: cloneArtifact({ id: "ix.booking.cancelAppointment.tenant" }),
        auth: {
          ...auth,
          tenantId: undefined,
        },
        expectedCode: "tenant_mismatch" as const,
      },
    ];

    for (const scenario of scenarios) {
      const { actions, getActionCalls } = createBookingActions();
      const executor = createFakePublishedInteractionExecutor(
        async ({ payload, runtime }) => ({
          status: "ok",
          output: await callCancelAction(payload, runtime),
        }),
      );
      const runtime = createRuntime({
        actions,
        artifact: scenario.artifact,
        executor,
      });

      const response = await runtime.invokeInteraction({
        interactionId: scenario.artifact.id,
        request: validRequest({
          idempotencyKey: `policy-${scenario.name}`,
        }),
        auth: scenario.auth,
      });

      expectErrorCode(response, "rejected", scenario.expectedCode);
      expect(getActionCalls()).toBe(0);
    }
  });

  test("callback enforces action call budgets", async () => {
    const { actions, getActionCalls } = createBookingActions();
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(
      async ({ payload, runtime }) => {
        await callCancelAction(payload, runtime);

        return {
          status: "ok",
          output: await callCancelAction(payload, runtime),
        };
      },
    );
    const runtime = createRuntime({ actions, artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth,
    });

    expectErrorCode(response, "rejected", "action_not_allowed");
    expect(getActionCalls()).toBe(1);
  });

  test("callback enforces per-action timeouts", async () => {
    const { actions, getActionCalls } = createBookingActions({
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 20));

        return {
          ok: true,
          appointmentId: "apt_123",
        };
      },
    });
    const artifact = cloneArtifact({
      timeout: {
        ...cancelAppointmentPublishedArtifact.timeout,
        executionMs: 100,
      },
      allowedActions: [
        {
          ...cancelAppointmentPublishedArtifact.allowedActions[0]!,
          timeoutMs: 1,
        },
      ],
    });
    const executor = createFakePublishedInteractionExecutor(
      async ({ payload, runtime }) => ({
        status: "ok",
        output: await callCancelAction(payload, runtime),
      }),
    );
    const runtime = createRuntime({ actions, artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth,
    });

    expectTimedOut(response);
    expect(getActionCalls()).toBe(1);
  });

  test("pre-execution policy blocks executor calls for idempotency, confirmation, and revocation", async () => {
    const cases = [
      {
        name: "idempotency",
        artifact: cloneArtifact({ id: "ix.booking.cancelAppointment.idempotency" }),
        request: validRequest({
          idempotencyKey: undefined,
        }),
        assertResponse(response: InvokeInteractionResponse) {
          expectErrorCode(response, "rejected", "idempotency_key_required");
        },
      },
      {
        name: "confirmation",
        artifact: cloneArtifact({
          id: "ix.booking.cancelAppointment.confirmation",
          confirmation: {
            required: true,
            message: "Confirm cancellation.",
          },
        }),
        request: validRequest({
          idempotencyKey: "pre-confirmation",
        }),
        assertResponse(response: InvokeInteractionResponse) {
          expect(response.status).toBe("confirmation_required");
        },
      },
      {
        name: "revocation",
        artifact: cloneArtifact({
          id: "ix.booking.cancelAppointment.revoked",
          status: "revoked",
        }),
        request: validRequest({
          idempotencyKey: "pre-revocation",
        }),
        assertResponse(response: InvokeInteractionResponse) {
          expectErrorCode(response, "rejected", "interaction_revoked");
        },
      },
    ];

    for (const item of cases) {
      const executor = createFakePublishedInteractionExecutor(() => {
        throw new Error(`Executor should not run for ${item.name}.`);
      });
      const runtime = createRuntime({
        artifact: item.artifact,
        executor,
      });
      const response = await runtime.invokeInteraction({
        interactionId: item.artifact.id,
        request: item.request,
        auth,
      });

      item.assertResponse(response);
      expect(executor.executions).toHaveLength(0);
    }
  });

  test("keeps withheld capabilities injected as denied stubs from the same effective set", async () => {
    // #28 invariants (b) and (d): a caller without the required permission
    // still gets the FULL declared capability surface injected (so
    // `capabilitiesMatchAllowedActions` cannot trip and generated code never
    // hits a missing property), and calling the withheld capability fails
    // with the same structured permission_denied the live path produces.
    const { actions, getActionCalls } = createBookingActions();
    const artifact = cloneArtifact();
    let seenPayload: PublishedInteractionExecutionPayload | undefined;
    const executor = createFakePublishedInteractionExecutor(
      async ({ payload, runtime }) => {
        seenPayload = payload;

        return {
          status: "ok",
          output: await callCancelAction(payload, runtime),
        };
      },
    );
    const runtime = createRuntime({ actions, artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth: {
        ...auth,
        permissions: [],
        authorization: { permissions: [], resourceGrants: [] },
      },
    });

    expectErrorCode(response, "rejected", "permission_denied");
    expect(getActionCalls()).toBe(0);

    if (seenPayload === undefined) {
      throw new Error("Expected fake executor to receive a payload.");
    }

    // Injection never narrows: the denied action keeps its declared slot in
    // BOTH payload fields, derived from the one effective set.
    expect(seenPayload.capabilities.actionIds).toEqual(["booking.cancel"]);
    expect(seenPayload.allowedActionIds).toEqual(["booking.cancel"]);
  });

  test("an empty effective set still executes when the interaction calls no actions", async () => {
    // #28 invariant (e): all declared actions withheld is a legal state.
    // The sandbox runs with every capability present as a denied stub; if
    // the interaction never calls one, the execution completes normally.
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(() => ({
      status: "ok",
      output: { ok: true, appointmentId: "apt_123" },
    }));
    const runtime = createRuntime({ artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth: {
        ...auth,
        permissions: [],
        authorization: { permissions: [], resourceGrants: [] },
      },
    });

    expect(response.status).toBe("ok");
    expect(executor.executions).toHaveLength(1);
  });

  test("the snapshot gate enforces the execution-start decision even if the catalog mutates mid-execution", async () => {
    // Proof the effective set is an enforced gate, not a call-time
    // re-derivation: the caller lacks the permission (withheld at execution
    // start), and the action is REMOVED from the live catalog before the
    // call. Call-time re-derivation would report action_not_registered; the
    // snapshot's precomputed permission_denied wins.
    const { actions, getActionCalls } = createBookingActions();
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(
      async ({ payload, runtime }) => {
        actions.delete("booking.cancel");

        return {
          status: "ok",
          output: await callCancelAction(payload, runtime),
        };
      },
    );
    const runtime = createRuntime({ actions, artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth: {
        ...auth,
        permissions: [],
        authorization: { permissions: [], resourceGrants: [] },
      },
    });

    expectErrorCode(response, "rejected", "permission_denied");
    expect(getActionCalls()).toBe(0);
  });

  test("live per-call checks remain as defense in depth behind the snapshot gate", async () => {
    // #28 invariant (c): a capability granted at execution start is still
    // re-checked live at call time — removing the action from the catalog
    // mid-execution fails closed with the live action_not_registered.
    const { actions, getActionCalls } = createBookingActions();
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(
      async ({ payload, runtime }) => {
        actions.delete("booking.cancel");

        return {
          status: "ok",
          output: await callCancelAction(payload, runtime),
        };
      },
    );
    const runtime = createRuntime({ actions, artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth,
    });

    expectErrorCode(response, "rejected", "action_not_registered");
    expect(getActionCalls()).toBe(0);
  });

  test("a catalog entry replaced mid-execution still executes the snapshotted implementation", async () => {
    // The effective set is frozen at execution start: the trusted caller
    // executes the granted capability's snapshotted action ref, so swapping
    // the catalog entry mid-execution can never substitute a new
    // implementation or schemas into a running execution. (Removal still
    // fails closed via the live existence check — see the defense-in-depth
    // test above.)
    const { actions, getActionCalls } = createBookingActions();
    const { actions: replacementActions, getActionCalls: getReplacementCalls } =
      createBookingActions({
        execute: () => ({ ok: false, appointmentId: "apt_hijacked" }),
      });
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(
      async ({ payload, runtime }) => {
        actions.set(
          "booking.cancel",
          replacementActions.get("booking.cancel")!,
        );

        return {
          status: "ok",
          output: await callCancelAction(payload, runtime),
        };
      },
    );
    const runtime = createRuntime({ actions, artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth,
    });

    expect(response.status).toBe("ok");
    expect(getActionCalls()).toBe(1);
    expect(getReplacementCalls()).toBe(0);
  });

  test("an artifact allowlist with duplicate action ids still invokes with the pre-snapshot payload surface", async () => {
    // Publish-time validation rejects duplicate allowlist ids, but artifacts
    // can reach the runtime from external stores (the published-interaction
    // resolver) and the contract schema does not forbid duplicates. The
    // effective set mirrors the allowlist element-for-element, so payload
    // construction succeeds and injection carries the duplicate exactly as
    // it did before the effective set existed — the sandbox's
    // capability-metadata match stays the enforcement point, never a new
    // interaction_failed at payload construction.
    const duplicateAllowlist = [
      ...structuredClone(cancelAppointmentPublishedArtifact.allowedActions),
      structuredClone(cancelAppointmentPublishedArtifact.allowedActions[0]!),
    ];
    const artifact = cloneArtifact({ allowedActions: duplicateAllowlist });
    let seenPayload: PublishedInteractionExecutionPayload | undefined;
    const executor = createFakePublishedInteractionExecutor(({ payload }) => {
      seenPayload = payload;

      return {
        status: "ok",
        output: { ok: true, appointmentId: "apt_123" },
      };
    });
    const runtime = createRuntime({ artifact, executor });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest(),
      auth,
    });

    expect(response.status).toBe("ok");
    expect(seenPayload?.allowedActionIds).toEqual([
      "booking.cancel",
      "booking.cancel",
    ]);
    expect(seenPayload?.capabilities.actionIds).toEqual([
      "booking.cancel",
      "booking.cancel",
    ]);
  });

  test("rejects an effective capability set that was not computed for the artifact's allowlist", async () => {
    const artifact = cloneArtifact();
    const { actions } = createBookingActions();
    const header = {
      id: artifact.id,
      version: artifact.version,
      declaredEffect: artifact.effects.declared,
      riskLevel: artifact.effects.riskLevel,
      idempotency: artifact.effects.idempotency,
      confirmation: {
        required: false,
        message: null,
        token: { presented: false as const, verified: false as const },
      },
      status: artifact.status,
    };
    const mismatches = [
      {
        name: "different interaction",
        set: computeEffectiveCapabilitySet({
          actions,
          allowedActions: artifact.allowedActions,
          auth,
          interaction: { ...header, id: "ix.other.interaction" },
          now: 0,
        }),
      },
      {
        name: "narrowed declared surface",
        set: computeEffectiveCapabilitySet({
          actions,
          allowedActions: [],
          auth,
          interaction: header,
          now: 0,
        }),
      },
      {
        name: "widened declared surface",
        set: computeEffectiveCapabilitySet({
          actions,
          allowedActions: [
            ...artifact.allowedActions,
            { id: "booking.extra" },
          ],
          auth,
          interaction: header,
          now: 0,
        }),
      },
    ];

    for (const mismatch of mismatches) {
      expect(() =>
        createPublishedInteractionExecutionPayload({
          actionCallToken:
            createPublishedInteractionActionCallToken("invoke_mismatch"),
          artifact,
          auth,
          effectiveCapabilities: mismatch.set,
          input: validRequest().input,
          invocationId: "invoke_mismatch",
        }),
      ).toThrow(
        "requires an effective capability set computed for this artifact's published allowlist",
      );
    }
  });

  test("deduplicates fake executor invocations through the runtime idempotency path", async () => {
    const artifact = cloneArtifact();
    const executor = createFakePublishedInteractionExecutor(({ executionIndex }) => ({
      status: "ok",
      output: {
        ok: true,
        appointmentId: `apt_${executionIndex}`,
      },
    }));
    const runtime = createRuntime({ artifact, executor });
    const request = validRequest({
      idempotencyKey: "fake-executor-idempotency",
    });

    const first = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request,
      auth,
    });
    const second = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request,
      auth,
    });

    expect(first.status).toBe("ok");
    expect(second).toEqual(first);
    expect(executor.executions).toHaveLength(1);
  });
});
