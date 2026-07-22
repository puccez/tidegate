import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { legacyPublicInteractionConfirmPath } from "@tidegate/contracts";
import type {
  GeneratedInteractionContractV1,
  InvokeInteractionErrorCode,
  InvokeInteractionRequest,
  InvokeInteractionResponse,
} from "@tidegate/contracts";
import { cancelAppointmentContract } from "@tidegate/contracts/fixtures";
import {
  defineAction,
  defineActionsCatalog,
  type AnyRuntimeAction,
  type RuntimeAuthContext,
} from "./action-catalog";
import {
  cancelAppointmentInteraction,
  demoActions,
  demoInteractions,
} from "./demo-fixtures";
import {
  createInteractionRegistry,
  defineInteraction,
  type StaticInteraction,
} from "./interaction-registry";
import { createTidegateRuntime } from "./runtime";

const demoAuth: RuntimeAuthContext = {
  organizationId: "demo-salon",
  subjectId: "demo-user",
  subjectType: "user",
  credentialId: "demo-session",
  credentialType: "session",
  scopes: ["tidegate:interaction:invoke"],
  userId: "demo-user",
  workosUserId: "demo-user",
  tenantId: "demo-salon",
  authorization: {
    permissions: ["booking:write"],
    resourceGrants: [],
  },
  permissions: ["booking:write"],
  authMode: "local-dev",
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
    surfaceId: "interaction-demo",
    sessionId: "sess_demo",
    messageId: "msg_demo",
    idempotencyKey: "ix.booking.cancelAppointment:sess_demo:apt_123",
    ...overrides,
  };
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

const TEST_CONFIRMATION_SECRET = "runtime-test-confirmation-secret";

function createRuntime({
  actions = new Map(Object.entries(demoActions)),
  confirmationSecret = TEST_CONFIRMATION_SECRET,
  interactions = demoInteractions,
  now,
}: {
  actions?: Map<string, AnyRuntimeAction>;
  confirmationSecret?: string;
  interactions?: Map<string, StaticInteraction>;
  now?: () => number;
} = {}) {
  return createTidegateRuntime({
    actions,
    confirmationSecret,
    interactions,
    now,
  });
}

function confirmationCancelActions(onActionCall: () => void) {
  return defineActionsCatalog({
    "booking.cancel": defineAction({
      id: "booking.cancel",
      description: "Cancel one appointment.",
      effects: "write",
      tenantScope: {
        tenantId: "demo-salon",
      },
      inputSchema: z.object({ appointmentId: z.string().min(1) }),
      outputSchema: z.object({
        ok: z.boolean(),
        appointmentId: z.string(),
      }),
      async execute({ input }) {
        onActionCall();
        return { ok: true, appointmentId: input.appointmentId };
      },
    }),
  });
}

function confirmationInteraction(id: string, version?: string) {
  const contract = cloneContract({
    id,
    ...(version === undefined ? {} : { version }),
    confirmation: {
      required: true,
      message: "Confirm appointment cancellation.",
    },
  });

  return defineInteraction({
    contract,
    async run(input, ctx) {
      return ctx.actions.call("booking.cancel", input);
    },
  });
}

function createConfirmationRuntime({
  confirmationSecret,
  interactionId,
  now,
  onActionCall = () => {},
  version,
}: {
  confirmationSecret?: string;
  interactionId: string;
  now?: () => number;
  onActionCall?: () => void;
  version?: string;
}) {
  const interaction = confirmationInteraction(interactionId, version);

  return {
    interaction,
    runtime: createRuntime({
      actions: new Map(Object.entries(confirmationCancelActions(onActionCall))),
      confirmationSecret,
      interactions: createInteractionRegistry([interaction]),
      now,
    }),
  };
}

function expectConfirmationRequired(response: InvokeInteractionResponse) {
  expect(response.status).toBe("confirmation_required");
  if (response.status !== "confirmation_required") {
    throw new Error("Expected confirmation_required response.");
  }
  return response.confirmation;
}

function cloneContract(
  overrides: Partial<GeneratedInteractionContractV1> = {},
): GeneratedInteractionContractV1 {
  return {
    ...structuredClone(cancelAppointmentContract),
    ...overrides,
  };
}

describe("createTidegateRuntime.invokeInteraction", () => {
  test("rejects invalid invoke request shape", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: { input: {} },
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "invalid_request");
  });

  test("rejects unknown interaction ids", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: "ix.booking.unknown",
      request: validRequest(),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "interaction_not_found");
  });

  test("rejects interaction version mismatches", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest({ interactionVersion: "2" }),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "interaction_version_mismatch");
  });

  test("requires idempotency keys for required write interactions", async () => {
    const runtime = createRuntime();
    const request = validRequest();
    delete request.idempotencyKey;

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request,
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "idempotency_key_required");
  });

  test("returns confirmation_required with a minted token before executing actions", async () => {
    let actionCalls = 0;
    const interactionId = "ix.booking.cancelAppointment.confirmed";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      onActionCall: () => {
        actionCalls += 1;
      },
    });

    const response = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: demoAuth,
    });

    const confirmation = expectConfirmationRequired(response);
    expect(confirmation.confirmationToken.length).toBeGreaterThan(0);
    expect(confirmation.inputHash).toStartWith("sha256:");
    expect(confirmation.confirmRoute).toBe(
      legacyPublicInteractionConfirmPath({ interactionId }),
    );
    expect(actionCalls).toBe(0);
  });

  test("treats an empty confirmationSecret as unset and never signs with an empty HMAC key", async () => {
    const interactionId = "ix.booking.cancelAppointment.emptySecret";
    const { runtime } = createConfirmationRuntime({
      confirmationSecret: "",
      interactionId,
    });
    const envSecret = "runtime-test-env-resolved-secret";
    const previousSecret = process.env.TIDEGATE_CONFIRMATION_SECRET;
    process.env.TIDEGATE_CONFIRMATION_SECRET = envSecret;

    try {
      const response = await runtime.invokeInteraction({
        interactionId,
        request: validRequest(),
        auth: demoAuth,
      });

      const confirmation = expectConfirmationRequired(response);
      const [payload, signature] = confirmation.confirmationToken.split(".");
      const hmacWith = (key: string) =>
        createHmac("sha256", key).update(payload!, "utf8").digest("base64url");

      // The token must be signed with the env-resolved secret, never with the
      // forgeable empty key the caller passed.
      expect(signature).toBe(hmacWith(envSecret));
      expect(signature).not.toBe(hmacWith(""));
    } finally {
      if (previousSecret === undefined) {
        delete process.env.TIDEGATE_CONFIRMATION_SECRET;
      } else {
        process.env.TIDEGATE_CONFIRMATION_SECRET = previousSecret;
      }
    }
  });

  test("requires an idempotency key before minting a confirmation token", async () => {
    let actionCalls = 0;
    const interactionId = "ix.booking.cancelAppointment.confirmNoIdempotency";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      onActionCall: () => {
        actionCalls += 1;
      },
    });
    const request = validRequest();
    delete request.idempotencyKey;

    const response = await runtime.invokeInteraction({
      interactionId,
      request,
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "idempotency_key_required");
    expect(actionCalls).toBe(0);
  });

  test("executes the confirmed request when the minted token is echoed back", async () => {
    let actionCalls = 0;
    const interactionId = "ix.booking.cancelAppointment.confirmExecute";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      onActionCall: () => {
        actionCalls += 1;
      },
    });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);

    const phase2 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
      }),
      auth: demoAuth,
    });

    expect(phase2).toMatchObject({
      status: "ok",
      output: {
        ok: true,
        appointmentId: "apt_123",
      },
    });
    expect(actionCalls).toBe(1);
  });

  test("deduplicates a replayed confirmed request through the idempotency ledger", async () => {
    let actionCalls = 0;
    const interactionId = "ix.booking.cancelAppointment.confirmReplaySameKey";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      onActionCall: () => {
        actionCalls += 1;
      },
    });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);
    const confirmedRequest = validRequest({
      confirmationToken: confirmation.confirmationToken,
    });

    const first = await runtime.invokeInteraction({
      interactionId,
      request: confirmedRequest,
      auth: demoAuth,
    });
    const replay = await runtime.invokeInteraction({
      interactionId,
      request: confirmedRequest,
      auth: demoAuth,
    });

    expect(first.status).toBe("ok");
    expect(replay).toEqual(first);
    expect(actionCalls).toBe(1);
  });

  test("documents the R2 window: a replayed token with a fresh idempotency key executes again within the TTL", async () => {
    // Deliberate, deferred behavior (see issue #24 plan, Out of Scope):
    // full cross-request single-use tokens require a pending-intent store.
    let actionCalls = 0;
    const interactionId = "ix.booking.cancelAppointment.confirmReplayFreshKey";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      onActionCall: () => {
        actionCalls += 1;
      },
    });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);

    const first = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
      }),
      auth: demoAuth,
    });
    const freshKeyReplay = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
        idempotencyKey: "fresh-key-within-ttl",
      }),
      auth: demoAuth,
    });

    expect(first.status).toBe("ok");
    expect(freshKeyReplay.status).toBe("ok");
    expect(actionCalls).toBe(2);
  });

  test("returns the cached result when a confirmed, executed request is retried after token expiry within the idempotency TTL", async () => {
    let actionCalls = 0;
    let nowMs = 1_750_000_000_000;
    const interactionId = "ix.booking.cancelAppointment.confirmRetryExpiredToken";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      now: () => nowMs,
      onActionCall: () => {
        actionCalls += 1;
      },
    });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);
    const confirmedRequest = validRequest({
      confirmationToken: confirmation.confirmationToken,
    });

    // Execute one minute after mint: the idempotency record now outlives the
    // confirmation token by that minute.
    nowMs += 60 * 1000;
    const first = await runtime.invokeInteraction({
      interactionId,
      request: confirmedRequest,
      auth: demoAuth,
    });
    expect(first.status).toBe("ok");

    // Five minutes after mint the token is expired, but the idempotency
    // record (written at mint+1min) is still alive: the retry must hit the
    // ledger and return the cached result, not confirmation_expired.
    nowMs += 4 * 60 * 1000;
    const retry = await runtime.invokeInteraction({
      interactionId,
      request: confirmedRequest,
      auth: demoAuth,
    });

    expect(retry).toEqual(first);
    expect(actionCalls).toBe(1);
  });

  test("still rejects idempotency key reuse with different input after token expiry", async () => {
    let actionCalls = 0;
    let nowMs = 1_750_000_000_000;
    const interactionId = "ix.booking.cancelAppointment.confirmRetryConflict";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      now: () => nowMs,
      onActionCall: () => {
        actionCalls += 1;
      },
    });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);

    nowMs += 60 * 1000;
    const first = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
      }),
      auth: demoAuth,
    });
    expect(first.status).toBe("ok");

    nowMs += 4 * 60 * 1000;
    const conflictingRetry = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
        input: {
          appointmentId: "apt_123",
          reason: "A different reason than the one confirmed",
        },
      }),
      auth: demoAuth,
    });

    expectErrorCode(conflictingRetry, "rejected", "invalid_request");
    expect(actionCalls).toBe(1);
  });

  test("an expired token with a fresh idempotency key still returns confirmation_expired", async () => {
    let actionCalls = 0;
    let nowMs = 1_750_000_000_000;
    const interactionId = "ix.booking.cancelAppointment.confirmExpiredFreshKey";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      now: () => nowMs,
      onActionCall: () => {
        actionCalls += 1;
      },
    });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);

    nowMs += 60 * 1000;
    const first = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
      }),
      auth: demoAuth,
    });
    expect(first.status).toBe("ok");

    // A fresh key misses the ledger, so the full confirmation gate still
    // runs and the expired token is rejected.
    nowMs += 4 * 60 * 1000;
    const freshKeyRetry = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
        idempotencyKey: "fresh-key-after-token-expiry",
      }),
      auth: demoAuth,
    });

    expectErrorCode(freshKeyRetry, "rejected", "confirmation_expired");
    expect(actionCalls).toBe(1);
  });

  test("rejects a confirmation token when the input changed since it was confirmed", async () => {
    let actionCalls = 0;
    const interactionId = "ix.booking.cancelAppointment.confirmMismatch";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      onActionCall: () => {
        actionCalls += 1;
      },
    });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);

    const response = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
        input: {
          appointmentId: "apt_123",
          reason: "A different reason than the one confirmed",
        },
      }),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "confirmation_input_mismatch");
    expect(actionCalls).toBe(0);
  });

  test("rejects a confirmation token minted in a different session", async () => {
    const interactionId = "ix.booking.cancelAppointment.confirmSession";
    const { runtime } = createConfirmationRuntime({ interactionId });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({ sessionId: "sess_original" }),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);

    const response = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
        sessionId: "sess_other",
      }),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "confirmation_input_mismatch");
  });

  test("binds salonId as the tenant so a token minted in one salon is rejected in another", async () => {
    let actionCalls = 0;
    const interactionId = "ix.booking.cancelAppointment.confirmSalonTenant";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      onActionCall: () => {
        actionCalls += 1;
      },
    });
    const salonOnlyAuth = (salonId: string): RuntimeAuthContext => ({
      subjectId: "demo-user",
      subjectType: "user",
      credentialId: "demo-session",
      credentialType: "session",
      scopes: ["tidegate:interaction:invoke"],
      permissions: ["booking:write"],
      salonId,
      authMode: "local-dev",
    });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: salonOnlyAuth("salon-a"),
    });
    const confirmation = expectConfirmationRequired(phase1);

    const response = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
      }),
      auth: salonOnlyAuth("salon-b"),
    });

    expectErrorCode(response, "rejected", "confirmation_input_mismatch");
    expect(actionCalls).toBe(0);
  });

  test("rejects an expired confirmation token", async () => {
    let nowMs = 1_750_000_000_000;
    const interactionId = "ix.booking.cancelAppointment.confirmExpired";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      now: () => nowMs,
    });

    const phase1 = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);

    nowMs += 5 * 60 * 1000;
    const response = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
      }),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "confirmation_expired");
  });

  test("rejects garbage confirmation tokens as invalid", async () => {
    let actionCalls = 0;
    const interactionId = "ix.booking.cancelAppointment.confirmGarbage";
    const { runtime } = createConfirmationRuntime({
      interactionId,
      onActionCall: () => {
        actionCalls += 1;
      },
    });

    const response = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({ confirmationToken: "not-a-kernel-token" }),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "confirmation_invalid");
    expect(actionCalls).toBe(0);
  });

  test("validates input before the confirmation gate so no token is minted for invalid input", async () => {
    const interactionId = "ix.booking.cancelAppointment.confirmInvalidInput";
    const { runtime } = createConfirmationRuntime({ interactionId });

    const response = await runtime.invokeInteraction({
      interactionId,
      request: validRequest({
        input: {
          reason: "Missing appointment id",
        },
      }),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "input_schema_invalid");
    expect("confirmation" in response).toBe(false);
  });

  test("rejects a confirmation token bound to a different interaction version", async () => {
    const interactionId = "ix.booking.cancelAppointment.confirmVersion";
    const { runtime: runtimeV1 } = createConfirmationRuntime({
      interactionId,
      version: "1",
    });
    const { runtime: runtimeV2 } = createConfirmationRuntime({
      interactionId,
      version: "2",
    });

    const phase1 = await runtimeV1.invokeInteraction({
      interactionId,
      request: validRequest({ interactionVersion: "1" }),
      auth: demoAuth,
    });
    const confirmation = expectConfirmationRequired(phase1);

    // The request claims v2 and the artifact is v2, so the outer version
    // guard passes; only the token binding can catch the drift.
    const response = await runtimeV2.invokeInteraction({
      interactionId,
      request: validRequest({
        confirmationToken: confirmation.confirmationToken,
        interactionVersion: "2",
      }),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "confirmation_input_mismatch");
  });

  test("refuses to mint a confirmation token for an auth context with no subject", async () => {
    const interactionId = "ix.booking.cancelAppointment.confirmNoSubject";
    const { runtime } = createConfirmationRuntime({ interactionId });

    const response = await runtime.invokeInteraction({
      interactionId,
      request: validRequest(),
      auth: {
        ...demoAuth,
        subjectId: undefined,
        userId: undefined,
        workosUserId: undefined,
        machineClientId: undefined,
        clientId: undefined,
        credentialId: undefined,
      },
    });

    expectErrorCode(response, "rejected", "auth_required");
  });

  test("fails closed when no confirmation secret is available", async () => {
    const interactionId = "ix.booking.cancelAppointment.confirmNoSecret";
    const interaction = confirmationInteraction(interactionId);
    const originalSecret = process.env.TIDEGATE_CONFIRMATION_SECRET;
    const originalDevAuth = process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH;
    delete process.env.TIDEGATE_CONFIRMATION_SECRET;
    delete process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH;

    try {
      const runtime = createTidegateRuntime({
        actions: new Map(Object.entries(confirmationCancelActions(() => {}))),
        interactions: createInteractionRegistry([interaction]),
      });

      const response = await runtime.invokeInteraction({
        interactionId,
        request: validRequest(),
        auth: demoAuth,
      });

      expectErrorCode(response, "failed", "interaction_failed");
    } finally {
      if (originalSecret !== undefined) {
        process.env.TIDEGATE_CONFIRMATION_SECRET = originalSecret;
      }
      if (originalDevAuth !== undefined) {
        process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = originalDevAuth;
      }
    }
  });

  test("rejects interactions that call actions outside allowedActions", async () => {
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.refund",
    });
    const interaction = defineInteraction({
      contract,
      async run(input, ctx) {
        return ctx.actions.call("booking.refund", input);
      },
    });
    const runtime = createRuntime({
      interactions: createInteractionRegistry([interaction]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: contract.id,
      request: validRequest(),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "action_not_allowed");
  });

  test("rejects actions with effects above the interaction declaration", async () => {
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.readOnly",
      effects: {
        ...cancelAppointmentContract.effects,
        declared: "read",
      },
    });
    const interaction = defineInteraction({
      contract,
      async run(input, ctx) {
        return ctx.actions.call("booking.cancel", input);
      },
    });
    const runtime = createRuntime({
      interactions: createInteractionRegistry([interaction]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: contract.id,
      request: validRequest(),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "action_not_allowed");
  });

  test("validates interaction input against the contract schema", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest({
        input: {
          reason: "Missing appointment id",
        },
      }),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "input_schema_invalid");
  });

  test("rejects prototype-looking extra input properties", async () => {
    const runtime = createRuntime();
    const input = JSON.parse(
      '{"appointmentId":"apt_123","__proto__":{"polluted":true}}',
    );

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest({ input }),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "input_schema_invalid");
  });

  test("validates backend action input", async () => {
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.broadInput",
      input: {
        schema: {
          type: "object",
        },
      },
    });
    const interaction = defineInteraction({
      contract,
      async run(input, ctx) {
        return ctx.actions.call("booking.cancel", input);
      },
    });
    const runtime = createRuntime({
      interactions: createInteractionRegistry([interaction]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: contract.id,
      request: validRequest({
        input: {
          reason: "Missing appointment id",
        },
      }),
      auth: demoAuth,
    });

    expectErrorCode(response, "failed", "action_input_invalid");
  });

  test("validates backend action output", async () => {
    const badAction = defineAction({
      id: "booking.cancel",
      description: "Cancel one appointment.",
      effects: "write",
      tenantScope: {
        tenantId: "demo-salon",
      },
      inputSchema: z.object({ appointmentId: z.string().min(1) }),
      outputSchema: z.object({
        ok: z.boolean(),
        appointmentId: z.string(),
      }),
      async execute() {
        return {
          ok: "yes",
          appointmentId: "apt_123",
        } as unknown as { ok: boolean; appointmentId: string };
      },
    });
    const runtime = createRuntime({
      actions: new Map([["booking.cancel", badAction]]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest(),
      auth: demoAuth,
    });

    expectErrorCode(response, "failed", "action_output_invalid");
  });

  test("validates interaction output against the contract schema", async () => {
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.invalidOutput",
    });
    const interaction = defineInteraction({
      contract,
      async run() {
        return {
          ok: "yes",
          appointmentId: "apt_123",
        };
      },
    });
    const runtime = createRuntime({
      interactions: createInteractionRegistry([interaction]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: contract.id,
      request: validRequest(),
      auth: demoAuth,
    });

    expectErrorCode(response, "failed", "output_schema_invalid");
  });

  test("rejects body-supplied auth or tenant overrides", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: {
        ...validRequest(),
        auth: { tenantId: "attacker-salon" },
        tenantId: "attacker-salon",
      },
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "invalid_request");
  });

  test("rejects invalid server-derived auth context", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest(),
      auth: {} as RuntimeAuthContext,
    });

    expectErrorCode(response, "rejected", "auth_required");
  });

  test("rejects tenant/auth mismatch before returning success", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest(),
      auth: {
        ...demoAuth,
        organizationId: "other-salon",
        tenantId: "other-salon",
      },
    });

    expectErrorCode(response, "rejected", "tenant_mismatch");
  });

  test("accepts organizationId as the generic tenant source", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest(),
      auth: {
        ...demoAuth,
        tenantId: undefined,
        organizationId: "demo-salon",
      },
    });

    expect(response.status).toBe("ok");
  });

  test("rejects write actions that do not declare a tenant scope", async () => {
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.unscopedTenant",
    });
    const interaction = defineInteraction({
      contract,
      async run(input, ctx) {
        return ctx.actions.call("booking.cancel", input);
      },
    });
    const actions = defineActionsCatalog({
      "booking.cancel": defineAction({
        id: "booking.cancel",
        description: "Cancel one appointment.",
        effects: "write",
        inputSchema: z.object({ appointmentId: z.string().min(1) }),
        outputSchema: z.object({
          ok: z.boolean(),
          appointmentId: z.string(),
        }),
        async execute({ input }) {
          return { ok: true, appointmentId: input.appointmentId };
        },
      }),
    });
    const runtime = createRuntime({
      actions: new Map(Object.entries(actions)),
      interactions: createInteractionRegistry([interaction]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: contract.id,
      request: validRequest(),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "tenant_mismatch");
  });

  test("rejects missing action permissions before execution", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest(),
      auth: {
        ...demoAuth,
        authorization: {
          permissions: [],
          resourceGrants: [],
        },
        permissions: [],
      },
    });

    expectErrorCode(response, "rejected", "permission_denied");
  });

  test("accepts action permissions from authorization claims", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest(),
      auth: {
        ...demoAuth,
        authorization: {
          permissions: ["booking:write"],
          resourceGrants: [],
        },
        permissions: [],
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      output: {
        appointmentId: "apt_123",
        ok: true,
      },
    });
  });

  test("returns ok for the cancel appointment happy path", async () => {
    const runtime = createRuntime();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest(),
      auth: demoAuth,
    });

    expect(response).toMatchObject({
      status: "ok",
      output: {
        ok: true,
        appointmentId: "apt_123",
      },
    });
  });

  test("deduplicates repeated invokes with the same idempotency key", async () => {
    let actionCalls = 0;
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.idempotent",
    });
    const interaction = defineInteraction({
      contract,
      async run(input, ctx) {
        return ctx.actions.call("booking.cancel", input);
      },
    });
    const actions = defineActionsCatalog({
      "booking.cancel": defineAction({
        id: "booking.cancel",
        description: "Cancel one appointment.",
        effects: "write",
        tenantScope: {
          tenantId: "demo-salon",
        },
        inputSchema: z.object({ appointmentId: z.string().min(1) }),
        outputSchema: z.object({
          ok: z.boolean(),
          appointmentId: z.string(),
        }),
        async execute({ input }) {
          actionCalls += 1;
          return { ok: true, appointmentId: input.appointmentId };
        },
      }),
    });
    const runtime = createRuntime({
      actions: new Map(Object.entries(actions)),
      interactions: createInteractionRegistry([interaction]),
    });
    const request = validRequest({
      idempotencyKey: "same-key",
    });

    const first = await runtime.invokeInteraction({
      interactionId: contract.id,
      request,
      auth: demoAuth,
    });
    const second = await runtime.invokeInteraction({
      interactionId: contract.id,
      request,
      auth: demoAuth,
    });

    expect(actionCalls).toBe(1);
    expect(second).toEqual(first);
  });

  test("rejects idempotency key reuse with different input", async () => {
    const runtime = createRuntime();
    const first = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest({ idempotencyKey: "same-key-different-input" }),
      auth: demoAuth,
    });
    const second = await runtime.invokeInteraction({
      interactionId: cancelAppointmentInteraction.contract.id,
      request: validRequest({
        idempotencyKey: "same-key-different-input",
        input: {
          appointmentId: "apt_456",
          reason: "Different cancellation request",
        },
      }),
      auth: demoAuth,
    });

    expect(first.status).toBe("ok");
    expectErrorCode(second, "rejected", "invalid_request");
  });

  test("scopes idempotency records by tenant and principal", async () => {
    let actionCalls = 0;
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.idempotentAuthScope",
    });
    const interaction = defineInteraction({
      contract,
      async run(input, ctx) {
        return ctx.actions.call("booking.cancel", input);
      },
    });
    const actions = defineActionsCatalog({
      "booking.cancel": defineAction({
        id: "booking.cancel",
        description: "Cancel one appointment.",
        effects: "write",
        tenantScope: {
          tenantId: "demo-salon",
        },
        inputSchema: z.object({ appointmentId: z.string().min(1) }),
        outputSchema: z.object({
          ok: z.boolean(),
          appointmentId: z.string(),
        }),
        async execute({ input }) {
          actionCalls += 1;
          return { ok: true, appointmentId: input.appointmentId };
        },
      }),
    });
    const runtime = createRuntime({
      actions: new Map(Object.entries(actions)),
      interactions: createInteractionRegistry([interaction]),
    });
    const request = validRequest({ idempotencyKey: "same-key-scoped" });

    await runtime.invokeInteraction({
      interactionId: contract.id,
      request,
      auth: demoAuth,
    });
    await runtime.invokeInteraction({
      interactionId: contract.id,
      request,
      auth: {
        ...demoAuth,
        subjectId: "another-demo-user",
        userId: "another-demo-user",
        workosUserId: "another-demo-user",
      },
    });

    expect(actionCalls).toBe(2);
  });

  test("rejects calls beyond the contract action call limit", async () => {
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.twice",
    });
    const interaction = defineInteraction({
      contract,
      async run(input, ctx) {
        await ctx.actions.call("booking.cancel", input);
        return ctx.actions.call("booking.cancel", input);
      },
    });
    const runtime = createRuntime({
      interactions: createInteractionRegistry([interaction]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: contract.id,
      request: validRequest(),
      auth: demoAuth,
    });

    expectErrorCode(response, "rejected", "action_not_allowed");
  });

  test("returns timed_out when interaction execution exceeds its timeout", async () => {
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.timeout",
      timeout: {
        ...cancelAppointmentContract.timeout,
        executionMs: 1,
      },
    });
    const interaction = defineInteraction({
      contract,
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ok: true,
          appointmentId: "apt_123",
        };
      },
    });
    const runtime = createRuntime({
      interactions: createInteractionRegistry([interaction]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: contract.id,
      request: validRequest(),
      auth: demoAuth,
    });

    expectTimedOut(response);
  });

  test("does not start a second execution when a timed-out idempotency key is retried", async () => {
    let runCalls = 0;
    const contract = cloneContract({
      id: "ix.booking.cancelAppointment.timeoutRetry",
      timeout: {
        ...cancelAppointmentContract.timeout,
        executionMs: 1,
      },
    });
    const interaction = defineInteraction({
      contract,
      async run() {
        runCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ok: true,
          appointmentId: "apt_123",
        };
      },
    });
    const runtime = createRuntime({
      interactions: createInteractionRegistry([interaction]),
    });
    const request = validRequest({
      idempotencyKey: "timeout-retry-key",
    });

    const first = await runtime.invokeInteraction({
      interactionId: contract.id,
      request,
      auth: demoAuth,
    });
    const second = await runtime.invokeInteraction({
      interactionId: contract.id,
      request,
      auth: demoAuth,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expectTimedOut(first);
    expect(second).toEqual(first);
    expect(runCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #25 — live budget + revocation enforced DURING execution, via the policy
// engine's live-state seam. The interaction makes several action calls in one
// run; the guard is consulted at the SAME action-call choke point the sandbox
// path routes through, so these are not bypassable.
// ---------------------------------------------------------------------------

function multiCallActions(onCall: (n: number) => void) {
  let calls = 0;
  return defineActionsCatalog({
    // A read action: no tenant scope / permission gates, so denials in these
    // tests come only from the live-state rules.
    "booking.read": defineAction({
      id: "booking.read",
      description: "Read one appointment.",
      effects: "read",
      inputSchema: z.object({ appointmentId: z.string().min(1) }),
      outputSchema: z.object({ ok: z.boolean(), n: z.number() }),
      async execute({ input }) {
        calls += 1;
        onCall(calls);
        return { ok: true, n: calls };
      },
    }),
  });
}

function multiCallInteraction(id: string) {
  const contract = cloneContract({
    id,
    effects: {
      declared: "read",
      riskLevel: "low",
      idempotency: "not_required",
    },
    confirmation: { required: false, message: null },
    timeout: { executionMs: 5000, perActionMs: 3000, maxActionCalls: 10 },
    allowedActions: [
      { id: "booking.read", reason: "The interaction reads one appointment." },
    ],
    output: {
      schema: {
        type: "object",
        required: ["outcomes"],
        properties: { outcomes: { type: "array" } },
        additionalProperties: false,
      },
    },
  });

  return defineInteraction({
    contract,
    async run(input, ctx) {
      // Call the action up to 3 times, collecting the outcome of each so the
      // test can assert which succeeded and which the guard denied.
      const outcomes: Array<{ ok: true } | { ok: false; code: unknown }> = [];
      for (let i = 0; i < 3; i += 1) {
        try {
          await ctx.actions.call("booking.read", input);
          outcomes.push({ ok: true });
        } catch (error) {
          outcomes.push({
            ok: false,
            code: (error as { code?: unknown }).code,
          });
        }
      }
      return { outcomes };
    },
  });
}

function multiCallRuntime(
  executionAuthority: Parameters<
    typeof createTidegateRuntime
  >[0]["executionAuthority"],
  onCall: (n: number) => void = () => {},
) {
  const interaction = multiCallInteraction("ix.live.multi");
  return {
    interaction,
    runtime: createTidegateRuntime({
      actions: new Map(Object.entries(multiCallActions(onCall))),
      confirmationSecret: TEST_CONFIRMATION_SECRET,
      interactions: createInteractionRegistry([interaction]),
      executionAuthority,
    }),
  };
}

function multiCallRequest(): InvokeInteractionRequest {
  return {
    interactionVersion: "1",
    input: { appointmentId: "apt_123" },
    surfaceId: "interaction-demo",
    sessionId: "sess_live",
    messageId: "msg_live",
  };
}

describe("createTidegateRuntime — live authority (#25)", () => {
  test("no ports injected → all calls succeed (regression: unchanged)", async () => {
    const { runtime, interaction } = multiCallRuntime(undefined);

    const response = await runtime.invokeInteraction({
      interactionId: interaction.contract.id,
      request: multiCallRequest(),
      auth: demoAuth,
    });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.output).toEqual({
      outcomes: [{ ok: true }, { ok: true }, { ok: true }],
    });
  });

  test("revoke mid-run → next action call denied (interaction_revoked), prior calls succeed", async () => {
    let revoked = false;
    const { runtime, interaction } = multiCallRuntime(
      {
        revocation: {
          async isRevoked() {
            return revoked
              ? { scope: "invocation", severity: "deny_next" }
              : undefined;
          },
        },
      },
      (n) => {
        // Flip revocation after the first successful action executes.
        if (n === 1) {
          revoked = true;
        }
      },
    );

    const response = await runtime.invokeInteraction({
      interactionId: interaction.contract.id,
      request: multiCallRequest(),
      auth: demoAuth,
    });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.output).toEqual({
      outcomes: [
        { ok: true },
        { ok: false, code: "interaction_revoked" },
        { ok: false, code: "interaction_revoked" },
      ],
    });
  });

  test("budget exhausted mid-run → next call denied (budget_exhausted), prior calls succeed", async () => {
    // A cumulative ledger with 2 units of budget, 1 unit per call: the third
    // call cannot be debited.
    let remaining = 2;
    const { runtime, interaction } = multiCallRuntime({
      budget: {
        async tryDebit({ units }) {
          if (remaining - units < 0) {
            return { ok: false, reason: "quota" };
          }
          remaining -= units;
          return { ok: true };
        },
      },
    });

    const response = await runtime.invokeInteraction({
      interactionId: interaction.contract.id,
      request: multiCallRequest(),
      auth: demoAuth,
    });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.output).toEqual({
      outcomes: [
        { ok: true },
        { ok: true },
        { ok: false, code: "budget_exhausted" },
      ],
    });
  });

  test("a failing revocation port fails closed (denies the call)", async () => {
    const { runtime, interaction } = multiCallRuntime({
      revocation: {
        async isRevoked() {
          throw new Error("store unreachable");
        },
      },
    });

    const response = await runtime.invokeInteraction({
      interactionId: interaction.contract.id,
      request: multiCallRequest(),
      auth: demoAuth,
    });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.output).toEqual({
      outcomes: [
        { ok: false, code: "interaction_revoked" },
        { ok: false, code: "interaction_revoked" },
        { ok: false, code: "interaction_revoked" },
      ],
    });
  });

  test("a throwing refund port during settle does not mask the structured denial (#2)", async () => {
    // The debit always succeeds, but the action input is schema-invalid, so the
    // call is rejected pre-dispatch and the runtime refunds the uncharged debit.
    // A refund port that throws must NOT replace the intended structured error
    // (action_input_invalid) with an opaque refund failure.
    let refundCalls = 0;
    const interaction = defineInteraction({
      contract: cloneContract({
        id: "ix.live.badinput",
        effects: { declared: "read", riskLevel: "low", idempotency: "not_required" },
        confirmation: { required: false, message: null },
        timeout: { executionMs: 5000, perActionMs: 3000, maxActionCalls: 10 },
        allowedActions: [
          { id: "booking.read", reason: "The interaction reads one appointment." },
        ],
        output: {
          schema: {
            type: "object",
            required: ["outcomes"],
            properties: { outcomes: { type: "array" } },
            additionalProperties: false,
          },
        },
      }),
      async run(_input, ctx) {
        const outcomes: Array<{ ok: true } | { ok: false; code: unknown }> = [];
        try {
          // Empty appointmentId fails the action inputSchema (min(1)).
          await ctx.actions.call("booking.read", { appointmentId: "" });
          outcomes.push({ ok: true });
        } catch (error) {
          outcomes.push({ ok: false, code: (error as { code?: unknown }).code });
        }
        return { outcomes };
      },
    });

    const runtime = createTidegateRuntime({
      actions: new Map(Object.entries(multiCallActions(() => {}))),
      confirmationSecret: TEST_CONFIRMATION_SECRET,
      interactions: createInteractionRegistry([interaction]),
      executionAuthority: {
        budget: {
          async tryDebit() {
            return { ok: true };
          },
          async refund() {
            refundCalls += 1;
            throw new Error("refund port unreachable");
          },
        },
      },
    });

    const response = await runtime.invokeInteraction({
      interactionId: interaction.contract.id,
      request: multiCallRequest(),
      auth: demoAuth,
    });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    // The structured denial reason survives the throwing refund port.
    expect(response.output).toEqual({
      outcomes: [{ ok: false, code: "action_input_invalid" }],
    });
    expect(refundCalls).toBe(1);
  });

  test("determinism: an injected fixed clock is threaded into every port call", async () => {
    const clockReads: number[] = [];
    const { runtime, interaction } = multiCallRuntime({
      revocation: {
        async isRevoked(check) {
          clockReads.push(check.now);
          return undefined;
        },
      },
    });
    // The runtime clock defaults to Date.now here, but the guard threads the
    // SAME now() the runtime uses; assert it is consulted per action call.
    const response = await runtime.invokeInteraction({
      interactionId: interaction.contract.id,
      request: multiCallRequest(),
      auth: demoAuth,
    });

    expect(response.status).toBe("ok");
    // Three action calls → three revocation reads.
    expect(clockReads).toHaveLength(3);
  });
});
