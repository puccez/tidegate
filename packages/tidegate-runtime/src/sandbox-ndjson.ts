/**
 * Host-side sandbox protocol driver.
 *
 * `SandboxProtocolDriver` owns everything protocol-shaped on the host side of
 * the sandbox seam: the NDJSON read/write loop, action-call mediation
 * (token + max-action-call checks via `createSandboxActionCallMediator`),
 * the execution timeout, and result normalization. Backends supply only a
 * pure transport (`SpawnSandboxRunner` returning a `SandboxRunnerTransport`)
 * that moves bytes and can be stopped; the driver calls `stop()` in a
 * `finally` so a timed-out or crashed runner is always torn down.
 *
 * Because every process-shaped backend reuses this driver verbatim, protocol
 * equivalence across backends holds by construction.
 */
import {
  InvokeInteractionErrorCodeSchema,
  type InvokeInteractionErrorCode,
} from "@tidegate/contracts";
import type {
  PublishedInteractionExecutionPayload,
  PublishedInteractionExecutionResult,
  PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor.ts";
import type {
  PublishedInteractionSandboxProvider,
  PublishedInteractionSandboxProviderExecuteRequest,
} from "./sandbox-backend.ts";
import type { SandboxRunnerErrorStatus } from "./sandbox-runner-core.ts";

const SANDBOX_SHUTDOWN_GRACE_MS = 250;

export type SandboxActionCallMessage = {
  type: "action_call";
  callId: string;
  actionCallToken: string;
  actionId: string;
  input: unknown;
};

export type SandboxResultMessage = {
  type: "result";
  output: unknown;
};

export type SandboxErrorMessage = {
  type: "error";
  code?: unknown;
  status?: unknown;
  message?: unknown;
  retryable?: unknown;
};

export type SandboxStdoutMessage =
  | SandboxActionCallMessage
  | SandboxResultMessage
  | SandboxErrorMessage;

export type SandboxStdinMessage =
  | {
      type: "start";
      input: unknown;
      auth: PublishedInteractionExecutionPayload["auth"];
      capabilities: PublishedInteractionExecutionPayload["capabilities"];
      invocationId: string;
      actionCallToken: string;
    }
  | {
      type: "action_result";
      callId: string;
      ok: true;
      output: unknown;
    }
  | {
      type: "action_result";
      callId: string;
      ok: false;
      error: SandboxActionCallError;
    };

export type SandboxProcessStdin = {
  write: (chunk: string | Uint8Array) => unknown;
  end: () => unknown;
};

export type SandboxProcessReadable =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>;

/**
 * The pure transport a sandbox backend supplies: byte streams to and from a
 * runner executing `tidegate-runner.mjs`, plus mandatory teardown.
 */
export type SandboxRunnerTransport = {
  stdin: SandboxProcessStdin;
  stdout: SandboxProcessReadable;
  stderr: SandboxProcessReadable;
  /**
   * Resolves with the runner exit code once it terminates; rejects if the
   * runner failed to start.
   */
  exit: Promise<number | null>;
  /**
   * Mandatory teardown (kill the process / stop the VM). The protocol driver
   * calls it in a `finally`, so a timed-out runner never keeps running. Must
   * be idempotent and safe after normal exit.
   */
  stop: () => Promise<void>;
};

export type SpawnSandboxRunner = (
  request: PublishedInteractionSandboxProviderExecuteRequest,
) => Promise<SandboxRunnerTransport> | SandboxRunnerTransport;

export type SandboxActionCallError = {
  code: InvokeInteractionErrorCode;
  status: SandboxRunnerErrorStatus;
  message: string;
  retryable?: boolean;
};

export type SandboxActionCallOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: SandboxActionCallError };

export type SandboxActionCallMediator = {
  call: (request: {
    actionCallToken: string;
    actionId: string;
    input: unknown;
  }) => Promise<SandboxActionCallOutcome>;
};

/**
 * Host-side action-call mediation shared by every backend: token check,
 * max-action-call budget, delegation to the trusted runtime, and error
 * normalization. Extracted so an in-process backend enforces exactly the
 * same rules as the NDJSON loop.
 */
export function createSandboxActionCallMediator({
  payload,
  runtime,
}: {
  payload: PublishedInteractionExecutionPayload;
  runtime: PublishedInteractionTrustedRuntime;
}): SandboxActionCallMediator {
  let actionCalls = 0;

  return {
    async call({ actionCallToken, actionId, input }) {
      if (actionCallToken !== payload.actionCallToken) {
        return {
          ok: false,
          error: {
            code: "action_not_allowed",
            status: "rejected",
            message:
              "This action call token is not valid for this invocation.",
          },
        };
      }

      actionCalls += 1;

      if (actionCalls > payload.timeout.maxActionCalls) {
        return {
          ok: false,
          error: {
            code: "action_not_allowed",
            status: "rejected",
            message: "This interaction exceeded its action call limit.",
          },
        };
      }

      try {
        const output = await runtime.callAction({
          invocationId: payload.invocationId,
          actionCallToken: payload.actionCallToken,
          actionId,
          input,
        });

        return { ok: true, output };
      } catch (error) {
        const normalized = normalizeThrownError(error);
        const retryable =
          isRecord(error) && typeof error.retryable === "boolean"
            ? error.retryable
            : undefined;

        return {
          ok: false,
          error: {
            code: normalized.code,
            status: normalized.status,
            message:
              error instanceof Error ? error.message : "Action call failed.",
            ...(retryable === undefined ? {} : { retryable }),
          },
        };
      }
    },
  };
}

export class SandboxProtocolDriver {
  private readonly spawnRunner: SpawnSandboxRunner;

  constructor({ spawnRunner }: { spawnRunner: SpawnSandboxRunner }) {
    this.spawnRunner = spawnRunner;
  }

  async execute(
    request: PublishedInteractionSandboxProviderExecuteRequest,
  ): Promise<PublishedInteractionExecutionResult> {
    const { payload, runtime } = request;
    let transport: SandboxRunnerTransport;

    try {
      transport = await this.spawnRunner(request);
    } catch (error) {
      return failedResult(
        "interaction_failed",
        error instanceof Error
          ? error.message
          : "Sandbox runner failed to start.",
      );
    }

    const stop = async () => {
      try {
        await transport.stop();
      } catch {
        // Teardown must never mask the execution result.
      }
    };

    try {
      const startFailure = new Promise<PublishedInteractionExecutionResult>(
        (resolve) => {
          transport.exit.catch((error: unknown) => {
            resolve(
              failedResult(
                "interaction_failed",
                error instanceof Error
                  ? error.message
                  : "Sandbox process failed to start.",
              ),
            );
          });
        },
      );
      // `.catch` at creation: this promise is only awaited on the
      // nonzero-exit path, so a stderr stream error must never become an
      // unhandled rejection on the other paths.
      const stderrText = readStreamText(transport.stderr).catch(() => "");
      const stdoutResult = consumeSandboxStdout({
        payload,
        runtime,
        stdin: transport.stdin,
        stdout: transport.stdout,
      });

      await writeSandboxMessage(transport.stdin, {
        type: "start",
        input: payload.input,
        auth: payload.auth,
        capabilities: payload.capabilities,
        invocationId: payload.invocationId,
        actionCallToken: payload.actionCallToken,
      });

      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<PublishedInteractionExecutionResult>(
        (resolve) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            void stop();
            resolve(
              timedOutResult("The interaction exceeded its execution timeout."),
            );
          }, payload.timeout.executionMs);
        },
      );

      const result = await Promise.race([stdoutResult, startFailure, timeout]);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      try {
        transport.stdin.end();
      } catch {
        // The sandbox may already be gone after a timeout or syntax failure.
      }

      const exitCode = await Promise.race([
        transport.exit.catch(() => undefined),
        delay(SANDBOX_SHUTDOWN_GRACE_MS).then(() => {
          void stop();
          return undefined;
        }),
      ]);

      if (!timedOut && result.status === "ok" && exitCode !== 0) {
        const details = await stderrText;

        return failedResult(
          "interaction_failed",
          details.trim() || "Sandbox process exited before returning output.",
        );
      }

      return result;
    } finally {
      await stop();
    }
  }
}

/**
 * Wraps a pure transport into a `PublishedInteractionSandboxProvider` by
 * pairing it with the shared protocol driver. This is the only glue a
 * process-shaped backend needs.
 */
export function createTransportSandboxProvider(
  spawnRunner: SpawnSandboxRunner,
): PublishedInteractionSandboxProvider {
  const driver = new SandboxProtocolDriver({ spawnRunner });

  return {
    execute: (request) => driver.execute(request),
  };
}

async function consumeSandboxStdout({
  payload,
  runtime,
  stdin,
  stdout,
}: {
  payload: PublishedInteractionExecutionPayload;
  runtime: PublishedInteractionTrustedRuntime;
  stdin: SandboxProcessStdin;
  stdout: SandboxProcessReadable;
}): Promise<PublishedInteractionExecutionResult> {
  const mediator = createSandboxActionCallMediator({ payload, runtime });
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of readStreamChunks(stdout)) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      const message = parseSandboxStdoutMessage(line);

      if (!message) {
        return failedResult(
          "interaction_failed",
          "Sandbox process returned an invalid protocol message.",
        );
      }

      switch (message.type) {
        case "action_call": {
          const outcome = await mediator.call({
            actionCallToken: message.actionCallToken,
            actionId: message.actionId,
            input: message.input,
          });

          if (outcome.ok) {
            await writeSandboxMessage(stdin, {
              type: "action_result",
              callId: message.callId,
              ok: true,
              output: outcome.output,
            });
          } else {
            await writeSandboxMessage(stdin, {
              type: "action_result",
              callId: message.callId,
              ok: false,
              error: outcome.error,
            });
          }
          break;
        }
        case "error":
          return resultFromSandboxError(message);
        case "result":
          return {
            status: "ok",
            output: message.output,
          };
      }
    }
  }
  buffer += decoder.decode();

  return failedResult(
    "interaction_failed",
    "Sandbox process exited without returning a structured result.",
  );
}

export function parseSandboxStdoutMessage(
  line: string,
): SandboxStdoutMessage | undefined {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  if (value.type === "action_call") {
    if (
      typeof value.callId !== "string" ||
      typeof value.actionCallToken !== "string" ||
      typeof value.actionId !== "string"
    ) {
      return undefined;
    }

    return {
      type: "action_call",
      callId: value.callId,
      actionCallToken: value.actionCallToken,
      actionId: value.actionId,
      input: value.input,
    };
  }

  if (value.type === "result") {
    return {
      type: "result",
      output: value.output,
    };
  }

  if (value.type === "error") {
    return {
      type: "error",
      code: value.code,
      status: value.status,
      message: value.message,
      retryable: value.retryable,
    };
  }

  return undefined;
}

async function writeSandboxMessage(
  stdin: SandboxProcessStdin,
  message: SandboxStdinMessage,
): Promise<void> {
  try {
    stdin.write(`${JSON.stringify(message)}\n`);
  } catch {
    // The runner can die mid-protocol (e.g. while the host replies to an
    // action_call). A failed write must not crash the host: the driver
    // already normalizes the outcome via stdout end / exit code / timeout.
  }
}

async function readStreamText(stream: SandboxProcessReadable): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";

  for await (const chunk of readStreamChunks(stream)) {
    text +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
  }

  return text + decoder.decode();
}

async function* readStreamChunks(
  stream: SandboxProcessReadable,
): AsyncGenerator<Uint8Array | string> {
  if ("getReader" in stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          return;
        }

        yield value;
      }
    } finally {
      reader.releaseLock();
    }

    return;
  }

  yield* stream;
}

export function normalizeThrownError(error: unknown): {
  code: InvokeInteractionErrorCode;
  status: SandboxRunnerErrorStatus;
} {
  if (!isRecord(error)) {
    return {
      code: "interaction_failed",
      status: "failed",
    };
  }

  const code = parseInvokeErrorCode(error.code);
  const status =
    error.status === "rejected" || error.status === "failed"
      ? error.status
      : code === "action_not_allowed" || code === "action_not_registered"
        ? "rejected"
        : "failed";

  return {
    code,
    status,
  };
}

export function resultFromSandboxError(
  error: SandboxErrorMessage,
): PublishedInteractionExecutionResult {
  const code = parseInvokeErrorCode(error.code);
  const message =
    typeof error.message === "string" && error.message.length > 0
      ? error.message
      : "Published interaction sandbox execution failed.";
  const retryable =
    typeof error.retryable === "boolean" ? error.retryable : undefined;

  if (code === "interaction_timeout" || error.status === "timed_out") {
    return timedOutResult(message, retryable);
  }

  return {
    status: error.status === "rejected" ? "rejected" : "failed",
    error: {
      code,
      message,
      retryable,
    },
  };
}

export function parseInvokeErrorCode(code: unknown): InvokeInteractionErrorCode {
  const result = InvokeInteractionErrorCodeSchema.safeParse(code);

  return result.success ? result.data : "interaction_failed";
}

export function rejectedResult(
  code: InvokeInteractionErrorCode,
  message: string,
): PublishedInteractionExecutionResult {
  return {
    status: "rejected",
    error: {
      code,
      message,
      retryable: false,
    },
  };
}

export function failedResult(
  code: InvokeInteractionErrorCode,
  message: string,
): PublishedInteractionExecutionResult {
  return {
    status: "failed",
    error: {
      code,
      message,
      retryable: false,
    },
  };
}

export function timedOutResult(
  message: string,
  retryable = false,
): PublishedInteractionExecutionResult {
  return {
    status: "timed_out",
    error: {
      code: "interaction_timeout",
      message,
      retryable,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
