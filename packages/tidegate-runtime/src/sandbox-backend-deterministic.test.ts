import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  PublishedInteractionArtifactSchema,
  type PublishedInteractionArtifact,
} from "@tidegate/contracts";
import { cancelAppointmentPublishedArtifact } from "@tidegate/contracts/fixtures";
import {
  defineAction,
  defineActionsCatalog,
  type AnyRuntimeAction,
  type RuntimeAuthContext,
} from "./action-catalog";
import { createTidegateRuntime } from "./runtime";
import {
  createExecutionTraceRecorder,
  createInMemoryExecutionTraceStore,
} from "./execution-tracing";
import {
  createPublishedInteractionActionCallToken,
  createPublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionPayload,
  type PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor";
import {
  createDeterministicExecutionTraceClock,
  createDeterministicIdFactory,
  createDeterministicSandboxBackend,
  DETERMINISTIC_SANDBOX_CODE_GENERATION,
  InMemorySandboxWorkspace,
} from "./sandbox-backend-deterministic";
import { createSandboxedPublishedInteractionExecutor } from "./sandbox-executor";

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

function artifactWithSource(
  source: string,
  overrides: Partial<PublishedInteractionArtifact> = {},
): PublishedInteractionArtifact {
  return PublishedInteractionArtifactSchema.parse({
    ...structuredClone(cancelAppointmentPublishedArtifact),
    source,
    ...overrides,
  });
}

function createPayload({
  artifact,
  invocationId = "invoke_deterministic",
}: {
  artifact: PublishedInteractionArtifact;
  invocationId?: string;
}): PublishedInteractionExecutionPayload {
  return createPublishedInteractionExecutionPayload({
    actionCallToken: createPublishedInteractionActionCallToken(invocationId),
    artifact,
    auth,
    input: {
      appointmentId: "apt_123",
      reason: "Client requested cancellation",
    },
    invocationId,
  });
}

const echoRuntime: PublishedInteractionTrustedRuntime = {
  async callAction(request) {
    return {
      ok: true,
      appointmentId: (request.input as { appointmentId: string }).appointmentId,
    };
  },
};

function createBookingActions(): Map<string, AnyRuntimeAction> {
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
        return { ok: true, appointmentId: args.input.appointmentId };
      },
    }),
  });

  return new Map(Object.entries(catalog));
}

function createRuntimeWithDeterministicSandbox({
  artifact = PublishedInteractionArtifactSchema.parse(
    structuredClone(cancelAppointmentPublishedArtifact),
  ),
}: { artifact?: PublishedInteractionArtifact } = {}) {
  return createTidegateRuntime({
    actions: createBookingActions(),
    interactions: new Map(),
    publishedInteractionExecutor: createSandboxedPublishedInteractionExecutor({
      backend: createDeterministicSandboxBackend(),
    }),
    publishedInteractions: new Map([[artifact.id, artifact]]),
  });
}

function invokeRequest(idempotencyKey: string) {
  return {
    interactionVersion: "1",
    input: {
      appointmentId: "apt_123",
      reason: "Client requested cancellation",
    },
    surfaceId: "deterministic-sandbox-test",
    sessionId: "sess_deterministic",
    messageId: "msg_deterministic",
    idempotencyKey,
  };
}

describe("deterministic sandbox backend", () => {
  test("executes the fixture interaction hermetically (no subprocess)", async () => {
    const executor = createSandboxedPublishedInteractionExecutor({
      backend: createDeterministicSandboxBackend(),
    });
    const payload = createPayload({
      artifact: PublishedInteractionArtifactSchema.parse(
        structuredClone(cancelAppointmentPublishedArtifact),
      ),
    });

    const result = await executor.execute(payload, echoRuntime);

    expect(result).toEqual({
      status: "ok",
      output: { ok: true, appointmentId: "apt_123" },
    });
  });

  test("resolves concurrent capability calls strictly in issue order (FIFO)", async () => {
    const events: string[] = [];
    const runtime: PublishedInteractionTrustedRuntime = {
      async callAction(request) {
        const input = request.input as { appointmentId: string };
        events.push(`start:${input.appointmentId}`);
        if (input.appointmentId === "apt_A") {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        events.push(`end:${input.appointmentId}`);
        return { ok: true, appointmentId: input.appointmentId };
      },
    };
    const artifact = artifactWithSource(
      `
export default async function run(input, ctx) {
  const first = ctx.capabilities.booking.cancel({ appointmentId: "apt_A" });
  const second = ctx.capabilities.booking.cancel({ appointmentId: "apt_B" });
  const results = await Promise.all([first, second]);

  return { ok: true, appointmentId: results.map((r) => r.appointmentId).join(",") };
}
`.trim(),
      {
        timeout: {
          ...cancelAppointmentPublishedArtifact.timeout,
          maxActionCalls: 2,
        },
      },
    );
    const executor = createSandboxedPublishedInteractionExecutor({
      backend: createDeterministicSandboxBackend(),
    });

    const result = await executor.execute(
      createPayload({ artifact }),
      runtime,
    );

    expect(result).toMatchObject({
      status: "ok",
      output: { appointmentId: "apt_A,apt_B" },
    });
    // The slow first call still fully settles before the second starts.
    expect(events).toEqual([
      "start:apt_A",
      "end:apt_A",
      "start:apt_B",
      "end:apt_B",
    ]);
  });

  test("realm blocks code generation from strings like the local backend", async () => {
    expect(DETERMINISTIC_SANDBOX_CODE_GENERATION).toEqual({
      strings: false,
      wasm: false,
    });

    const artifact = artifactWithSource(
      String.raw`
export default async function run() {
  return setTimeout.constr\u0075ctor("return 1")();
}
`.trim(),
    );
    const executor = createSandboxedPublishedInteractionExecutor({
      backend: createDeterministicSandboxBackend(),
    });

    const result = await executor.execute(createPayload({ artifact }), {
      async callAction() {
        throw new Error("No action call expected.");
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "interaction_failed" },
    });
  });

  test("strips host globals at module top-level and at runtime", async () => {
    // fetch / process / Bun are lexically banned by the source policy, so a
    // strip probe has to reach the runtime via unicode-escaped identifiers
    // (exactly what hostile generated code would try).
    const artifact = artifactWithSource(
      String.raw`
const topLevel = [
  typeof f\u0065tch,
  typeof pro\u0063ess,
  typeof eval,
  typeof Function,
  typeof B\u0075n,
  typeof Buffer,
  typeof require,
].join(" ");

export default async function run() {
  const atRuntime = [
    typeof f\u0065tch,
    typeof pro\u0063ess,
    typeof eval,
    typeof Function,
    typeof B\u0075n,
    typeof Buffer,
    typeof require,
  ].join(" ");

  return { ok: true, appointmentId: topLevel + "|" + atRuntime };
}
`.trim(),
    );
    const executor = createSandboxedPublishedInteractionExecutor({
      backend: createDeterministicSandboxBackend(),
    });

    const result = await executor.execute(createPayload({ artifact }), {
      async callAction() {
        throw new Error("No action call expected.");
      },
    });

    const stripped = Array(7).fill("undefined").join(" ");
    expect(result).toEqual({
      status: "ok",
      output: { ok: true, appointmentId: `${stripped}|${stripped}` },
    });
  });

  test("normalizes timeouts of never-settling interactions", async () => {
    const artifact = artifactWithSource(
      `
export default async function run() {
  await new Promise(() => {});

  return { ok: true, appointmentId: "apt_never" };
}
`.trim(),
      {
        timeout: {
          ...cancelAppointmentPublishedArtifact.timeout,
          executionMs: 20,
        },
      },
    );
    const executor = createSandboxedPublishedInteractionExecutor({
      backend: createDeterministicSandboxBackend(),
    });

    const result = await executor.execute(createPayload({ artifact }), {
      async callAction() {
        throw new Error("No action call expected.");
      },
    });

    expect(result).toMatchObject({
      status: "timed_out",
      error: { code: "interaction_timeout" },
    });
  });

  test("in-memory workspace enforces the orchestrator write order", async () => {
    const workspace = new InMemorySandboxWorkspace();

    await expect(
      workspace.writeTextFile({ path: "tidegate-runner.mjs", content: "" }),
    ).rejects.toThrow(/expected write #1/);

    await workspace.writeTextFile({
      path: "interaction.generated.mjs",
      content: "export default async function run() {}",
    });
    await expect(
      workspace.writeTextFile({ path: "unexpected.txt", content: "" }),
    ).rejects.toThrow(/expected write #2/);
  });

  test("in-memory workspace rejects path traversal", async () => {
    const workspace = new InMemorySandboxWorkspace();

    await expect(
      workspace.writeTextFile({ path: "../escape.mjs", content: "" }),
    ).rejects.toThrow(/stay inside the workspace/);
    await expect(
      workspace.writeTextFile({ path: "/etc/passwd", content: "" }),
    ).rejects.toThrow(/stay inside the workspace/);
  });

  test("a withheld capability is injected as a denied stub in a real sandbox execution", async () => {
    // #28 invariant (d), end to end: a caller without booking:write still
    // gets the booking.cancel capability injected (generated code resolves
    // ctx.capabilities.booking.cancel), and awaiting it rejects with the
    // structured permission_denied — never a missing-property
    // interaction_failed.
    const runtime = createRuntimeWithDeterministicSandbox();

    const response = await runtime.invokeInteraction({
      interactionId: cancelAppointmentPublishedArtifact.id,
      request: invokeRequest("empty-set-denied-call"),
      auth: {
        ...auth,
        permissions: [],
        authorization: { permissions: [], resourceGrants: [] },
      },
    });

    expect(response).toMatchObject({
      status: "rejected",
      error: { code: "permission_denied" },
    });
  });

  test("an empty effective set executes normally when the sandbox calls nothing", async () => {
    // #28 invariant (e), end to end: every declared action is withheld for
    // this caller, and an interaction that never calls a capability still
    // completes ok.
    const artifact = artifactWithSource(
      `
export default async function run(input, ctx) {
  const injected = typeof ctx.capabilities.booking.cancel;

  return { ok: injected === "function", appointmentId: input.appointmentId };
}
`.trim(),
    );
    const runtime = createRuntimeWithDeterministicSandbox({ artifact });

    const response = await runtime.invokeInteraction({
      interactionId: artifact.id,
      request: invokeRequest("empty-set-no-calls"),
      auth: {
        ...auth,
        permissions: [],
        authorization: { permissions: [], resourceGrants: [] },
      },
    });

    // `ok: true` also proves the withheld capability was still injected as
    // a callable stub (typeof === "function") rather than dropped.
    expect(response).toMatchObject({
      status: "ok",
      output: { ok: true, appointmentId: "apt_123" },
    });
  });

  test("produces byte-identical trace snapshots across runs under an injected clock", async () => {
    const runOnce = async () => {
      const store = createInMemoryExecutionTraceStore();
      const recorder = createExecutionTraceRecorder({
        clock: createDeterministicExecutionTraceClock(),
        idFactory: createDeterministicIdFactory(),
        store,
      });
      const executor = createSandboxedPublishedInteractionExecutor({
        backend: createDeterministicSandboxBackend(),
        tracing: { recorder },
      });
      const payload = createPayload({
        artifact: PublishedInteractionArtifactSchema.parse(
          structuredClone(cancelAppointmentPublishedArtifact),
        ),
      });

      const result = await executor.execute(payload, echoRuntime);
      expect(result.status).toBe("ok");

      const traces = await store.listTraces({ ownerId: "demo-salon" });
      return store.getTrace({
        ownerId: "demo-salon",
        traceId: traces[0]!.id,
      });
    };

    const first = await runOnce();
    const second = await runOnce();

    expect(first).toBeDefined();
    expect(JSON.stringify(first, null, 2)).toBe(
      JSON.stringify(second, null, 2),
    );
    expect(first!.spans.map((span) => span.name)).toEqual([
      "sandbox.allocate",
      "sandbox.prepare",
      "sandbox.run",
    ]);
  });
});
