import { describe, expect, test } from "bun:test";
import {
  PublishedInteractionArtifactSchema,
  type PublishedInteractionArtifact,
} from "@tidegate/contracts";
import { cancelAppointmentPublishedArtifact } from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog";
import {
  createPublishedInteractionActionCallToken,
  createPublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionPayload,
  type PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor";
import type { PublishedInteractionSandboxWorkspace } from "./sandbox-backend";
import {
  SandboxProtocolDriver,
  type SandboxRunnerTransport,
  type SandboxStdinMessage,
} from "./sandbox-ndjson";

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

function createPayload(
  overrides: Partial<PublishedInteractionArtifact> = {},
): PublishedInteractionExecutionPayload {
  const artifact = PublishedInteractionArtifactSchema.parse({
    ...structuredClone(cancelAppointmentPublishedArtifact),
    ...overrides,
  });

  return createPublishedInteractionExecutionPayload({
    actionCallToken: createPublishedInteractionActionCallToken(
      "invoke_sandbox_ndjson",
    ),
    artifact,
    auth,
    input: { appointmentId: "apt_123" },
    invocationId: "invoke_sandbox_ndjson",
  });
}

const workspace: PublishedInteractionSandboxWorkspace = {
  rootPath: "/tmp/tidegate-ndjson-test",
  writeTextFile() {},
  async cleanup() {},
};

type ScriptedTransport = {
  transport: SandboxRunnerTransport;
  writtenMessages: () => SandboxStdinMessage[];
  stopCalls: () => number;
};

function createScriptedTransport({
  exitCode = 0,
  frames,
  hang = false,
  stderr = "",
}: {
  exitCode?: number | Promise<number>;
  frames: readonly unknown[];
  hang?: boolean;
  stderr?: string;
}): ScriptedTransport {
  const writes: string[] = [];
  let stopCalls = 0;
  let stopped: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    stopped = resolve;
  });

  async function* stdout() {
    for (const frame of frames) {
      yield typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`;
    }
    if (hang) {
      // A runaway runner never closes stdout until it is stopped.
      await stoppedPromise;
    }
  }

  async function* stderrStream() {
    if (stderr.length > 0) {
      yield stderr;
    }
  }

  return {
    transport: {
      stdin: {
        write(chunk) {
          writes.push(
            typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
          );
        },
        end() {},
      },
      stdout: stdout(),
      stderr: stderrStream(),
      exit:
        typeof exitCode === "number" ? Promise.resolve(exitCode) : exitCode,
      async stop() {
        stopCalls += 1;
        stopped?.();
      },
    },
    writtenMessages: () =>
      writes
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SandboxStdinMessage),
    stopCalls: () => stopCalls,
  };
}

function recordingRuntime(
  output: unknown = { ok: true, appointmentId: "apt_123" },
): PublishedInteractionTrustedRuntime & { calls: unknown[] } {
  const calls: unknown[] = [];

  return {
    calls,
    async callAction(request) {
      calls.push(request);
      return output;
    },
  };
}

describe("SandboxProtocolDriver", () => {
  test("writes the start frame and returns the runner result", async () => {
    const payload = createPayload();
    const scripted = createScriptedTransport({
      frames: [{ type: "result", output: { ok: true } }],
    });
    const driver = new SandboxProtocolDriver({
      spawnRunner: () => scripted.transport,
    });

    const result = await driver.execute({
      payload,
      runnerPath: "tidegate-runner.mjs",
      runtime: recordingRuntime(),
      workspace,
    });

    expect(result).toEqual({ status: "ok", output: { ok: true } });
    expect(scripted.writtenMessages()).toEqual([
      {
        type: "start",
        input: payload.input,
        auth: payload.auth,
        capabilities: payload.capabilities,
        invocationId: payload.invocationId,
        actionCallToken: payload.actionCallToken,
      } as SandboxStdinMessage,
    ]);
    // stop() is mandatory even on the happy path.
    expect(scripted.stopCalls()).toBeGreaterThanOrEqual(1);
  });

  test("mediates action calls and echoes the runner-generated callId", async () => {
    const payload = createPayload();
    const runtime = recordingRuntime({ ok: true, appointmentId: "apt_123" });
    const scripted = createScriptedTransport({
      frames: [
        {
          type: "action_call",
          callId: "action_1",
          actionCallToken: payload.actionCallToken,
          actionId: "booking.cancel",
          input: { appointmentId: "apt_123" },
        },
        { type: "result", output: { ok: true } },
      ],
    });
    const driver = new SandboxProtocolDriver({
      spawnRunner: () => scripted.transport,
    });

    const result = await driver.execute({
      payload,
      runnerPath: "tidegate-runner.mjs",
      runtime,
      workspace,
    });

    expect(result.status).toBe("ok");
    expect(runtime.calls).toEqual([
      {
        invocationId: payload.invocationId,
        actionCallToken: payload.actionCallToken,
        actionId: "booking.cancel",
        input: { appointmentId: "apt_123" },
      },
    ]);
    const actionResults = scripted
      .writtenMessages()
      .filter((message) => message.type === "action_result");
    expect(actionResults).toEqual([
      {
        type: "action_result",
        callId: "action_1",
        ok: true,
        output: { ok: true, appointmentId: "apt_123" },
      },
    ]);
    // callId shape, not value: runner-generated ids look like action_<n>.
    expect(actionResults[0]?.callId).toMatch(/^action_\d+$/);
  });

  test("rejects forged action-call tokens without reaching the runtime", async () => {
    const payload = createPayload();
    const runtime = recordingRuntime();
    const scripted = createScriptedTransport({
      frames: [
        {
          type: "action_call",
          callId: "action_1",
          actionCallToken: "forged-token",
          actionId: "booking.cancel",
          input: {},
        },
        {
          type: "error",
          code: "action_not_allowed",
          status: "rejected",
          message: "This action call token is not valid for this invocation.",
        },
      ],
    });
    const driver = new SandboxProtocolDriver({
      spawnRunner: () => scripted.transport,
    });

    const result = await driver.execute({
      payload,
      runnerPath: "tidegate-runner.mjs",
      runtime,
      workspace,
    });

    expect(runtime.calls).toHaveLength(0);
    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "action_not_allowed" },
    });
    expect(scripted.writtenMessages()).toContainEqual({
      type: "action_result",
      callId: "action_1",
      ok: false,
      error: {
        code: "action_not_allowed",
        status: "rejected",
        message: "This action call token is not valid for this invocation.",
      },
    } as SandboxStdinMessage);
  });

  test("enforces the max action call budget", async () => {
    const payload = createPayload();
    const runtime = recordingRuntime();
    const actionCall = (callId: string) => ({
      type: "action_call",
      callId,
      actionCallToken: payload.actionCallToken,
      actionId: "booking.cancel",
      input: {},
    });
    const scripted = createScriptedTransport({
      frames: [
        actionCall("action_1"),
        actionCall("action_2"),
        {
          type: "error",
          code: "action_not_allowed",
          status: "rejected",
          message: "This interaction exceeded its action call limit.",
        },
      ],
    });
    const driver = new SandboxProtocolDriver({
      spawnRunner: () => scripted.transport,
    });

    const result = await driver.execute({
      payload,
      runnerPath: "tidegate-runner.mjs",
      runtime,
      workspace,
    });

    expect(runtime.calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "action_not_allowed" },
    });
    expect(scripted.writtenMessages()).toContainEqual({
      type: "action_result",
      callId: "action_2",
      ok: false,
      error: {
        code: "action_not_allowed",
        status: "rejected",
        message: "This interaction exceeded its action call limit.",
      },
    } as SandboxStdinMessage);
  });

  test("failed action results propagate the runtime's retryable flag", async () => {
    const payload = createPayload();
    const scripted = createScriptedTransport({
      frames: [
        {
          type: "action_call",
          callId: "action_1",
          actionCallToken: payload.actionCallToken,
          actionId: "booking.cancel",
          input: {},
        },
        {
          type: "error",
          code: "interaction_failed",
          status: "failed",
          message: "upstream flaked",
          retryable: true,
        },
      ],
    });
    const runtime: PublishedInteractionTrustedRuntime = {
      async callAction() {
        throw Object.assign(new Error("upstream flaked"), {
          code: "interaction_failed",
          status: "failed",
          retryable: true,
        });
      },
    };
    const driver = new SandboxProtocolDriver({
      spawnRunner: () => scripted.transport,
    });

    const result = await driver.execute({
      payload,
      runnerPath: "tidegate-runner.mjs",
      runtime,
      workspace,
    });

    expect(scripted.writtenMessages()).toContainEqual({
      type: "action_result",
      callId: "action_1",
      ok: false,
      error: {
        code: "interaction_failed",
        status: "failed",
        message: "upstream flaked",
        retryable: true,
      },
    } as SandboxStdinMessage);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "interaction_failed", retryable: true },
    });
  });

  test("a stdin write failure mid action reply normalizes instead of crashing", async () => {
    const payload = createPayload();
    let writes = 0;
    async function* stdout() {
      yield `${JSON.stringify({
        type: "action_call",
        callId: "action_1",
        actionCallToken: payload.actionCallToken,
        actionId: "booking.cancel",
        input: {},
      })}\n`;
    }
    // eslint-disable-next-line require-yield -- an intentionally silent stderr
    async function* stderrStream(): AsyncGenerator<string> {}
    const transport: SandboxRunnerTransport = {
      stdin: {
        write() {
          writes += 1;
          if (writes > 1) {
            // The runner died between issuing the action_call and the reply.
            throw new Error("write after destroy (ERR_STREAM_DESTROYED)");
          }
        },
        end() {},
      },
      stdout: stdout(),
      stderr: stderrStream(),
      exit: Promise.resolve(1),
      async stop() {},
    };
    const driver = new SandboxProtocolDriver({ spawnRunner: () => transport });

    const result = await driver.execute({
      payload,
      runnerPath: "tidegate-runner.mjs",
      runtime: recordingRuntime(),
      workspace,
    });

    expect(writes).toBe(2);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "interaction_failed" },
    });
  });

  test("a stderr stream error is contained on the happy path", async () => {
    async function* stdout() {
      yield `${JSON.stringify({ type: "result", output: { ok: true } })}\n`;
    }
    async function* stderrStream(): AsyncGenerator<string> {
      throw new Error("stderr pipe broke");
    }
    const transport: SandboxRunnerTransport = {
      stdin: { write() {}, end() {} },
      stdout: stdout(),
      stderr: stderrStream(),
      exit: Promise.resolve(0),
      async stop() {},
    };
    const driver = new SandboxProtocolDriver({ spawnRunner: () => transport });

    const result = await driver.execute({
      payload: createPayload(),
      runnerPath: "tidegate-runner.mjs",
      runtime: recordingRuntime(),
      workspace,
    });

    // The stderr promise is never awaited on this path; without a rejection
    // handler attached at creation this run dies with an unhandled rejection.
    expect(result).toEqual({ status: "ok", output: { ok: true } });
  });

  test("fails closed on invalid protocol frames", async () => {
    const scripted = createScriptedTransport({
      frames: ["this is not json\n"],
    });
    const driver = new SandboxProtocolDriver({
      spawnRunner: () => scripted.transport,
    });

    const result = await driver.execute({
      payload: createPayload(),
      runnerPath: "tidegate-runner.mjs",
      runtime: recordingRuntime(),
      workspace,
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "interaction_failed" },
    });
  });

  test("stops a silent runner on timeout", async () => {
    const payload = createPayload({
      timeout: {
        ...cancelAppointmentPublishedArtifact.timeout,
        executionMs: 20,
      },
    });
    const scripted = createScriptedTransport({
      frames: [],
      hang: true,
      exitCode: new Promise<number>(() => {}),
    });
    const driver = new SandboxProtocolDriver({
      spawnRunner: () => scripted.transport,
    });

    const result = await driver.execute({
      payload,
      runnerPath: "tidegate-runner.mjs",
      runtime: recordingRuntime(),
      workspace,
    });

    expect(result).toMatchObject({
      status: "timed_out",
      error: { code: "interaction_timeout" },
    });
    expect(scripted.stopCalls()).toBeGreaterThanOrEqual(1);
  });

  test("surfaces spawn failures as failed results", async () => {
    const driver = new SandboxProtocolDriver({
      spawnRunner: () => {
        throw new Error("spawn node ENOENT");
      },
    });

    const result = await driver.execute({
      payload: createPayload(),
      runnerPath: "tidegate-runner.mjs",
      runtime: recordingRuntime(),
      workspace,
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "interaction_failed", message: "spawn node ENOENT" },
    });
  });

  test("reports stderr when the runner exits non-zero without a result frame error", async () => {
    const scripted = createScriptedTransport({
      frames: [{ type: "result", output: { ok: true } }],
      exitCode: 1,
      stderr: "SyntaxError: unexpected token",
    });
    const driver = new SandboxProtocolDriver({
      spawnRunner: () => scripted.transport,
    });

    const result = await driver.execute({
      payload: createPayload(),
      runnerPath: "tidegate-runner.mjs",
      runtime: recordingRuntime(),
      workspace,
    });

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "interaction_failed",
        message: "SyntaxError: unexpected token",
      },
    });
  });
});
