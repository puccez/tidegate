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
import {
  createPublishedInteractionActionCallToken,
  createPublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionPayload,
  type PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor";
import { createTidegateRuntime } from "./runtime";
import {
  createSandboxedPublishedInteractionExecutor,
  type PublishedInteractionSandboxProvider,
  type PublishedInteractionSandboxProviderExecuteRequest,
  type PublishedInteractionSandboxWorkspace,
  type PublishedInteractionSandboxWorkspaceFactory,
} from "./sandbox-executor";

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
    surfaceId: "sandbox-executor-test",
    sessionId: "sess_sandbox_executor",
    messageId: "msg_sandbox_executor",
    idempotencyKey: "ix.booking.cancelAppointment:sess_sandbox:apt_123",
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

function artifactWithSource(
  source: string,
  overrides: Partial<PublishedInteractionArtifact> = {},
): PublishedInteractionArtifact {
  return cloneArtifact({
    source,
    ...overrides,
  });
}

function createPayload({
  artifact = cloneArtifact(),
  input = validRequest().input,
  invocationId = "invoke_sandbox_executor",
}: {
  artifact?: PublishedInteractionArtifact;
  input?: unknown;
  invocationId?: string;
} = {}): PublishedInteractionExecutionPayload {
  return createPublishedInteractionExecutionPayload({
    actionCallToken: createPublishedInteractionActionCallToken(invocationId),
    artifact,
    auth,
    input,
    invocationId,
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
}: {
  actions?: Map<string, AnyRuntimeAction>;
  artifact?: PublishedInteractionArtifact;
} = {}) {
  return createTidegateRuntime({
    actions,
    interactions: new Map(),
    publishedInteractionExecutor: createSandboxedPublishedInteractionExecutor(),
    publishedInteractions: new Map([[artifact.id, artifact]]),
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

class RecordingWorkspace implements PublishedInteractionSandboxWorkspace {
  readonly rootPath = "/tmp/tidegate-recording-workspace";
  readonly writes: Array<{ path: string; content: string }> = [];
  cleaned = false;

  writeTextFile(args: { path: string; content: string }) {
    this.writes.push(args);
  }

  async cleanup() {
    this.cleaned = true;
  }
}

describe("SandboxedPublishedInteractionExecutor", () => {
  test("writes immutable artifact source, generated capabilities, and runner into the workspace", async () => {
    const workspace = new RecordingWorkspace();
    let providerRequest:
      | PublishedInteractionSandboxProviderExecuteRequest
      | undefined;
    const workspaceFactory: PublishedInteractionSandboxWorkspaceFactory = {
      async createWorkspace() {
        return workspace;
      },
    };
    const provider: PublishedInteractionSandboxProvider = {
      async execute(request) {
        providerRequest = request;

        return {
          status: "ok",
          output: {
            ok: true,
            appointmentId: "apt_123",
          },
        };
      },
    };
    const executor = createSandboxedPublishedInteractionExecutor({
      provider,
      workspaceFactory,
    });
    const payload = createPayload();

    const result = await executor.execute(payload, {
      async callAction() {
        throw new Error("The recording provider should not call actions.");
      },
    });

    expect(result.status).toBe("ok");
    expect(providerRequest?.runnerPath).toBe("tidegate-runner.mjs");
    expect(workspace.cleaned).toBe(true);
    expect(workspace.writes.map((write) => write.path)).toEqual([
      "interaction.generated.mjs",
      "tidegate-capabilities.generated.ts",
      "tidegate-runner.mjs",
    ]);
    expect(workspace.writes[0]?.content).toContain(
      "export default async function run",
    );
    expect(workspace.writes[1]?.content).toContain(
      "withTidegateCapabilities",
    );
    expect(workspace.writes[1]?.content).toContain(
      "cancel: (input) => actions.call(\"booking.cancel\", input)",
    );
    expect(workspace.writes[2]?.content).toContain(
      'await import("./interaction.generated.mjs")',
    );
  });

  test("runs a generated cancel artifact through ctx.capabilities with the one-invocation callback token", async () => {
    const executor = createSandboxedPublishedInteractionExecutor();
    const payload = createPayload();
    const calls: Array<
      Parameters<PublishedInteractionTrustedRuntime["callAction"]>[0]
    > = [];
    const runtime: PublishedInteractionTrustedRuntime = {
      async callAction(request) {
        calls.push(request);
        expect(request.invocationId).toBe(payload.invocationId);
        expect(request.actionCallToken).toBe(payload.actionCallToken);

        return {
          ok: true,
          appointmentId: (request.input as { appointmentId: string })
            .appointmentId,
        };
      },
    };

    const result = await executor.execute(payload, runtime);

    expect(result).toMatchObject({
      status: "ok",
      output: {
        ok: true,
        appointmentId: "apt_123",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actionId: "booking.cancel",
      invocationId: payload.invocationId,
      actionCallToken: payload.actionCallToken,
      input: {
        appointmentId: "apt_123",
        reason: "Client requested cancellation",
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain("bridge-secret-ref");
  });

  test("does not expose bridge secrets or backend endpoints to generated context", async () => {
    const executor = createSandboxedPublishedInteractionExecutor();
    const artifact = artifactWithSource(`
export default async function run(input, ctx) {
  const visible = JSON.stringify(ctx);

  return {
    ok: true,
    appointmentId: String(
      visible.includes("bridge-secret-ref") ||
      visible.includes("customer.example.test")
    ),
  };
}
`.trim());
    const payload = createPayload({ artifact });

    const result = await executor.execute(payload, {
      async callAction() {
        throw new Error("No action call expected.");
      },
    });

    expect(result).toMatchObject({
      status: "ok",
      output: {
        ok: true,
        appointmentId: "false",
      },
    });
  });

  test("transpiles type-only generated source before execution", async () => {
    const executor = createSandboxedPublishedInteractionExecutor();
    const artifact = artifactWithSource(`
import type { TidegateGeneratedInteractionContext } from "./tidegate-capabilities.generated";

export default async function run(
  input: { appointmentId: string; reason?: string },
  ctx: TidegateGeneratedInteractionContext,
) {
  const cancelled = await ctx.capabilities.booking.cancel(input);

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim());
    const payload = createPayload({ artifact });

    const result = await executor.execute(payload, {
      async callAction(request) {
        return {
          ok: true,
          appointmentId: (request.input as { appointmentId: string })
            .appointmentId,
        };
      },
    });

    expect(result).toMatchObject({
      status: "ok",
      output: {
        ok: true,
        appointmentId: "apt_123",
      },
    });
  });

  test("does not reject TypeScript array type annotations as computed property access", async () => {
    const executor = createSandboxedPublishedInteractionExecutor();
    const artifact = artifactWithSource(`
type Todo = {
  id: string;
  title: string;
};

type Output = {
  todos?: Todo[];
};

export default async function run(
  input: { appointmentId: string; reason?: string },
  ctx,
) {
  const output: Output = { todos: [] };
  void output;
  const cancelled = await ctx.capabilities.booking.cancel(input);

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim());
    const payload = createPayload({ artifact });

    const result = await executor.execute(payload, {
      async callAction(request) {
        return {
          ok: true,
          appointmentId: (request.input as { appointmentId: string })
            .appointmentId,
        };
      },
    });

    expect(result).toMatchObject({
      status: "ok",
      output: {
        ok: true,
        appointmentId: "apt_123",
      },
    });
  });

  test("rejects arbitrary imports, filesystem access, process/env, globals, and direct network calls", async () => {
    const executor = createSandboxedPublishedInteractionExecutor();
    const scenarios = [
      {
        name: "imports",
        source: `
import { readFileSync } from "node:fs";
export default async function run() {
  return readFileSync("/etc/passwd", "utf8");
}
`.trim(),
      },
      {
        name: "data module re-export",
        source: `
export { default } from "data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gcnVuKCkgeyByZXR1cm4geyBvazogdHJ1ZSwgYXBwb2ludG1lbnRJZDogImFwdF9lc2NhcGUiIH07IH0=";
`.trim(),
      },
      {
        name: "commented dynamic import",
        source: `
export default async function run() {
  return import/* hide from textual scanners */("data:text/javascript,export default 1");
}
`.trim(),
      },
      {
        name: "filesystem",
        source: `
export default async function run() {
  return Bun.file("/etc/passwd").text();
}
`.trim(),
      },
      {
        name: "process env",
        source: `
export default async function run() {
  return process.env.TIDEGATE_ACTION_BRIDGE_SECRET;
}
`.trim(),
      },
      {
        name: "globals",
        source: `
export default async function run() {
  return globalThis.process;
}
`.trim(),
      },
      {
        name: "network",
        source: `
export default async function run() {
  return fetch("https://customer.example.test/tidegate/actions");
}
`.trim(),
      },
      {
        name: "dynamic evaluation",
        source: `
export default async function run() {
  return Function("return process")();
}
`.trim(),
      },
      {
        name: "split-string host escape",
        source: `
export default async function run() {
  const g = (async () => {})["con" + "structor"]("return glob" + "alThis")();

  return g["B" + "un"].file("/etc/hostname").text();
}
`.trim(),
      },
      {
        name: "raw action caller",
        source: `
export default async function run(input, ctx) {
  return ctx.actions.call("booking.cancel", input);
}
`.trim(),
      },
      {
        name: "raw action caller alias",
        source: `
export default async function run(input, ctx) {
  const actions = ctx.actions;

  return actions.call("booking.cancel", input);
}
`.trim(),
      },
    ];

    for (const scenario of scenarios) {
      const payload = createPayload({
        artifact: artifactWithSource(scenario.source, {
          id: `ix.booking.cancelAppointment.${scenario.name.replaceAll(" ", "-")}`,
        }),
      });
      const result = await executor.execute(payload, {
        async callAction() {
          throw new Error(`No action call expected for ${scenario.name}.`);
        },
      });

      expect(result.status).toBe("rejected");

      if (result.status !== "rejected") {
        throw new Error(`Expected ${scenario.name} to be rejected.`);
      }

      expect(result.error.code).toBe("action_not_allowed");
    }
  });

  test("fails closed when escaped constructors attempt string code generation", async () => {
    const executor = createSandboxedPublishedInteractionExecutor();
    const artifact = artifactWithSource(String.raw`
export default async function run() {
  return setTimeout.constr\u0075ctor("return 1")();
}
`.trim());
    const payload = createPayload({ artifact });

    const result = await executor.execute(payload, {
      async callAction() {
        throw new Error("No action call expected.");
      },
    });

    expect(result.status).toBe("failed");

    if (result.status !== "failed") {
      throw new Error("Expected escaped constructor code generation to fail.");
    }

    expect(result.error.code).toBe("interaction_failed");
  });

  test("fails closed for artifact references instead of mutable authoring files", async () => {
    const executor = createSandboxedPublishedInteractionExecutor();
    const artifact = cloneArtifact();
    const payload = createPublishedInteractionExecutionPayload({
      actionCallToken: createPublishedInteractionActionCallToken(
        "invoke_artifact_reference",
      ),
      artifact,
      artifactSource: {
        kind: "artifact_reference",
        id: artifact.id,
        version: artifact.version,
        sourceHash: artifact.sourceHash,
        actionCatalogId: artifact.actionCatalogId,
        actionCatalogVersion: artifact.actionCatalogVersion,
      },
      auth,
      input: validRequest().input,
      invocationId: "invoke_artifact_reference",
    });

    const result = await executor.execute(payload, {
      async callAction() {
        throw new Error("No action call expected.");
      },
    });

    expect(result.status).toBe("rejected");

    if (result.status !== "rejected") {
      throw new Error("Expected artifact_reference to be rejected.");
    }

    expect(result.error.code).toBe("interaction_unavailable");
  });

  test("runtime validates sandbox output after execution", async () => {
    const artifact = artifactWithSource(`
export default async function run(input) {
  return {
    ok: "yes",
    appointmentId: input.appointmentId,
  };
}
`.trim());
    const runtime = createRuntime({ artifact });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest({
        idempotencyKey: "sandbox-output-validation",
      }),
      auth,
    });

    expectErrorCode(response, "failed", "output_schema_invalid");
  });

  test("runtime enforces max action call budget for sandbox capability calls", async () => {
    const { actions, getActionCalls } = createBookingActions();
    const artifact = artifactWithSource(`
export default async function run(input, ctx) {
  await ctx.capabilities.booking.cancel(input);

  return ctx.capabilities.booking.cancel(input);
}
`.trim());
    const runtime = createRuntime({ actions, artifact });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest({
        idempotencyKey: "sandbox-max-action-calls",
      }),
      auth,
    });

    expectErrorCode(response, "rejected", "action_not_allowed");
    expect(getActionCalls()).toBe(1);
  });

  test("runtime enforces per-action timeouts for sandbox capability calls", async () => {
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
    const runtime = createRuntime({ actions, artifact });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest({
        idempotencyKey: "sandbox-per-action-timeout",
      }),
      auth,
    });

    expectTimedOut(response);
    expect(getActionCalls()).toBe(1);
  });

  test("execution timeouts become typed invoke responses", async () => {
    const artifact = artifactWithSource(
      `
export default async function run() {
  await new Promise((resolve) => setTimeout(resolve, 100));

  return {
    ok: true,
    appointmentId: "apt_123",
  };
}
`.trim(),
      {
        timeout: {
          ...cancelAppointmentPublishedArtifact.timeout,
          executionMs: 10,
        },
      },
    );
    const runtime = createRuntime({ artifact });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest({
        idempotencyKey: "sandbox-execution-timeout",
      }),
      auth,
    });

    expectTimedOut(response);
  });

  test("thrown sandbox errors become typed invoke responses", async () => {
    const artifact = artifactWithSource(`
export default async function run() {
  throw new Error("boom");
}
`.trim());
    const runtime = createRuntime({ artifact });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: validRequest({
        idempotencyKey: "sandbox-thrown-error",
      }),
      auth,
    });

    expectErrorCode(response, "failed", "interaction_failed");
  });
});
