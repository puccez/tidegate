import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TidegateActionCatalogManifestV1 } from "@tidegate/contracts";
import {
  findGeneratedInteractionRuntimeSourcePolicyFinding,
  transpileGeneratedInteractionSource,
} from "./generated-interaction-source-policy.ts";
import { prepareTidegateSandboxCapabilities } from "./sandbox-capabilities.ts";
import {
  createTransportSandboxProvider,
  failedResult,
  rejectedResult,
  type SandboxRunnerTransport,
} from "./sandbox-ndjson.ts";
import {
  hardenSandboxGlobals,
  runInteraction,
} from "./sandbox-runner-core.ts";
import {
  normalizeSandboxWorkspacePath,
  SANDBOX_INTERACTION_SOURCE_PATH,
  SANDBOX_RUNNER_SOURCE_PATH,
  type PublishedInteractionSandboxProvider,
  type PublishedInteractionSandboxProviderExecuteRequest,
  type PublishedInteractionSandboxWorkspace,
  type PublishedInteractionSandboxWorkspaceFactory,
  type SandboxBackend,
} from "./sandbox-backend.ts";
import type {
  ActiveExecutionSpan,
  ActiveExecutionTrace,
  ExecutionTraceRecorder,
} from "./execution-tracing.ts";
import type {
  PublishedInteractionExecutionPayload,
  PublishedInteractionExecutionResult,
  PublishedInteractionExecutor,
  PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor.ts";

export type {
  PublishedInteractionSandboxProvider,
  PublishedInteractionSandboxProviderExecuteRequest,
  PublishedInteractionSandboxWorkspace,
  PublishedInteractionSandboxWorkspaceFactory,
  SandboxBackend,
} from "./sandbox-backend.ts";

const INTERACTION_SOURCE_PATH = SANDBOX_INTERACTION_SOURCE_PATH;
const RUNNER_SOURCE_PATH = SANDBOX_RUNNER_SOURCE_PATH;
const SANDBOX_WORKSPACE_PREFIX = "tidegate-published-interaction-";

export type SandboxExecutionTracingContext = {
  readonly ownerId: string;
  readonly tenantId?: string;
};

export type SandboxExecutionTracingOptions = {
  readonly recorder: ExecutionTraceRecorder;
  /**
   * Maps an execution payload to the trace owner. Defaults to the payload's
   * organization/subject identity; returning undefined skips tracing.
   */
  readonly resolveContext?: (
    payload: PublishedInteractionExecutionPayload,
  ) => SandboxExecutionTracingContext | undefined;
};

export type CreateSandboxedPublishedInteractionExecutorOptions = {
  /**
   * Selects the sandbox backend (workspace factory + provider) as one unit.
   * Preferred over the loose `provider`/`workspaceFactory` options, which can
   * silently pair a workspace with a provider that cannot use it.
   */
  backend?: SandboxBackend;
  /** @deprecated Pass a {@link SandboxBackend} via `backend` instead. */
  provider?: PublishedInteractionSandboxProvider;
  /** @deprecated Pass a {@link SandboxBackend} via `backend` instead. */
  workspaceFactory?: PublishedInteractionSandboxWorkspaceFactory;
  tracing?: SandboxExecutionTracingOptions;
};

export class SandboxedPublishedInteractionExecutor
  implements PublishedInteractionExecutor
{
  private readonly provider: PublishedInteractionSandboxProvider;
  private readonly workspaceFactory: PublishedInteractionSandboxWorkspaceFactory;
  private readonly tracing: SandboxExecutionTracingOptions | undefined;

  constructor({
    backend,
    provider,
    workspaceFactory,
    tracing,
  }: CreateSandboxedPublishedInteractionExecutorOptions = {}) {
    if (
      backend !== undefined &&
      (provider !== undefined || workspaceFactory !== undefined)
    ) {
      throw new Error(
        "Pass either `backend` or the deprecated `provider`/`workspaceFactory` options, never both: a backend pairs its workspace factory and provider as one unit.",
      );
    }
    this.provider =
      backend?.provider ??
      provider ??
      new LocalProcessPublishedInteractionSandboxProvider();
    this.workspaceFactory =
      backend?.workspaceFactory ??
      workspaceFactory ??
      new LocalPublishedInteractionSandboxWorkspaceFactory();
    this.tracing = tracing;
  }

  async execute(
    payload: PublishedInteractionExecutionPayload,
    runtime: PublishedInteractionTrustedRuntime,
  ): Promise<PublishedInteractionExecutionResult> {
    const trace = await startSandboxTrace(this.tracing, payload);
    try {
      const result = await this.executeInSandbox(payload, runtime, trace);
      await finishSandboxTrace(trace, result);
      return result;
    } catch (error) {
      await finishSandboxTrace(trace, {
        status: "failed",
        error: {
          code: "interaction_failed",
          message:
            error instanceof Error
              ? error.message
              : "Published interaction sandbox execution failed.",
        },
      });
      throw error;
    }
  }

  private async executeInSandbox(
    payload: PublishedInteractionExecutionPayload,
    runtime: PublishedInteractionTrustedRuntime,
    trace: ActiveExecutionTrace | undefined,
  ): Promise<PublishedInteractionExecutionResult> {
    if (payload.artifact.kind !== "source_snapshot") {
      return rejectedResult(
        "interaction_unavailable",
        "Published interaction execution requires an immutable source snapshot.",
      );
    }

    const sourceViolation = findGeneratedInteractionRuntimeSourcePolicyFinding(
      payload.artifact.source,
    );

    if (sourceViolation) {
      return rejectedResult(
        "action_not_allowed",
        `Sandbox source policy rejected ${sourceViolation.label}.`,
      );
    }

    if (!capabilitiesMatchAllowedActions(payload)) {
      return rejectedResult(
        "action_not_allowed",
        "Sandbox capability metadata must match the published action allowlist.",
      );
    }

    const allocateSpan = startSandboxSpan(trace, {
      category: "sandbox",
      name: "sandbox.allocate",
    });
    const workspace = await this.workspaceFactory.createWorkspace(payload);
    await finishSandboxSpan(allocateSpan, "ok");

    try {
      const prepareSpan = startSandboxSpan(trace, {
        category: "typecheck",
        name: "sandbox.prepare",
      });
      await workspace.writeTextFile({
        path: INTERACTION_SOURCE_PATH,
        content: transpileGeneratedInteractionSource(payload.artifact.source),
      });
      await prepareTidegateSandboxCapabilities({
        sandbox: workspace,
        manifest: createRuntimeCapabilityManifest(payload),
      });
      await workspace.writeTextFile({
        path: RUNNER_SOURCE_PATH,
        content: createSandboxRunnerSource(),
      });
      await finishSandboxSpan(prepareSpan, "ok");

      const runSpan = startSandboxSpan(trace, {
        category: "sandbox",
        name: "sandbox.run",
      });
      const result = await this.provider.execute({
        workspace,
        runnerPath: RUNNER_SOURCE_PATH,
        payload,
        runtime,
      });
      await finishSandboxSpan(
        runSpan,
        result.status === "ok" ? "ok" : "error",
        "error" in result ? result.error : undefined,
      );
      return result;
    } catch (error) {
      return failedResult(
        "interaction_failed",
        error instanceof Error
          ? error.message
          : "Published interaction sandbox execution failed.",
      );
    } finally {
      await workspace.cleanup();
    }
  }
}

async function startSandboxTrace(
  tracing: SandboxExecutionTracingOptions | undefined,
  payload: PublishedInteractionExecutionPayload,
): Promise<ActiveExecutionTrace | undefined> {
  if (tracing === undefined) {
    return undefined;
  }
  const resolveContext =
    tracing.resolveContext ?? defaultSandboxTracingContext;
  const context = resolveContext(payload);
  if (context === undefined) {
    return undefined;
  }
  try {
    return await tracing.recorder.startExecution({
      attributes: {
        artifactId: payload.artifact.id,
        artifactVersion: payload.artifact.version,
        invocationId: payload.invocationId,
      },
      clockDomain: "server",
      kind: "sandbox.execute",
      ownerId: context.ownerId,
      source: "tidegate.sandbox-executor",
      ...(context.tenantId === undefined
        ? {}
        : { tenantId: context.tenantId }),
    });
  } catch {
    // Telemetry must never fail the user's execution.
    return undefined;
  }
}

function defaultSandboxTracingContext(
  payload: PublishedInteractionExecutionPayload,
): SandboxExecutionTracingContext | undefined {
  const ownerId = payload.auth.organizationId ?? payload.auth.subjectId;
  if (ownerId === undefined) {
    return undefined;
  }
  return {
    ownerId,
    ...(payload.auth.tenantId === undefined
      ? {}
      : { tenantId: payload.auth.tenantId }),
  };
}

function startSandboxSpan(
  trace: ActiveExecutionTrace | undefined,
  input: { readonly category: string; readonly name: string },
): ActiveExecutionSpan | undefined {
  try {
    return trace?.startSpan(input);
  } catch {
    return undefined;
  }
}

async function finishSandboxSpan(
  span: ActiveExecutionSpan | undefined,
  status: "ok" | "error",
  error?: { readonly code?: string; readonly message?: string },
): Promise<void> {
  try {
    await span?.finish(status, error);
  } catch {
    // Telemetry must never fail the user's execution.
  }
}

async function finishSandboxTrace(
  trace: ActiveExecutionTrace | undefined,
  result: {
    readonly status: PublishedInteractionExecutionResult["status"];
    readonly error?: { readonly code: string; readonly message: string };
  },
): Promise<void> {
  if (trace === undefined) {
    return;
  }
  try {
    trace.mark("sandbox.result", {
      status: result.status,
      ...(result.error === undefined ? {} : { errorCode: result.error.code }),
    });
    await trace.finish(result.status === "ok" ? "complete" : "failed");
  } catch {
    // Telemetry must never fail the user's execution.
  }
}

export function createSandboxedPublishedInteractionExecutor(
  options?: CreateSandboxedPublishedInteractionExecutorOptions,
): SandboxedPublishedInteractionExecutor {
  return new SandboxedPublishedInteractionExecutor(options);
}

/**
 * The default backend: a hardened local Node child process over a tmpdir
 * workspace. This is the production default; alternative backends plug in
 * behind the same {@link SandboxBackend} seam.
 */
export function createLocalProcessSandboxBackend(): SandboxBackend {
  return {
    provider: new LocalProcessPublishedInteractionSandboxProvider(),
    workspaceFactory: new LocalPublishedInteractionSandboxWorkspaceFactory(),
  };
}

export class LocalPublishedInteractionSandboxWorkspaceFactory
  implements PublishedInteractionSandboxWorkspaceFactory
{
  async createWorkspace(): Promise<PublishedInteractionSandboxWorkspace> {
    const rootPath = await mkdtemp(
      join(tmpdir(), SANDBOX_WORKSPACE_PREFIX),
    );

    return new LocalPublishedInteractionSandboxWorkspace(rootPath);
  }
}

/**
 * Spawns the hardened local Node runner process for a prepared workspace and
 * exposes it as the pure transport the shared `SandboxProtocolDriver`
 * consumes. Exported so tests can wrap it (for example to observe `stop()`).
 */
export function spawnLocalSandboxRunner({
  runnerPath,
  workspace,
}: PublishedInteractionSandboxProviderExecuteRequest): SandboxRunnerTransport {
  const command = createSandboxRuntimeCommand(runnerPath);
  const subprocess = spawn(command.executable, command.args, {
    cwd: workspace.rootPath,
    stdio: ["pipe", "pipe", "pipe"],
    env: command.env as NodeJS.ProcessEnv,
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    subprocess.once("exit", (code) => {
      resolve(code);
    });
    subprocess.once("error", (error) => {
      reject(error);
    });
  });
  // The driver races several consumers over `exit`; keep an always-attached
  // handler so a spawn failure never surfaces as an unhandled rejection.
  exit.catch(() => {});

  const stdin = subprocess.stdin;
  const stdout = subprocess.stdout;
  const stderr = subprocess.stderr;

  if (!stdin || !stdout || !stderr) {
    subprocess.kill();
    throw new Error("Sandbox provider could not open process pipes.");
  }

  // stdin writes race the child's death (e.g. an action_result reply to a
  // runner that just crashed). Node surfaces that as an async 'error' event
  // (ERR_STREAM_DESTROYED / EPIPE) which would crash the host; swallow it so
  // the driver's normalized exit-path result stands.
  stdin.on("error", () => {});

  return {
    stdin,
    stdout,
    stderr,
    exit,
    async stop() {
      subprocess.kill();
    },
  };
}

export class LocalProcessPublishedInteractionSandboxProvider
  implements PublishedInteractionSandboxProvider
{
  private readonly provider = createTransportSandboxProvider(
    spawnLocalSandboxRunner,
  );

  execute(
    request: PublishedInteractionSandboxProviderExecuteRequest,
  ): Promise<PublishedInteractionExecutionResult> {
    return this.provider.execute(request);
  }
}

class LocalPublishedInteractionSandboxWorkspace
  implements PublishedInteractionSandboxWorkspace
{
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async writeTextFile({
    content,
    path,
  }: {
    path: string;
    content: string;
  }): Promise<void> {
    const normalizedPath = normalizeSandboxWorkspacePath(path);
    const absolutePath = join(this.rootPath, normalizedPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  async cleanup(): Promise<void> {
    await rm(this.rootPath, { recursive: true, force: true });
  }
}

function createRuntimeCapabilityManifest(
  payload: PublishedInteractionExecutionPayload,
): TidegateActionCatalogManifestV1 {
  return {
    schemaVersion: "tidegate.actionCatalog.v1",
    catalogId: payload.capabilities.actionCatalogId,
    version: payload.capabilities.actionCatalogVersion,
    actions: Object.fromEntries(
      payload.capabilities.actionIds.map((actionId) => [
        actionId,
        {
          description: `Published interaction capability ${actionId}.`,
          input: {},
          output: {},
          effects: "external" as const,
          requiredPermissions: [],
          audit: {
            required: true,
            redactPaths: [],
          },
        },
      ]),
    ),
  };
}

/**
 * Generates the sandbox runner script for process-based backends. The script
 * is a thin NDJSON stdin/stdout transport around the shared runner core:
 * `hardenSandboxGlobals` and `runInteraction` are embedded verbatim from
 * `sandbox-runner-core.ts` so the process runner and the deterministic
 * in-process backend execute the same code.
 */
export function createSandboxRunnerSource(): string {
  return String.raw`
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hostProcess = process;
const stdinReader = hostProcess.stdin[Symbol.asyncIterator]();
let stdinBuffer = "";
let actionCallIndex = 0;
const pendingActionCalls = new Map();

const hardenSandboxGlobals = ${hardenSandboxGlobals.toString()};

const runInteraction = ${runInteraction.toString()};

hardenSandboxGlobals(globalThis);

function writeMessage(message) {
  hostProcess.stdout.write(encoder.encode(JSON.stringify(message) + "\n"));
}

async function readLine() {
  for (;;) {
    const newlineIndex = stdinBuffer.indexOf("\n");

    if (newlineIndex !== -1) {
      const line = stdinBuffer.slice(0, newlineIndex);
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
      return line;
    }

    const chunk = await stdinReader.next();

    if (chunk.done) {
      if (stdinBuffer.length === 0) {
        return undefined;
      }

      const line = stdinBuffer;
      stdinBuffer = "";
      return line;
    }

    stdinBuffer += decoder.decode(chunk.value, { stream: true });
  }
}

async function readProtocolMessages() {
  for (;;) {
    const line = await readLine();

    if (line === undefined) {
      return;
    }

    if (line.trim().length === 0) {
      continue;
    }

    const message = JSON.parse(line);

    if (message.type !== "action_result") {
      continue;
    }

    const pending = pendingActionCalls.get(message.callId);

    if (!pending) {
      continue;
    }

    pendingActionCalls.delete(message.callId);

    if (message.ok) {
      pending.resolve(message.output);
    } else {
      const error = new Error(message.error?.message ?? "Action call failed.");
      error.code = message.error?.code ?? "interaction_failed";
      error.status = message.error?.status ?? "failed";
      error.retryable = message.error?.retryable;
      pending.reject(error);
    }
  }
}

function createNdjsonActionCaller(payload) {
  return (actionId, input) => {
    const callId = "action_" + ++actionCallIndex;
    const promise = new Promise((resolve, reject) => {
      pendingActionCalls.set(callId, { resolve, reject });
    });

    writeMessage({
      type: "action_call",
      callId,
      actionCallToken: payload.actionCallToken,
      actionId,
      input,
    });

    return promise;
  };
}

const startLine = await readLine();

if (startLine === undefined) {
  writeMessage({
    type: "error",
    code: "interaction_failed",
    status: "failed",
    message: "Sandbox did not receive a runtime payload.",
  });
} else {
  const payload = JSON.parse(startLine);
  void readProtocolMessages();

  const result = await runInteraction({
    moduleLoader: async () => await import("./interaction.generated.mjs"),
    input: payload.input,
    auth: payload.auth,
    capabilities: payload.capabilities,
    actionCaller: createNdjsonActionCaller(payload),
    hardenGlobals: () => hardenSandboxGlobals(globalThis),
  });

  if (result.status === "ok") {
    writeMessage({ type: "result", output: result.output });
  } else {
    writeMessage({ type: "error", ...result.error });
  }
}
`.trim();
}

function createSandboxRuntimeCommand(runnerPath: string): {
  executable: string;
  args: string[];
  env: Record<string, string | undefined>;
} {
  const isBunRuntime =
    typeof process.versions === "object" &&
    typeof (process.versions as { bun?: unknown }).bun === "string";
  const nodeExecutable =
    isBunRuntime && process.env.TIDEGATE_SANDBOX_NODE_PATH
      ? process.env.TIDEGATE_SANDBOX_NODE_PATH
      : isBunRuntime
        ? "node"
        : process.execPath;
  const env: Record<string, string | undefined> = {};

  if (nodeExecutable === "node" && process.env.PATH !== undefined) {
    env.PATH = process.env.PATH;
  }

  return {
    executable: nodeExecutable,
    args: ["--disallow-code-generation-from-strings", runnerPath],
    env,
  };
}

function capabilitiesMatchAllowedActions(
  payload: PublishedInteractionExecutionPayload,
): boolean {
  const capabilityIds = new Set(payload.capabilities.actionIds);

  if (capabilityIds.size !== payload.allowedActionIds.length) {
    return false;
  }

  return payload.allowedActionIds.every((actionId) =>
    capabilityIds.has(actionId),
  );
}
