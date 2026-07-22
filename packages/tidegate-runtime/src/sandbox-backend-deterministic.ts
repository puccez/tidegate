/**
 * Deterministic in-process sandbox backend — TEST-ONLY.
 *
 * Runs the shared runner core (`runInteraction` from
 * `sandbox-runner-core.ts`) directly in-process: no subprocess, no PATH
 * dependency, no wall-clock races. The generated interaction module is
 * evaluated inside a `node:vm` realm with
 * `codeGeneration: { strings: false, wasm: false }` (matching the local
 * backend's `--disallow-code-generation-from-strings`) and the same
 * `hardenSandboxGlobals` strip applied to the realm global. Action calls
 * resolve strictly in issue order (FIFO) for reproducible interleavings, and
 * all values crossing the seam are JSON-round-tripped exactly like the
 * NDJSON transport would.
 *
 * SECURITY: a `node:vm` realm in the host process is NOT an isolation
 * boundary. This backend must never execute a real user interaction in
 * production; the app-side backend selection resolver refuses to select it
 * there.
 */
import vm from "node:vm";
import ts from "typescript";
import type { ExecutionTraceClock } from "./execution-tracing.ts";
import type { PublishedInteractionExecutionResult } from "./published-interaction-executor.ts";
import {
  normalizeSandboxWorkspacePath,
  SANDBOX_INTERACTION_SOURCE_PATH,
  SANDBOX_WORKSPACE_WRITE_ORDER,
  type PublishedInteractionSandboxProvider,
  type PublishedInteractionSandboxProviderExecuteRequest,
  type PublishedInteractionSandboxWorkspace,
  type PublishedInteractionSandboxWorkspaceFactory,
  type SandboxBackend,
} from "./sandbox-backend.ts";
import {
  createSandboxActionCallMediator,
  failedResult,
  resultFromSandboxError,
  timedOutResult,
  type SandboxActionCallError,
} from "./sandbox-ndjson.ts";
import {
  hardenSandboxGlobals,
  runInteraction,
  type RunSandboxInteractionResult,
  type SandboxRunnerInteractionModule,
} from "./sandbox-runner-core.ts";

/**
 * Realm code-generation options, mirroring the local backend's
 * `--disallow-code-generation-from-strings`.
 */
export const DETERMINISTIC_SANDBOX_CODE_GENERATION = Object.freeze({
  strings: false,
  wasm: false,
});

/**
 * In-memory workspace backed by a `Map<string, string>` — no filesystem.
 * Asserts the orchestrator's workspace write order
 * (`SANDBOX_WORKSPACE_WRITE_ORDER`) so a reordering regression fails loudly.
 */
export class InMemorySandboxWorkspace
  implements PublishedInteractionSandboxWorkspace
{
  readonly rootPath = "in-memory://tidegate-sandbox";
  readonly files = new Map<string, string>();
  readonly writeOrder: string[] = [];
  cleaned = false;

  async writeTextFile({
    content,
    path,
  }: {
    path: string;
    content: string;
  }): Promise<void> {
    const normalizedPath = normalizeSandboxWorkspacePath(path);

    if (!this.files.has(normalizedPath)) {
      const expectedPath = SANDBOX_WORKSPACE_WRITE_ORDER[this.writeOrder.length];

      if (normalizedPath !== expectedPath) {
        throw new Error(
          `Deterministic sandbox workspace expected write #${
            this.writeOrder.length + 1
          } to be "${expectedPath ?? "<none>"}", got "${normalizedPath}".`,
        );
      }
      this.writeOrder.push(normalizedPath);
    }

    this.files.set(normalizedPath, content);
  }

  async cleanup(): Promise<void> {
    this.cleaned = true;
    this.files.clear();
  }
}

export class InMemorySandboxWorkspaceFactory
  implements PublishedInteractionSandboxWorkspaceFactory
{
  readonly workspaces: InMemorySandboxWorkspace[] = [];

  async createWorkspace(): Promise<InMemorySandboxWorkspace> {
    const workspace = new InMemorySandboxWorkspace();
    this.workspaces.push(workspace);
    return workspace;
  }
}

export class DeterministicPublishedInteractionSandboxProvider
  implements PublishedInteractionSandboxProvider
{
  async execute({
    payload,
    runtime,
    workspace,
  }: PublishedInteractionSandboxProviderExecuteRequest): Promise<PublishedInteractionExecutionResult> {
    if (!(workspace instanceof InMemorySandboxWorkspace)) {
      return failedResult(
        "interaction_failed",
        "The deterministic sandbox backend requires its in-memory workspace.",
      );
    }

    const source = workspace.files.get(SANDBOX_INTERACTION_SOURCE_PATH);

    if (source === undefined) {
      return failedResult(
        "interaction_failed",
        "Deterministic sandbox workspace is missing the generated interaction source.",
      );
    }

    const mediator = createSandboxActionCallMediator({ payload, runtime });
    // FIFO scheduler: action calls settle strictly in issue order so
    // concurrent capability calls have one reproducible interleaving. The
    // NDJSON loop is sequential for the same reason.
    let fifoQueue: Promise<unknown> = Promise.resolve();
    const actionCaller = (actionId: string, input: unknown): Promise<unknown> => {
      const call = fifoQueue.then(async () => {
        const outcome = await mediator.call({
          actionCallToken: payload.actionCallToken,
          actionId,
          input: jsonWireClone(input),
        });

        if (outcome.ok) {
          return jsonWireClone(outcome.output);
        }

        throw runnerErrorFromActionCallError(outcome.error);
      });
      fifoQueue = call.then(
        () => undefined,
        () => undefined,
      );
      return call;
    };

    const realm = createDeterministicSandboxRealm();
    const resultPromise = runInteraction({
      moduleLoader: async () =>
        evaluateGeneratedInteractionModule(realm, source),
      input: jsonWireClone(payload.input),
      auth: jsonWireClone(payload.auth),
      capabilities: payload.capabilities,
      actionCaller,
      hardenGlobals: () => hardenSandboxGlobals(realm.globalObject),
    });

    const raced = await raceExecutionTimeout(
      resultPromise,
      payload.timeout.executionMs,
    );

    if (raced.timedOut) {
      // An in-process microtask loop cannot be force-killed; this only
      // normalizes the result. Uninterruptible-runaway coverage belongs to
      // backends with a real, stoppable transport.
      return timedOutResult("The interaction exceeded its execution timeout.");
    }

    return normalizeRunnerResult(raced.result);
  }
}

export type DeterministicSandboxBackend = SandboxBackend & {
  readonly workspaceFactory: InMemorySandboxWorkspaceFactory;
  readonly provider: DeterministicPublishedInteractionSandboxProvider;
};

/**
 * Creates the deterministic in-process backend. TEST-ONLY: `node:vm` is not
 * an isolation boundary — never select this backend in production.
 */
export function createDeterministicSandboxBackend(): DeterministicSandboxBackend {
  return {
    provider: new DeterministicPublishedInteractionSandboxProvider(),
    workspaceFactory: new InMemorySandboxWorkspaceFactory(),
  };
}

/**
 * A step clock for injecting into `createExecutionTraceRecorder` so span
 * offsets and durations are stable across runs and backends.
 */
export function createDeterministicExecutionTraceClock({
  startWallTime = "2026-01-01T00:00:00.000Z",
  stepMs = 1,
}: {
  startWallTime?: string;
  stepMs?: number;
} = {}): ExecutionTraceClock {
  const startMs = Date.parse(startWallTime);
  let tick = 0;

  return {
    now() {
      const monotonicMs = tick * stepMs;
      tick += 1;

      return {
        monotonicMs,
        wallTime: new Date(startMs + monotonicMs).toISOString(),
      };
    },
  };
}

/** Sequential id factory for stable trace/span/event ids in tests. */
export function createDeterministicIdFactory(prefix = "trace"): () => string {
  let index = 0;

  return () => `${prefix}-${++index}`;
}

type DeterministicSandboxRealm = {
  context: vm.Context;
  globalObject: Record<string, unknown>;
};

function createDeterministicSandboxRealm(): DeterministicSandboxRealm {
  const context = vm.createContext(
    {},
    { codeGeneration: { ...DETERMINISTIC_SANDBOX_CODE_GENERATION } },
  );
  const globalObject = vm.runInContext("globalThis", context) as Record<
    string,
    unknown
  >;

  // The local runner realm is Node minus the stripped globals; give the bare
  // vm realm the same timer primitives the local backend leaves available
  // (protocol equivalence: what runs there must run here). The wrappers are
  // created INSIDE the realm so `.constructor` on them resolves to the
  // realm's Function intrinsic (blocked by the codeGeneration policy), never
  // to the host's.
  const installTimerPrimitives = vm.runInContext(
    `((host) => {
      globalThis.setTimeout = (callback, delayMs, ...args) =>
        host.setTimeout(callback, delayMs, ...args);
      globalThis.clearTimeout = (id) => host.clearTimeout(id);
      globalThis.setInterval = (callback, delayMs, ...args) =>
        host.setInterval(callback, delayMs, ...args);
      globalThis.clearInterval = (id) => host.clearInterval(id);
      globalThis.setImmediate = (callback, ...args) =>
        host.setImmediate(callback, ...args);
      globalThis.clearImmediate = (id) => host.clearImmediate(id);
      globalThis.queueMicrotask = (callback) => host.queueMicrotask(callback);
    })`,
    context,
  ) as (host: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    setImmediate: typeof setImmediate;
    clearImmediate: typeof clearImmediate;
    queueMicrotask: typeof queueMicrotask;
  }) => void;
  installTimerPrimitives({
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
  });

  return { context, globalObject };
}

async function evaluateGeneratedInteractionModule(
  realm: DeterministicSandboxRealm,
  source: string,
): Promise<SandboxRunnerInteractionModule> {
  // The workspace holds the transpiled ESM the local runner would import.
  // Convert it to CommonJS so it can be evaluated inside the realm without
  // the module loader (source policy already rejected all imports). The
  // wrapper is an ASYNC function so top-level `await` — legal ESM the local
  // backend supports via a real dynamic import — keeps working here; the
  // transpile leaves `await` expressions in place and awaiting the factory
  // reproduces module-evaluation ordering.
  const commonJsSource = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: false,
  }).outputText;
  const script = new vm.Script(
    `(async function (exports, module) {\n${commonJsSource}\n})`,
    { filename: SANDBOX_INTERACTION_SOURCE_PATH },
  );
  const factory = script.runInContext(realm.context) as (
    exports: Record<string, unknown>,
    module: { exports: Record<string, unknown> },
  ) => Promise<void>;
  const moduleRef = { exports: {} as Record<string, unknown> };

  try {
    await factory(moduleRef.exports, moduleRef);
  } catch (error) {
    // A top-level throw during module evaluation surfaces as a cross-realm
    // error; rebuild it as a host error so its message survives error
    // normalization exactly like the local backend's same-realm import.
    throw toHostRealmError(error);
  }

  const interaction = moduleRef.exports.default;

  if (typeof interaction !== "function") {
    // Let the shared core produce its standard error for this case.
    return moduleRef.exports as SandboxRunnerInteractionModule;
  }

  return {
    default: async (...args: unknown[]) => {
      try {
        return await (interaction as (...args: unknown[]) => unknown)(...args);
      } catch (error) {
        // Errors created inside the realm fail the host `instanceof Error`
        // check the shared core uses. Rebuild them as host errors so error
        // normalization matches the local backend (where the core runs in
        // the same realm as the interaction).
        throw toHostRealmError(error);
      }
    },
  };
}

function toHostRealmError(error: unknown): unknown {
  if (error instanceof Error) {
    return error;
  }

  // Cross-realm brand check: real realm Errors stringify as [object Error];
  // plain thrown objects stay untouched so they normalize exactly like they
  // would inside the local runner realm.
  if (Object.prototype.toString.call(error) !== "[object Error]") {
    return error;
  }

  const candidate = error as {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    status?: unknown;
  };
  const hostError = new Error(
    typeof candidate.message === "string" ? candidate.message : undefined,
  ) as Error & { code?: unknown; retryable?: unknown; status?: unknown };

  if (candidate.code !== undefined) {
    hostError.code = candidate.code;
  }
  if (candidate.status !== undefined) {
    hostError.status = candidate.status;
  }
  if (candidate.retryable !== undefined) {
    hostError.retryable = candidate.retryable;
  }

  return hostError;
}

function normalizeRunnerResult(
  result: RunSandboxInteractionResult,
): PublishedInteractionExecutionResult {
  if (result.status === "ok") {
    return { status: "ok", output: jsonWireClone(result.output) };
  }

  return resultFromSandboxError({
    type: "error",
    code: result.error.code,
    status: result.error.status,
    message: result.error.message,
    retryable: result.error.retryable,
  });
}

function runnerErrorFromActionCallError(
  error: SandboxActionCallError,
): Error & { code: string; status: string; retryable?: boolean } {
  // Mirrors how the NDJSON runner rebuilds a failed action_result frame.
  return Object.assign(new Error(error.message), {
    code: error.code,
    status: error.status,
    retryable: error.retryable,
  });
}

async function raceExecutionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; result: T }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  try {
    return await Promise.race([
      promise.then((result) => ({ timedOut: false as const, result })),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Round-trips a value through JSON exactly like the NDJSON transport does,
 * so the deterministic backend has the same serialization semantics as the
 * process backends (dates become strings, functions/undefined drop, realm
 * objects become plain host objects).
 */
function jsonWireClone<T>(value: T): T {
  return (JSON.parse(JSON.stringify({ wire: value })) as { wire: T }).wire;
}
