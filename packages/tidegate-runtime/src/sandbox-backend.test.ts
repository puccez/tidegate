import { describe, expect, test } from "bun:test";
import { cancelAppointmentPublishedArtifact } from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog";
import {
  createPublishedInteractionActionCallToken,
  createPublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionPayload,
} from "./published-interaction-executor";
import {
  normalizeSandboxWorkspacePath,
  SANDBOX_WORKSPACE_WRITE_ORDER,
  type PublishedInteractionSandboxProvider,
  type PublishedInteractionSandboxWorkspace,
  type PublishedInteractionSandboxWorkspaceFactory,
  type SandboxBackend,
} from "./sandbox-backend";
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

function createPayload(): PublishedInteractionExecutionPayload {
  return createPublishedInteractionExecutionPayload({
    actionCallToken: createPublishedInteractionActionCallToken(
      "invoke_sandbox_backend",
    ),
    artifact: cancelAppointmentPublishedArtifact,
    auth,
    input: {
      appointmentId: "apt_123",
      reason: "Client requested cancellation",
    },
    invocationId: "invoke_sandbox_backend",
  });
}

function createRecordingBackend(): SandboxBackend & {
  writes: string[];
  executions: number;
} {
  const writes: string[] = [];
  let executions = 0;
  const workspace: PublishedInteractionSandboxWorkspace = {
    rootPath: "/tmp/tidegate-backend-test",
    writeTextFile({ path }: { path: string; content: string }) {
      writes.push(path);
    },
    async cleanup() {},
  };
  const workspaceFactory: PublishedInteractionSandboxWorkspaceFactory = {
    async createWorkspace() {
      return workspace;
    },
  };
  const provider: PublishedInteractionSandboxProvider = {
    async execute() {
      executions += 1;
      return { status: "ok", output: { ok: true, appointmentId: "apt_123" } };
    },
  };

  return {
    provider,
    workspaceFactory,
    writes,
    get executions() {
      return executions;
    },
  };
}

describe("sandbox backend seam", () => {
  test("the executor accepts a backend as one workspace-factory + provider unit", async () => {
    const backend = createRecordingBackend();
    const executor = createSandboxedPublishedInteractionExecutor({ backend });

    const result = await executor.execute(createPayload(), {
      async callAction() {
        throw new Error("No action call expected.");
      },
    });

    expect(result.status).toBe("ok");
    expect(backend.executions).toBe(1);
    expect(backend.writes).toEqual([...SANDBOX_WORKSPACE_WRITE_ORDER]);
  });

  test("the executor throws when backend is combined with the deprecated loose options", () => {
    const backend = createRecordingBackend();

    expect(() =>
      createSandboxedPublishedInteractionExecutor({
        backend,
        provider: backend.provider,
      }),
    ).toThrow(/either `backend` or the deprecated/);
    expect(() =>
      createSandboxedPublishedInteractionExecutor({
        backend,
        workspaceFactory: backend.workspaceFactory,
      }),
    ).toThrow(/either `backend` or the deprecated/);
  });

  test("workspace path normalization fails closed on escape attempts", () => {
    expect(normalizeSandboxWorkspacePath("nested/../file.txt")).toBe(
      "file.txt",
    );
    for (const path of [
      "",
      "  ",
      "..",
      "../escape.mjs",
      "nested/../../escape.mjs",
      "/etc/passwd",
      "file\0.txt",
    ]) {
      expect(() => normalizeSandboxWorkspacePath(path)).toThrow();
    }
  });
});
