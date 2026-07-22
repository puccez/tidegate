import { describe, expect, test } from "bun:test";
import type { PublishedInteractionArtifact } from "@tidegate/contracts";
import { PublishedInteractionArtifactSchema } from "@tidegate/contracts";
import { cancelAppointmentPublishedArtifact } from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog";
import {
  createExecutionTraceRecorder,
  createInMemoryExecutionTraceStore,
  type ExecutionTraceStore,
} from "./execution-tracing";
import {
  createPublishedInteractionActionCallToken,
  createPublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionPayload,
  type PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor";
import {
  createSandboxedPublishedInteractionExecutor,
  type PublishedInteractionSandboxProvider,
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

const trustedRuntime: PublishedInteractionTrustedRuntime = {
  async callAction() {
    return { ok: true };
  },
};

function cloneArtifact(
  overrides: Partial<PublishedInteractionArtifact> = {},
): PublishedInteractionArtifact {
  return PublishedInteractionArtifactSchema.parse({
    ...structuredClone(cancelAppointmentPublishedArtifact),
    ...overrides,
  });
}

function createPayload(
  artifact = cloneArtifact(),
): PublishedInteractionExecutionPayload {
  const invocationId = "invoke_sandbox_tracing";
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

class FakeSandboxWorkspace implements PublishedInteractionSandboxWorkspace {
  readonly rootPath = "/tmp/fake-sandbox";
  readonly writtenPaths: string[] = [];
  cleanedUp = false;

  async writeTextFile({ path }: { path: string; content: string }) {
    this.writtenPaths.push(path);
  }

  async cleanup() {
    this.cleanedUp = true;
  }
}

function createFakeWorkspaceFactory(): PublishedInteractionSandboxWorkspaceFactory & {
  workspaces: FakeSandboxWorkspace[];
} {
  const workspaces: FakeSandboxWorkspace[] = [];
  return {
    workspaces,
    async createWorkspace() {
      const workspace = new FakeSandboxWorkspace();
      workspaces.push(workspace);
      return workspace;
    },
  };
}

function createOkProvider(): PublishedInteractionSandboxProvider {
  return {
    async execute() {
      return { status: "ok", output: { done: true } };
    },
  };
}

function createTracingHarness(store = createInMemoryExecutionTraceStore()) {
  return {
    store,
    recorder: createExecutionTraceRecorder({ store }),
  };
}

describe("sandbox executor tracing", () => {
  test("persists a sandbox.execute trace covering allocation, prepare, and run", async () => {
    const { recorder, store } = createTracingHarness();
    const executor = createSandboxedPublishedInteractionExecutor({
      provider: createOkProvider(),
      workspaceFactory: createFakeWorkspaceFactory(),
      tracing: { recorder },
    });

    const result = await executor.execute(createPayload(), trustedRuntime);

    expect(result.status).toBe("ok");
    const traces = await store.listTraces({ ownerId: "demo-salon" });
    expect(traces).toHaveLength(1);
    const summary = traces[0]!;
    expect(summary.kind).toBe("sandbox.execute");
    expect(summary.status).toBe("complete");
    expect(summary.tenantId).toBe("demo-salon");

    const snapshot = await store.getTrace({
      ownerId: "demo-salon",
      traceId: summary.id,
    });
    expect(snapshot).toBeDefined();
    expect(snapshot!.spans.map((span) => span.name)).toEqual([
      "sandbox.allocate",
      "sandbox.prepare",
      "sandbox.run",
    ]);
    expect(
      snapshot!.spans.every((span) => span.status === "ok"),
    ).toBeTrue();
    expect(
      snapshot!.events.map((event) => event.name),
    ).toContain("sandbox.result");
    expect(snapshot!.trace.attributes.invocationId).toBe(
      "invoke_sandbox_tracing",
    );
  });

  test("records a failed trace when the source policy rejects execution", async () => {
    const { recorder, store } = createTracingHarness();
    const executor = createSandboxedPublishedInteractionExecutor({
      provider: createOkProvider(),
      workspaceFactory: createFakeWorkspaceFactory(),
      tracing: { recorder },
    });
    const artifact = cloneArtifact();
    const payload = createPayload(
      cloneArtifact({
        source: `${artifact.source}\nglobalThis.fetch("https://example.com");\n`,
      }),
    );

    const result = await executor.execute(payload, trustedRuntime);

    expect(result.status).toBe("rejected");
    const traces = await store.listTraces({ ownerId: "demo-salon" });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.status).toBe("failed");
    const snapshot = await store.getTrace({
      ownerId: "demo-salon",
      traceId: traces[0]!.id,
    });
    expect(snapshot!.spans).toHaveLength(0);
    const resultEvent = snapshot!.events.find(
      (event) => event.name === "sandbox.result",
    );
    expect(resultEvent?.attributes.status).toBe("rejected");
    expect(resultEvent?.attributes.errorCode).toBe("action_not_allowed");
  });

  test("a broken trace store never breaks sandbox execution", async () => {
    const failingStore: ExecutionTraceStore = {
      ...createInMemoryExecutionTraceStore(),
      async putTrace() {
        throw new Error("trace database unavailable");
      },
      async getTrace() {
        return undefined;
      },
      async listTraces() {
        return [];
      },
    };
    const executor = createSandboxedPublishedInteractionExecutor({
      provider: createOkProvider(),
      workspaceFactory: createFakeWorkspaceFactory(),
      tracing: { recorder: createExecutionTraceRecorder({ store: failingStore }) },
    });

    const result = await executor.execute(createPayload(), trustedRuntime);

    expect(result.status).toBe("ok");
  });

  test("executes without tracing when no recorder is configured", async () => {
    const executor = createSandboxedPublishedInteractionExecutor({
      provider: createOkProvider(),
      workspaceFactory: createFakeWorkspaceFactory(),
    });

    const result = await executor.execute(createPayload(), trustedRuntime);

    expect(result.status).toBe("ok");
  });
});
