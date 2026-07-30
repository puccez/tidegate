import { describe, expect, test } from "bun:test";
import { cancelAppointmentPublishedArtifact } from "@tidegate/contracts/fixtures";
import {
  createPublishedInteractionActionCallToken,
  createPublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionPayload,
} from "./published-interaction-executor.ts";
import {
  createVercelSandboxFeederScript,
  createVercelSandboxRunnerSpawner,
  resolveVercelSandboxCredentials,
  resolveVercelSandboxVmTimeoutMs,
  VercelPublishedInteractionSandboxWorkspace,
  VercelPublishedInteractionSandboxWorkspaceFactory,
  type VercelSandboxClient,
  type VercelSandboxCommandHandle,
  type VercelSandboxCreateParams,
} from "./sandbox-backend-vercel.ts";

type WrittenFile = { path: string; content: string };

function createFakeClient(overrides: Partial<VercelSandboxClient> = {}) {
  const written: WrittenFile[] = [];
  const directories: string[] = [];
  let stopCalls = 0;
  const commandHandle: VercelSandboxCommandHandle = {
    kill: async () => {},
    wait: () => new Promise<{ exitCode: number }>(() => {}),
    // Pending forever: tests that need stream end drive it explicitly.
    logs: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<
            IteratorResult<{ data: string; stream: "stdout" | "stderr" }>
          >(() => {}),
      }),
    }),
  };
  const runs: Array<
    Parameters<VercelSandboxClient["runCommand"]>[0]
  > = [];

  const client: VercelSandboxClient = {
    name: "sbx_fake_1",
    writeFiles: async (files) => {
      written.push(...files.map(({ path, content }) => ({ path, content })));
    },
    mkDir: async (path) => {
      directories.push(path);
    },
    runCommand: async (params) => {
      runs.push(params);
      return commandHandle;
    },
    stop: async () => {
      stopCalls += 1;
    },
    ...overrides,
  };

  return {
    client,
    written,
    directories,
    runs,
    getStopCalls: () => stopCalls,
  };
}

function createPayload(executionMs = 5_000): PublishedInteractionExecutionPayload {
  return createPublishedInteractionExecutionPayload({
    actionCallToken: createPublishedInteractionActionCallToken("vercel_unit"),
    artifact: {
      ...structuredClone(cancelAppointmentPublishedArtifact),
      timeout: {
        ...cancelAppointmentPublishedArtifact.timeout,
        executionMs,
      },
    },
    auth: {
      authMode: "api-key",
      organizationId: "demo-salon",
      tenantId: "demo-salon",
      subjectId: "api_key_demo",
      subjectType: "api_key",
      credentialId: "api_key_demo",
      credentialType: "api_key",
      scopes: ["tidegate:interaction:invoke"],
      permissions: ["booking:write"],
      authorization: { permissions: ["booking:write"], resourceGrants: [] },
    },
    input: {},
    invocationId: "vercel_unit",
  });
}

describe("resolveVercelSandboxVmTimeoutMs", () => {
  test("keeps a floor so allocation never starves short executions", () => {
    expect(resolveVercelSandboxVmTimeoutMs(50)).toBe(60_050);
    expect(resolveVercelSandboxVmTimeoutMs(0)).toBeGreaterThanOrEqual(60_000);
  });

  test("adds the margin on top of realistic execution timeouts", () => {
    expect(resolveVercelSandboxVmTimeoutMs(30_000)).toBe(90_000);
  });

  test("always outlives long execution timeouts (never expires before the driver)", () => {
    expect(resolveVercelSandboxVmTimeoutMs(600_000)).toBe(660_000);
    expect(resolveVercelSandboxVmTimeoutMs(3_600_000)).toBe(3_660_000);
  });
});

describe("resolveVercelSandboxCredentials", () => {
  test("explicit backend credentials win", () => {
    expect(
      resolveVercelSandboxCredentials(
        { token: "tok", teamId: "team", projectId: "proj" },
        { VERCEL_TOKEN: "env-tok" },
      ),
    ).toEqual({ token: "tok", teamId: "team", projectId: "proj" });
  });

  test("the documented VERCEL_TOKEN triple is honored (the SDK only auto-reads OIDC)", () => {
    expect(
      resolveVercelSandboxCredentials(
        {},
        {
          VERCEL_TOKEN: "tok",
          VERCEL_TEAM_ID: "team",
          VERCEL_PROJECT_ID: "proj",
        },
      ),
    ).toEqual({ token: "tok", teamId: "team", projectId: "proj" });
  });

  test("an incomplete triple falls back to ambient OIDC (no partial credentials)", () => {
    expect(
      resolveVercelSandboxCredentials(
        {},
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team" },
      ),
    ).toEqual({});
  });

  test("blank placeholder values never masquerade as explicit credentials", () => {
    expect(
      resolveVercelSandboxCredentials(
        {},
        { VERCEL_TOKEN: "", VERCEL_TEAM_ID: "", VERCEL_PROJECT_ID: "" },
      ),
    ).toEqual({});
    expect(
      resolveVercelSandboxCredentials(
        {},
        {
          VERCEL_TOKEN: "  ",
          VERCEL_TEAM_ID: "team",
          VERCEL_PROJECT_ID: "proj",
        },
      ),
    ).toEqual({});
  });
});

describe("vercel sandbox feeder script", () => {
  test("consumes only complete, newline-terminated message files in order", () => {
    const script = createVercelSandboxFeederScript("/proto/stdin");

    expect(script).toContain('f="/proto/stdin/msg-$i"');
    // Non-empty + newline-terminated gate: a partially-visible write is
    // never forwarded to the runner.
    expect(script).toContain('[ -s "$f" ]');
    expect(script).toContain("tail -c 1");
    expect(script).toContain("i=$((i+1))");
    expect(script).toContain('[ -f "/proto/stdin/closed" ]');
    expect(script).toContain("exit 0");
    // The idle heartbeat keeps the SDK log stream flowing so lone protocol
    // lines are never held back by a lazy flush.
    expect(script).toContain("tg-feeder-alive");
  });
});

describe("VercelPublishedInteractionSandboxWorkspace", () => {
  test("writes workspace files under the workspace root", async () => {
    const { client, written } = createFakeClient();
    const workspace = new VercelPublishedInteractionSandboxWorkspace(client);

    await workspace.writeTextFile({
      path: "interaction.generated.mjs",
      content: "export default 1;",
    });

    expect(written).toEqual([
      {
        path: "/vercel/sandbox/tidegate-workspace/interaction.generated.mjs",
        content: "export default 1;",
      },
    ]);
    expect(workspace.sandboxId).toBe("sbx_fake_1");
  });

  test("rejects traversal and absolute paths before touching the VM", async () => {
    const { client, written } = createFakeClient();
    const workspace = new VercelPublishedInteractionSandboxWorkspace(client);

    for (const path of ["../escape.mjs", "nested/../../escape.mjs", "/etc/passwd"]) {
      await expect(
        workspace.writeTextFile({ path, content: "malicious" }),
      ).rejects.toThrow();
    }
    expect(written).toEqual([]);
  });

  test("cleanup stops the VM exactly once across cleanup and transport stop", async () => {
    const { client, getStopCalls } = createFakeClient();
    const workspace = new VercelPublishedInteractionSandboxWorkspace(client);

    await Promise.all([workspace.cleanup(), workspace.stopSandbox()]);
    await workspace.cleanup();

    expect(getStopCalls()).toBe(1);
  });
});

describe("VercelPublishedInteractionSandboxWorkspaceFactory", () => {
  test("allocates a deny-all Node 24 VM sized around the execution timeout", async () => {
    const requests: VercelSandboxCreateParams[] = [];
    const { client } = createFakeClient();
    const factory = new VercelPublishedInteractionSandboxWorkspaceFactory({
      createSandbox: async (params) => {
        requests.push(params);
        return client;
      },
    });

    const workspace = await factory.createWorkspace(createPayload(30_000));

    expect(requests).toEqual([
      {
        runtime: "node24",
        timeout: 90_000,
        networkPolicy: "deny-all",
        // One VM = one invoke: never resumed, so never snapshotted on stop.
        persistent: false,
      },
    ]);
    expect(workspace.rootPath).toBe("/vercel/sandbox/tidegate-workspace");
  });

  test("prepares workspace, protocol dir, and feeder before first use", async () => {
    const { client, directories, written } = createFakeClient();
    const factory = new VercelPublishedInteractionSandboxWorkspaceFactory({
      createSandbox: async () => client,
    });

    await factory.createWorkspace(createPayload());

    expect(directories).toEqual([
      "/vercel/sandbox/tidegate-workspace",
      "/vercel/sandbox/tidegate-protocol",
      "/vercel/sandbox/tidegate-protocol/stdin",
    ]);
    expect(written.map((file) => file.path)).toEqual([
      "/vercel/sandbox/tidegate-protocol/feeder.sh",
    ]);
  });

  test("stops the VM instead of leaking it when preparation fails", async () => {
    const { client, getStopCalls } = createFakeClient({
      mkDir: async () => {
        throw new Error("mkdir failed");
      },
    });
    const factory = new VercelPublishedInteractionSandboxWorkspaceFactory({
      createSandbox: async () => client,
    });

    await expect(factory.createWorkspace(createPayload())).rejects.toThrow(
      "mkdir failed",
    );
    expect(getStopCalls()).toBe(1);
  });
});

describe("vercel sandbox runner transport", () => {
  async function spawnWithFakes({
    client,
    exitFallbackMs,
  }: {
    client: VercelSandboxClient;
    exitFallbackMs?: number;
  }) {
    const workspace = new VercelPublishedInteractionSandboxWorkspace(client);
    const spawner = createVercelSandboxRunnerSpawner(
      exitFallbackMs === undefined ? {} : { exitFallbackMs },
    );

    const transport = await spawner({
      workspace,
      runnerPath: "tidegate-runner.mjs",
      payload: createPayload(),
      runtime: {
        callAction: async () => {
          throw new Error("unused");
        },
      },
    });

    return { transport, workspace };
  }

  test("refuses a workspace from a different backend (paired seam)", async () => {
    const spawner = createVercelSandboxRunnerSpawner();

    await expect(
      spawner({
        workspace: {
          rootPath: "/tmp/elsewhere",
          writeTextFile: async () => {},
          cleanup: async () => {},
        },
        runnerPath: "tidegate-runner.mjs",
        payload: createPayload(),
        runtime: {
          callAction: async () => {
            throw new Error("unused");
          },
        },
      }),
    ).rejects.toThrow(/one unit/);
  });

  test("runs the orchestrator's runner through the feeder pipe, hardened", async () => {
    const { client, runs } = createFakeClient();

    await spawnWithFakes({ client });

    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.cmd).toBe("sh");
    expect(run.args[1]).toContain(
      'node --disallow-code-generation-from-strings "$1"',
    );
    expect(run.args).toContain("/vercel/sandbox/tidegate-protocol/feeder.sh");
    expect(run.args).toContain("tidegate-runner.mjs");
    expect(run.cwd).toBe("/vercel/sandbox/tidegate-workspace");
    expect(run.detached).toBe(true);
  });

  test("serializes stdin messages as sequential files and ends with the closed marker", async () => {
    const written: WrittenFile[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    let pendingWrites = 0;
    const { client } = createFakeClient({
      writeFiles: async (files) => {
        pendingWrites += 1;
        if (pendingWrites === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        written.push(...files);
      },
    });

    const { transport } = await spawnWithFakes({ client });
    transport.stdin.write('{"type":"start"}\n');
    transport.stdin.write('{"type":"action_result"}\n');
    transport.stdin.end();

    // Nothing lands until the first (slow) write resolves: order is a
    // protocol invariant, not a scheduling accident.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(written).toEqual([]);

    releaseFirstWrite!();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(written).toEqual([
      {
        path: "/vercel/sandbox/tidegate-protocol/stdin/msg-1",
        content: '{"type":"start"}\n',
      },
      {
        path: "/vercel/sandbox/tidegate-protocol/stdin/msg-2",
        content: '{"type":"action_result"}\n',
      },
      {
        path: "/vercel/sandbox/tidegate-protocol/stdin/closed",
        content: "closed\n",
      },
    ]);
  });

  test("ignores writes after end (the runner is already draining)", async () => {
    const written: WrittenFile[] = [];
    const { client } = createFakeClient({
      writeFiles: async (files) => {
        written.push(...files);
      },
    });

    const { transport } = await spawnWithFakes({ client });
    transport.stdin.end();
    transport.stdin.write('{"type":"late"}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(written.map((file) => file.path)).toEqual([
      "/vercel/sandbox/tidegate-protocol/stdin/closed",
    ]);
  });

  test("falls back to exit 0 when streams end but wait() lags", async () => {
    const { client } = createFakeClient();
    const { transport } = await spawnWithFakes({ client, exitFallbackMs: 20 });

    (transport.stdout as unknown as { end: () => void }).end();
    (transport.stderr as unknown as { end: () => void }).end();
    // Drain the readables so 'end' fires.
    for await (const _chunk of transport.stdout) {
      void _chunk;
    }
    for await (const _chunk of transport.stderr) {
      void _chunk;
    }

    expect(await transport.exit).toBe(0);
  });

  test("stop kills the command, stops the VM once, and stays idempotent", async () => {
    const kills: Array<string | undefined> = [];
    const { client, getStopCalls } = createFakeClient({
      runCommand: async () => ({
        kill: async (signal) => {
          kills.push(signal);
        },
        wait: () => new Promise<{ exitCode: number }>(() => {}),
        logs: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<
                IteratorResult<{ data: string; stream: "stdout" | "stderr" }>
              >(() => {}),
          }),
        }),
      }),
    });

    const { transport, workspace } = await spawnWithFakes({ client });
    await transport.stop();
    await transport.stop();
    await workspace.cleanup();

    expect(kills).toEqual(["SIGKILL"]);
    expect(getStopCalls()).toBe(1);
  });
});
