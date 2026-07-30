/**
 * Vercel Sandbox backend for the published-interaction execution seam.
 *
 * Every invoke gets a fresh, ephemeral Firecracker microVM (Node 24, egress
 * denied for the generated code) that is destroyed when the call completes:
 * one VM = one invoke is a security invariant of this backend, not a tuning
 * default. The trusted orchestrator keeps owning source policy, transpile,
 * capability manifests, action-call mediation, timeout, tracing, and result
 * normalization — this module only moves bytes:
 *
 * - The workspace factory allocates the microVM and writes the exact files
 *   the orchestrator hands it, under the same write-order contract every
 *   backend observes (`sandbox-backend-conformance.ts`).
 * - The provider runs the orchestrator-authored runner (`tidegate-runner.mjs`)
 *   unchanged and adapts it to the shared NDJSON protocol driver as a
 *   `SandboxRunnerTransport`.
 *
 * Transport shape: the Vercel Sandbox SDK streams command stdout/stderr to
 * host-provided writables but exposes no interactive stdin. Host→runner
 * messages therefore travel as sequential message files
 * (`msg-1`, `msg-2`, …) that a tiny in-VM feeder script streams — in order,
 * once each file is complete — into the runner's real stdin through a shell
 * pipe. The runner still reads plain NDJSON from its stdin; the protocol and
 * the runner source are byte-identical across backends. The driver writes
 * whole `\n`-terminated lines per `stdin.write`, which is what makes the
 * file-per-message mapping sound.
 */
import { posix } from "node:path";
import { PassThrough } from "node:stream";
// Static import on purpose: a dynamic import() here splits the single-file
// bundles Eve builds for the agent's authored tools (which reach this module
// transitively) and breaks `eve build` with "Expected one bundled authored
// module". The SDK loads eagerly only for consumers of this subpath.
import { Sandbox } from "@vercel/sandbox";
import type {
  PublishedInteractionExecutionPayload,
  PublishedInteractionExecutionResult,
} from "./published-interaction-executor.ts";
import {
  createTransportSandboxProvider,
  type SandboxRunnerTransport,
  type SpawnSandboxRunner,
} from "./sandbox-ndjson.ts";
import {
  normalizeSandboxWorkspacePath,
  type PublishedInteractionSandboxProvider,
  type PublishedInteractionSandboxProviderExecuteRequest,
  type PublishedInteractionSandboxWorkspace,
  type PublishedInteractionSandboxWorkspaceFactory,
  type SandboxBackend,
} from "./sandbox-backend.ts";

export const VERCEL_SANDBOX_BACKEND_NAME = "vercel";
export const VERCEL_SANDBOX_RUNTIME = "node24";

const WORKSPACE_DIRECTORY = "/vercel/sandbox/tidegate-workspace";
const PROTOCOL_DIRECTORY = "/vercel/sandbox/tidegate-protocol";
const STDIN_DIRECTORY = `${PROTOCOL_DIRECTORY}/stdin`;
const FEEDER_PATH = `${PROTOCOL_DIRECTORY}/feeder.sh`;

/** VM lifetime floor: allocation + protocol overhead must never be starved. */
const VM_TIMEOUT_MIN_MS = 60_000;
/** Margin on top of the interaction execution timeout for boot + teardown. */
const VM_TIMEOUT_MARGIN_MS = 60_000;
/** In-VM command backstop; the protocol driver's own timeout fires first. */
const COMMAND_TIMEOUT_MARGIN_MS = 30_000;
/**
 * Once both output streams have ended, trust stream-end as process exit if
 * the SDK's `wait()` has not settled yet: `exitCode` only distinguishes a
 * crash-before-result, which stream-end without a result already surfaces.
 */
const DEFAULT_EXIT_FALLBACK_MS = 2_000;
/**
 * The SDK pipes command output into the provided writables but never ends
 * them; the transport ends them itself once `wait()` reports the command
 * gone, after a short drain so buffered tail output still lands. Without
 * this, a runner crash would surface as a protocol timeout instead of the
 * driver's exited-without-result failure.
 */
const STREAM_DRAIN_MS = 150;

/**
 * The minimal Vercel Sandbox surface this backend consumes, kept structural
 * so tests can substitute an in-memory client and so SDK type drift stays
 * contained to the default adapter in `createDefaultVercelSandboxClient`.
 */
export type VercelSandboxCommandHandle = {
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  wait(): Promise<{ exitCode: number }>;
  /**
   * Live command output. This MUST be the transport's only output channel:
   * the SDK feeds any `stdout`/`stderr` writables from the same underlying
   * stream and only while a `logs()` iteration is active, so mixing the two
   * splits the data between them. The iterator ends when the command exits.
   */
  logs(): AsyncIterable<{ data: string; stream: "stdout" | "stderr" }>;
};

export type VercelSandboxClient = {
  /** Sandbox name: the public identifier, used as the tracing dimension. */
  readonly name: string;
  writeFiles(
    files: Array<{ path: string; content: string }>,
  ): Promise<void>;
  mkDir(path: string): Promise<void>;
  runCommand(params: {
    cmd: string;
    args: string[];
    cwd: string;
    detached: true;
    timeoutMs: number;
  }): Promise<VercelSandboxCommandHandle>;
  stop(): Promise<unknown>;
};

export type VercelSandboxCreateParams = {
  runtime: string;
  timeout: number;
  networkPolicy: "deny-all";
  /**
   * Always `false`: the platform default (`true`) snapshots the filesystem
   * on every `stop()` for later resume, but an invoke VM is never resumed —
   * one VM = one invoke — so each invoke would leave a ~258MB snapshot
   * behind, billed as storage until its 30-day expiry.
   */
  persistent: false;
  token?: string;
  teamId?: string;
  projectId?: string;
};

export type CreateVercelSandboxBackendOptions = {
  /**
   * Explicit Vercel credentials. Omit to use the ambient OIDC token
   * (`VERCEL_OIDC_TOKEN`, provided automatically in Vercel deployments and
   * via `vercel env pull` in local development).
   */
  credentials?: { token: string; teamId: string; projectId: string };
  /** Sandbox runtime image. Defaults to Node 24. */
  runtime?: string;
  /**
   * Sandbox allocation seam, used by tests to substitute an in-memory
   * client. Defaults to `Sandbox.create` from `@vercel/sandbox`.
   */
  createSandbox?: (
    params: VercelSandboxCreateParams,
  ) => Promise<VercelSandboxClient>;
  /** Test hook for the stream-end exit fallback delay. */
  exitFallbackMs?: number;
};

/**
 * Sizes the microVM lifetime around the interaction execution timeout: the
 * VM must always outlive the protocol driver's own timeout (which fires
 * first and tears the transport down), including the boot/prepare time that
 * elapses before the driver's timer even starts — a VM that dies first
 * would misreport a slow interaction as `interaction_failed` instead of
 * `timed_out`. The result is still a leak backstop: it is bounded by the
 * artifact's declared timeout, never unbounded, and an executionMs beyond
 * what the platform accepts fails loudly at `Sandbox.create`.
 */
export function resolveVercelSandboxVmTimeoutMs(executionMs: number): number {
  return Math.max(executionMs + VM_TIMEOUT_MARGIN_MS, VM_TIMEOUT_MIN_MS);
}

/**
 * Prefix of the feeder's stderr markers. The markers are LOAD-BEARING, not
 * cosmetic: without writes on the command's output, the SDK's log stream
 * was observed to hold a lone, late protocol line back (sometimes until the
 * command exited), turning invokes into driver timeouts. The `start` marker
 * primes the stream immediately and the ~1s `alive` heartbeat keeps it
 * flowing while the protocol is otherwise quiet, so the runner's lines are
 * never the only traffic a lazy flush can sit on. The transport filters
 * these marker lines out of the stderr it hands the driver (see the pump),
 * so error details keep local-backend parity.
 */
export const VERCEL_SANDBOX_FEEDER_MARKER_PREFIX = "tg-feeder-";

/**
 * The in-VM feeder: streams host-written NDJSON message files to the
 * runner's stdin, in order. A message file is consumed only once it is
 * non-empty and newline-terminated (the host writes whole protocol lines),
 * so a partially-visible write is never forwarded. The `closed` marker ends
 * the stream once every prior message has been consumed.
 */
export function createVercelSandboxFeederScript(
  stdinDirectory: string = STDIN_DIRECTORY,
): string {
  return `#!/bin/sh
echo "${VERCEL_SANDBOX_FEEDER_MARKER_PREFIX}start $(date +%s.%N)" >&2
i=1
idle=0
while :; do
  f="${stdinDirectory}/msg-$i"
  if [ -s "$f" ] && [ -z "$(tail -c 1 "$f" | tr -d '\\n')" ]; then
    echo "${VERCEL_SANDBOX_FEEDER_MARKER_PREFIX}consumed-$i $(date +%s.%N)" >&2
    cat "$f"
    i=$((i+1))
    idle=0
    continue
  fi
  if [ -f "${stdinDirectory}/closed" ] && [ ! -f "$f" ]; then
    exit 0
  fi
  idle=$((idle+1))
  if [ $((idle % 20)) -eq 0 ]; then
    echo "${VERCEL_SANDBOX_FEEDER_MARKER_PREFIX}alive $(date +%s.%N)" >&2
  fi
  sleep 0.05
done
`;
}

/**
 * Explicit credentials for `Sandbox.create`: the ones passed via backend
 * options win; otherwise the documented VERCEL_TOKEN + VERCEL_TEAM_ID +
 * VERCEL_PROJECT_ID triple is honored (the SDK does NOT read those three
 * itself — it only auto-resolves the ambient OIDC token, which stays the
 * fallback when the triple is absent or incomplete).
 */
export function resolveVercelSandboxCredentials(
  params: Pick<VercelSandboxCreateParams, "token" | "teamId" | "projectId">,
  env: Record<string, string | undefined> = process.env,
): { token?: string; teamId?: string; projectId?: string } {
  if (params.token !== undefined) {
    return {
      token: params.token,
      ...(params.teamId === undefined ? {} : { teamId: params.teamId }),
      ...(params.projectId === undefined
        ? {}
        : { projectId: params.projectId }),
    };
  }

  // Blank placeholders (VERCEL_TOKEN= next to a valid OIDC token) must not
  // masquerade as explicit credentials: the triple counts only when every
  // value is non-empty, otherwise the ambient OIDC fallback stays in charge.
  const token = env.VERCEL_TOKEN?.trim();
  const teamId = env.VERCEL_TEAM_ID?.trim();
  const projectId = env.VERCEL_PROJECT_ID?.trim();

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }

  return {};
}

async function createDefaultVercelSandboxClient(
  params: VercelSandboxCreateParams,
): Promise<VercelSandboxClient> {
  const { networkPolicy, persistent, runtime, timeout } = params;
  const sandbox = await Sandbox.create({
    ...resolveVercelSandboxCredentials(params),
    networkPolicy,
    persistent,
    runtime,
    timeout,
  });

  return {
    name: sandbox.name,
    writeFiles: async (files) => {
      await sandbox.writeFiles(files);
    },
    mkDir: async (path) => {
      await sandbox.mkDir(path);
    },
    runCommand: async (params) => {
      const command = await sandbox.runCommand(params);

      return {
        kill: async (signal) => {
          await command.kill(signal);
        },
        wait: async () => ({ exitCode: (await command.wait()).exitCode }),
        logs: () => command.logs(),
      };
    },
    stop: () => sandbox.stop(),
  };
}

export class VercelPublishedInteractionSandboxWorkspace
  implements PublishedInteractionSandboxWorkspace
{
  readonly rootPath = WORKSPACE_DIRECTORY;
  readonly sandboxId: string;
  /** @internal The provider half of this backend drives the same VM. */
  readonly client: VercelSandboxClient;
  private stopPromise: Promise<void> | undefined;

  constructor(client: VercelSandboxClient) {
    this.client = client;
    this.sandboxId = client.name;
  }

  async writeTextFile({
    content,
    path,
  }: {
    path: string;
    content: string;
  }): Promise<void> {
    const normalizedPath = normalizeSandboxWorkspacePath(path);
    const absolutePath = posix.join(this.rootPath, normalizedPath);
    const parent = posix.dirname(absolutePath);

    if (parent !== this.rootPath) {
      await this.client.mkDir(parent);
    }
    await this.client.writeFiles([{ path: absolutePath, content }]);
  }

  /**
   * Single-flight VM teardown shared by the transport's mandatory `stop()`
   * and the orchestrator's workspace `cleanup()`: whichever runs first stops
   * the VM, the second observes the same outcome. A real stop failure
   * surfaces through `cleanup()` so the executor records it as the cleanup
   * outcome (the VM's own `timeout` is the leak backstop).
   */
  stopSandbox(): Promise<void> {
    this.stopPromise ??= Promise.resolve(this.client.stop()).then(
      () => undefined,
    );
    return this.stopPromise;
  }

  async cleanup(): Promise<void> {
    await this.stopSandbox();
  }
}

export class VercelPublishedInteractionSandboxWorkspaceFactory
  implements PublishedInteractionSandboxWorkspaceFactory
{
  private readonly options: CreateVercelSandboxBackendOptions;

  constructor(options: CreateVercelSandboxBackendOptions = {}) {
    this.options = options;
  }

  async createWorkspace(
    payload: PublishedInteractionExecutionPayload,
  ): Promise<VercelPublishedInteractionSandboxWorkspace> {
    const createSandbox =
      this.options.createSandbox ?? createDefaultVercelSandboxClient;
    const client = await createSandbox({
      runtime: this.options.runtime ?? VERCEL_SANDBOX_RUNTIME,
      timeout: resolveVercelSandboxVmTimeoutMs(payload.timeout.executionMs),
      networkPolicy: "deny-all",
      persistent: false,
      ...(this.options.credentials ?? {}),
    });

    try {
      await client.mkDir(WORKSPACE_DIRECTORY);
      await client.mkDir(PROTOCOL_DIRECTORY);
      await client.mkDir(STDIN_DIRECTORY);
      await client.writeFiles([
        { path: FEEDER_PATH, content: createVercelSandboxFeederScript() },
      ]);

      return new VercelPublishedInteractionSandboxWorkspace(client);
    } catch (error) {
      // Never leak a VM whose workspace could not be prepared.
      try {
        await client.stop();
      } catch {
        // The create-time failure is the actionable error.
      }
      throw error;
    }
  }
}

/**
 * Adapts one detached in-VM command (`feeder | node runner`) to the pure
 * transport the shared protocol driver consumes.
 */
export function createVercelSandboxRunnerSpawner({
  exitFallbackMs = DEFAULT_EXIT_FALLBACK_MS,
}: {
  exitFallbackMs?: number;
} = {}): SpawnSandboxRunner {
  return async (
    request: PublishedInteractionSandboxProviderExecuteRequest,
  ): Promise<SandboxRunnerTransport> => {
    const { workspace } = request;

    if (!(workspace instanceof VercelPublishedInteractionSandboxWorkspace)) {
      throw new Error(
        "The Vercel Sandbox provider requires a workspace created by the Vercel Sandbox workspace factory: a backend pairs its workspace factory and provider as one unit.",
      );
    }

    const client = workspace.client;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const command = await client.runCommand({
      cmd: "sh",
      // $0 = feeder script, $1 = runner path (workspace-relative, resolved
      // against cwd). The pipeline keeps the runner's stdin a real stdin.
      args: [
        "-c",
        'sh "$0" | node --disallow-code-generation-from-strings "$1"',
        FEEDER_PATH,
        request.runnerPath,
      ],
      cwd: workspace.rootPath,
      detached: true,
      timeoutMs:
        request.payload.timeout.executionMs + COMMAND_TIMEOUT_MARGIN_MS,
    });

    // Pump the command's only live output channel into the transport's
    // stream pair. The iterator ends when the command exits, which is what
    // lets the driver classify a crash-without-result instead of timing out.
    // Feeder marker lines are transport plumbing and never reach the driver.
    let stderrLineBuffer = "";
    const forwardStderr = (data: string) => {
      stderrLineBuffer += data;
      const lines = stderrLineBuffer.split("\n");
      stderrLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith(VERCEL_SANDBOX_FEEDER_MARKER_PREFIX)) {
          stderr.write(`${line}\n`);
        }
      }
    };
    void (async () => {
      try {
        for await (const log of command.logs()) {
          if (log.stream === "stdout") {
            stdout.write(log.data);
          } else {
            forwardStderr(log.data);
          }
        }
      } catch {
        // A dropped log stream is indistinguishable from command death for
        // the protocol: stream end below hands the outcome to the driver.
      } finally {
        if (
          stderrLineBuffer.length > 0 &&
          !stderrLineBuffer.startsWith(VERCEL_SANDBOX_FEEDER_MARKER_PREFIX)
        ) {
          stderr.write(stderrLineBuffer);
        }
        try {
          stdout.end();
        } catch {
          // Already ended.
        }
        try {
          stderr.end();
        } catch {
          // Already ended.
        }
      }
    })();

    // Host→runner messages: one complete NDJSON line per sequential file,
    // serialized so file N is fully written before file N+1 starts.
    let messageIndex = 0;
    let ended = false;
    let writeChain: Promise<void> = Promise.resolve();
    const enqueueFile = (path: string, content: string) => {
      writeChain = writeChain
        .then(() => client.writeFiles([{ path, content }]))
        .catch(() => {
          // A failed protocol write stalls the runner; the driver's timeout
          // and exit handling own that outcome — never crash the host.
        });
    };

    let resolveExitFast: () => void = () => {};

    const stdin = {
      write(chunk: string | Uint8Array) {
        if (ended) {
          return;
        }
        messageIndex += 1;
        const content =
          typeof chunk === "string"
            ? chunk
            : new TextDecoder().decode(chunk);
        enqueueFile(`${STDIN_DIRECTORY}/msg-${messageIndex}`, content);
      },
      end() {
        if (ended) {
          return;
        }
        ended = true;
        enqueueFile(`${STDIN_DIRECTORY}/closed`, "closed\n");
        // The driver ends stdin right after a terminal protocol outcome.
        // The exit code only ever disambiguates ok-results, and a runner
        // that produced a result exits 0 — resolve fast so the driver's
        // short exit-grace window never turns a VM API round-trip into a
        // false "exited before returning output" failure.
        resolveExitFast();
      },
    };

    const endStreams = () => {
      try {
        stdout.end();
      } catch {
        // Already ended.
      }
      try {
        stderr.end();
      } catch {
        // Already ended.
      }
    };
    const exitViaWait = command.wait().then((result) => result.exitCode);
    // The SDK never ends the writables itself: end them once the command is
    // gone (post-drain) so the driver can classify a crash-without-result.
    void exitViaWait
      .catch(() => undefined)
      .then(() => {
        const timer = setTimeout(endStreams, STREAM_DRAIN_MS);
        if (typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
      });
    const streamEnded = (stream: PassThrough) =>
      new Promise<void>((resolve) => {
        stream.once("end", () => resolve());
        stream.once("close", () => resolve());
      });
    const exit = new Promise<number | null>((resolve, reject) => {
      let settled = false;
      const settleWith =
        <T>(settle: (value: T) => void) =>
        (value: T) => {
          if (!settled) {
            settled = true;
            settle(value);
          }
        };
      const resolveOnce = settleWith(resolve);
      const rejectOnce = settleWith(reject);

      resolveExitFast = () => resolveOnce(0);
      exitViaWait.then(resolveOnce, rejectOnce);
      void Promise.all([streamEnded(stdout), streamEnded(stderr)]).then(() => {
        const timer = setTimeout(() => resolveOnce(0), exitFallbackMs);
        if (typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
      });
    });
    // The driver races consumers over `exit`; never surface an unhandled
    // rejection when only the failure path awaits it.
    exit.catch(() => {});

    let stopped = false;

    return {
      stdin,
      stdout,
      stderr,
      exit,
      async stop() {
        if (stopped) {
          return;
        }
        stopped = true;
        try {
          await command.kill("SIGKILL");
        } catch {
          // The command may already be gone; VM teardown below is what counts.
        }
        try {
          await workspace.stopSandbox();
        } catch {
          // Teardown must never mask the execution result; a real stop
          // failure resurfaces through workspace.cleanup().
        }
      },
    };
  };
}

export class VercelPublishedInteractionSandboxProvider
  implements PublishedInteractionSandboxProvider
{
  private readonly provider: PublishedInteractionSandboxProvider;

  constructor(options: { exitFallbackMs?: number } = {}) {
    this.provider = createTransportSandboxProvider(
      createVercelSandboxRunnerSpawner(options),
    );
  }

  execute(
    request: PublishedInteractionSandboxProviderExecuteRequest,
  ): Promise<PublishedInteractionExecutionResult> {
    return this.provider.execute(request);
  }
}

/**
 * The Vercel Sandbox backend: one ephemeral microVM per invoke, egress
 * denied for generated code, destroyed at the end of the call. Selecting the
 * workspace factory and provider as one unit is what guarantees both halves
 * drive the same VM.
 */
export function createVercelSandboxBackend(
  options: CreateVercelSandboxBackendOptions = {},
): SandboxBackend {
  return {
    name: VERCEL_SANDBOX_BACKEND_NAME,
    workspaceFactory: new VercelPublishedInteractionSandboxWorkspaceFactory(
      options,
    ),
    provider: new VercelPublishedInteractionSandboxProvider({
      ...(options.exitFallbackMs === undefined
        ? {}
        : { exitFallbackMs: options.exitFallbackMs }),
    }),
  };
}
