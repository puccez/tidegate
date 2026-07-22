import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type {
  InteractionBranch,
  InteractionDraft,
  TidegateActionCatalogManifestV1,
} from "@tidegate/contracts";
import {
  cancelAppointmentGeneratedSource,
  cancelAppointmentInteractionBranch,
  cancelAppointmentInteractionDraft,
  cancelAppointmentInteractionRecord,
  cancelAppointmentPublishedArtifact,
  cancelAppointmentPublishRequest,
} from "@tidegate/contracts/fixtures";
import {
  hashInteractionAuthoringPublishRequest,
  hashInteractionAuthoringSource,
  hashInteractionAuthoringTest,
  materializeInteractionAuthoringWorkspaceFromBranchSnapshot,
  materializeInteractionAuthoringWorkspaceFromDraftSnapshot,
  materializeInteractionAuthoringWorkspaceFromNewRequest,
  materializeInteractionAuthoringWorkspaceFromPublishedArtifact,
  planInteractionAuthoringWorkspace,
  publishRequestSnapshotFromPublishedArtifact,
  toInteractionAuthoringWorkspacePublishRequest,
  TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME,
  TIDEGATE_INTERACTION_AUTHORING_PUBLISH_REQUEST_FILENAME,
  TIDEGATE_INTERACTION_AUTHORING_SOURCE_FILENAME,
  TIDEGATE_INTERACTION_AUTHORING_TEST_FILENAME,
} from "./interaction-authoring-workspace";
import { generateTidegateActionAuthoringFiles } from "./interaction-action-authoring-files";

const actionCatalogManifest: TidegateActionCatalogManifestV1 = {
  schemaVersion: "tidegate.actionCatalog.v1",
  catalogId: "booking-actions",
  version: "2026-06-21",
  actions: {
    "booking.cancel": {
      description: "Cancel one appointment in the current salon.",
      input: {
        type: "object",
        required: ["appointmentId"],
        properties: {
          appointmentId: { type: "string" },
          reason: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        required: ["ok", "appointmentId"],
        properties: {
          ok: { type: "boolean" },
          appointmentId: { type: "string" },
        },
        additionalProperties: false,
      },
      effects: "write",
      requiredPermissions: ["booking:write"],
      tenantScope: { fromAuth: "tenantId" },
      audit: { required: true, redactPaths: [] },
    },
  },
};
const bookingCancelAction = actionCatalogManifest.actions["booking.cancel"];

if (bookingCancelAction === undefined) {
  throw new Error("Test fixture must include booking.cancel.");
}

const testSource = [
  "import { expect, test } from 'bun:test';",
  "import run from './interaction';",
  "",
  "test('cancels an appointment', async () => {",
  "  const output = await run({ appointmentId: 'apt_123' }, {",
  "    capabilities: {",
  "      booking: {",
  "        cancel: async (input) => ({ ok: true, appointmentId: input.appointmentId }),",
  "      },",
  "    },",
  "  });",
  "",
  "  expect(output).toEqual({ ok: true, appointmentId: 'apt_123' });",
  "});",
].join("\n");

describe("interaction authoring workspace helpers", () => {
  test("plans authoring workspace files without filesystem writes", () => {
    const plan = planInteractionAuthoringWorkspace({
      actionCatalogManifest,
      publishRequest: cancelAppointmentPublishRequest,
      rootDir: "planned-workspaces",
      testSource,
    });
    const { materialization } = plan;
    const bookingCancelPath =
      "planned-workspaces/ix.booking.cancelAppointment/actions/booking/cancel.ts";

    expect(materialization.interactionId).toBe("ix.booking.cancelAppointment");
    expect(materialization.editableFiles).toEqual([
      materialization.paths.sourcePath,
      materialization.paths.testPath,
    ]);
    expect(materialization.generatedFiles).toEqual([
      materialization.paths.capabilitiesPath,
      materialization.paths.actionsCatalogPath,
      materialization.paths.actionsReadmePath,
      materialization.paths.actionsIndexPath,
      bookingCancelPath,
    ]);
    expect(materialization.trustedFiles).toEqual([
      materialization.paths.publishRequestPath,
    ]);
    expect(materialization.actionFiles).toEqual({
      "booking.cancel": bookingCancelPath,
    });
    expect(materialization.hashes).toEqual({
      sourceHash: hashInteractionAuthoringSource(
        cancelAppointmentGeneratedSource,
      ),
      testHash: hashInteractionAuthoringTest(testSource),
      publishRequestHash: hashInteractionAuthoringPublishRequest(
        materialization.publishRequest,
      ),
    });

    expect(
      plan.files.map(({ actionId, path, type }) => ({ actionId, path, type })),
    ).toEqual([
      {
        actionId: undefined,
        path: materialization.paths.sourcePath,
        type: "editable",
      },
      {
        actionId: undefined,
        path: materialization.paths.testPath,
        type: "editable",
      },
      {
        actionId: undefined,
        path: materialization.paths.publishRequestPath,
        type: "trusted",
      },
      {
        actionId: undefined,
        path: materialization.paths.capabilitiesPath,
        type: "generated",
      },
      {
        actionId: undefined,
        path: materialization.paths.actionsCatalogPath,
        type: "generated",
      },
      {
        actionId: undefined,
        path: materialization.paths.actionsReadmePath,
        type: "generated",
      },
      {
        actionId: undefined,
        path: materialization.paths.actionsIndexPath,
        type: "generated",
      },
      {
        actionId: "booking.cancel",
        path: bookingCancelPath,
        type: "generated",
      },
    ]);

    const filesByPath = new Map(plan.files.map((file) => [file.path, file]));
    const publishRequest = JSON.parse(
      filesByPath.get(materialization.paths.publishRequestPath)?.content ?? "",
    );

    expect(filesByPath.get(materialization.paths.sourcePath)?.content).toBe(
      cancelAppointmentGeneratedSource,
    );
    expect(filesByPath.get(materialization.paths.testPath)?.content).toBe(
      testSource,
    );
    expect(publishRequest).toMatchObject({
      requestedInteractionId: "ix.booking.cancelAppointment",
      requestedAllowedActions: [{ id: "booking.cancel", maxCalls: 1 }],
    });
    expect(publishRequest.source).toBeUndefined();
    expect(filesByPath.get(materialization.paths.capabilitiesPath)?.content).toContain(
      "cancel: (input) => actions.call(\"booking.cancel\", input)",
    );
    expect(filesByPath.get(bookingCancelPath)?.content).toContain(
      'return ctx.capabilities.booking.cancel(input);',
    );
  });

  test("creates an authoring workspace with generated action TypeScript files", async () => {
    await withTempRoot(async (rootDir) => {
      const result =
        await materializeInteractionAuthoringWorkspaceFromNewRequest({
          actionCatalogManifest,
          publishRequest: cancelAppointmentPublishRequest,
          rootDir,
          testSource,
        });

      expect(result.interactionId).toBe("ix.booking.cancelAppointment");
      expect(result.actionIds).toEqual(["booking.cancel"]);
      expect(result.editableFiles).toEqual([
        result.paths.sourcePath,
        result.paths.testPath,
      ]);
      expect(result.generatedFiles).toEqual([
        result.paths.capabilitiesPath,
        result.paths.actionsCatalogPath,
        result.paths.actionsReadmePath,
        result.paths.actionsIndexPath,
        result.actionFiles["booking.cancel"] as string,
      ]);
      expect(result.trustedFiles).toEqual([result.paths.publishRequestPath]);
      expect(result.hashes.sourceHash).toBe(
        hashInteractionAuthoringSource(cancelAppointmentGeneratedSource),
      );

      const filenames = await readdir(result.paths.interactionDir);

      expect(filenames.sort((left, right) => left.localeCompare(right))).toEqual([
        TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME,
        TIDEGATE_INTERACTION_AUTHORING_TEST_FILENAME,
        TIDEGATE_INTERACTION_AUTHORING_SOURCE_FILENAME,
        TIDEGATE_INTERACTION_AUTHORING_PUBLISH_REQUEST_FILENAME,
        "tidegate-capabilities.generated.ts",
      ]);
      await expect(readFile(result.paths.sourcePath, "utf8")).resolves.toBe(
        cancelAppointmentGeneratedSource,
      );
      await expect(readFile(result.paths.testPath, "utf8")).resolves.toBe(
        testSource,
      );

      const publishRequest = JSON.parse(
        await readFile(result.paths.publishRequestPath, "utf8"),
      );

      expect(publishRequest).toMatchObject({
        requestedInteractionId: "ix.booking.cancelAppointment",
        requestedAllowedActions: [{ id: "booking.cancel", maxCalls: 1 }],
        effects: { idempotency: "required" },
        visibility: "user",
      });
      expect(publishRequest.source).toBeUndefined();

      const capabilities = await readFile(result.paths.capabilitiesPath, "utf8");

      expect(capabilities).toContain("Generated by Tidegate. Do not edit by hand.");
      expect(capabilities).toContain(
        "cancel: (input) => actions.call(\"booking.cancel\", input)",
      );

      const actionCatalog = JSON.parse(
        await readFile(result.paths.actionsCatalogPath, "utf8"),
      );
      const actionReadme = await readFile(result.paths.actionsReadmePath, "utf8");
      const actionIndex = await readFile(result.paths.actionsIndexPath, "utf8");
      const bookingCancel = await readFile(
        result.actionFiles["booking.cancel"] ?? "",
        "utf8",
      );

      expect(actionCatalog).toMatchObject({
        catalogId: "booking-actions",
        actions: { "booking.cancel": { effects: "write" } },
      });
      expect(actionReadme).toContain("ctx.capabilities.booking.cancel(input)");
      expect(actionIndex).toContain(
        'export { action as bookingCancelAction } from "./booking/cancel";',
      );
      expect(actionIndex).toContain('"id": "booking.cancel"');
      expect(actionIndex).toContain('"maxCalls": 1');
      expect(bookingCancel).toContain(
        'export const actionId = "booking.cancel" as const;',
      );
      expect(bookingCancel).toContain(
        'return ctx.capabilities.booking.cancel(input);',
      );
      expect(bookingCancel).toContain(
        'export type BookingCancelInput = TidegateActionMap[typeof actionId]["input"];',
      );
    });
  });

  test("resumes a draft snapshot without writing draft or owner metadata", async () => {
    await withTempRoot(async (rootDir) => {
      const publishRequest = toInteractionAuthoringWorkspacePublishRequest(
        cancelAppointmentPublishRequest,
      );
      const result =
        await materializeInteractionAuthoringWorkspaceFromDraftSnapshot({
          actionCatalogManifest,
          draft: cancelAppointmentInteractionDraft,
          publishRequest,
          rootDir,
          testSource,
        });

      const writtenText = await readWorkspaceText(result.paths.interactionDir);

      expect(writtenText).toContain(cancelAppointmentInteractionDraft.source);
      expect(writtenText).not.toContain(
        cancelAppointmentInteractionDraft.draftId,
      );
      expect(writtenText).not.toContain(
        cancelAppointmentInteractionDraft.branchId,
      );
      expect(writtenText).not.toContain("tenant_123");
      expect(writtenText).not.toContain("org_123");
      expect(writtenText).not.toContain("user_123");
    });
  });

  test("generated action TypeScript files are importable in authoring code", async () => {
    await withTempRoot(async (rootDir) => {
      const result =
        await materializeInteractionAuthoringWorkspaceFromNewRequest({
          actionCatalogManifest,
          publishRequest: cancelAppointmentPublishRequest,
          rootDir,
          testSource,
        });

      await Bun.write(
        join(result.paths.interactionDir, "authoring-scratch.ts"),
        [
          "import { bookingCancelAction, requestedAllowedActions } from './actions';",
          "import type { BookingCancelInput } from './actions/booking/cancel';",
          "import type { TidegateGeneratedInteractionContext } from './tidegate-capabilities.generated';",
          "",
          "const allowed = requestedAllowedActions[0];",
          "allowed.id satisfies 'booking.cancel';",
          "",
          "declare const ctx: TidegateGeneratedInteractionContext;",
          "async function run(input: BookingCancelInput) {",
          "  const result = await bookingCancelAction.call(ctx, input);",
          "  result.appointmentId satisfies string;",
          "  return result;",
          "}",
          "void run;",
        ].join("\n"),
      );

      const typecheck = await runTsc(
        result.paths.interactionDir,
        "authoring-scratch.ts",
      );

      expect(typecheck.exitCode, typecheck.stderr).toBe(0);
    });
  });

  test("generates action files only for the publish request allowlist", async () => {
    await withTempRoot(async (rootDir) => {
      const result =
        await materializeInteractionAuthoringWorkspaceFromNewRequest({
          actionCatalogManifest: {
            ...actionCatalogManifest,
            actions: {
              ...actionCatalogManifest.actions,
              "booking.reschedule": {
                ...bookingCancelAction,
                description: "Reschedule one appointment.",
              },
            },
          },
          publishRequest: cancelAppointmentPublishRequest,
          rootDir,
          testSource,
        });

      const actionCatalog = JSON.parse(
        await readFile(result.paths.actionsCatalogPath, "utf8"),
      );
      const actionIndex = await readFile(result.paths.actionsIndexPath, "utf8");
      const capabilities = await readFile(result.paths.capabilitiesPath, "utf8");

      expect(result.actionIds).toEqual(["booking.cancel"]);
      expect(Object.keys(actionCatalog.actions)).toEqual(["booking.cancel"]);
      expect(result.actionFiles).toEqual({
        "booking.cancel": result.paths.actionsDir + "/booking/cancel.ts",
      });
      expect(actionIndex).toContain('"timeoutMs": 3000');
      expect(actionIndex).not.toContain("booking.reschedule");
      expect(capabilities).toContain("booking.cancel");
      expect(capabilities).not.toContain("booking.reschedule");
    });
  });

  test("generates valid TypeScript identifiers for numeric action ids", () => {
    const generated = generateTidegateActionAuthoringFiles({
      ...actionCatalogManifest,
      actions: {
        "123.foo": {
          ...bookingCancelAction,
          description: "Numeric action namespace.",
        },
      },
    });
    const index = generated.files.find((file) => file.relativePath === "actions/index.ts");
    const action = generated.files.find(
      (file) => file.relativePath === "actions/123/foo.ts",
    );

    expect(index?.source).toContain(
      'export { action as action123FooAction } from "./123/foo";',
    );
    expect(action?.source).toContain("export type TidegateAction123FooInput");
    expect(action?.source).toContain("export type TidegateAction123FooOutput");
  });

  test("rejects action authoring export alias collisions with an actionable error", () => {
    expect(() =>
      generateTidegateActionAuthoringFiles({
        ...actionCatalogManifest,
        actions: {
          "booking.Cancel": {
            ...bookingCancelAction,
            description: "Colliding uppercase action alias.",
          },
          "booking.cancel": bookingCancelAction,
        },
      }),
    ).toThrow(
      'Tidegate action authoring files cannot generate duplicate export alias "bookingCancelAction"',
    );
  });

  test("rejects duplicate allowed action ids with an actionable error", () => {
    expect(() =>
      generateTidegateActionAuthoringFiles(actionCatalogManifest, {
        allowedActions: [
          { id: "booking.cancel", maxCalls: 1 },
          { id: "booking.cancel", maxCalls: 2 },
        ],
      }),
    ).toThrow(
      'Tidegate action authoring files received duplicate allowed action "booking.cancel"',
    );
  });

  test("rejects unknown allowed action ids with an actionable error", () => {
    expect(() =>
      generateTidegateActionAuthoringFiles(actionCatalogManifest, {
        allowedActions: [{ id: "booking.refund", maxCalls: 1 }],
      }),
    ).toThrow(
      'Tidegate action authoring files cannot include unknown allowed action "booking.refund"',
    );
  });

  test("reconstructs a published artifact without bridge runtime fields", async () => {
    await withTempRoot(async (rootDir) => {
      const result =
        await materializeInteractionAuthoringWorkspaceFromPublishedArtifact({
          actionCatalogManifest,
          artifact: cancelAppointmentPublishedArtifact,
          record: cancelAppointmentInteractionRecord,
          rootDir,
          testSource,
        });

      const publishRequest = JSON.parse(
        await readFile(result.paths.publishRequestPath, "utf8"),
      );
      const writtenText = await readWorkspaceText(result.paths.interactionDir);

      expect(publishRequest).toMatchObject({
        requestedInteractionId: "ix.booking.cancelAppointment",
        title: "Cancel appointment",
        description: "Cancel an appointment for the current salon.",
        requestedAllowedActions: [{ id: "booking.cancel", maxCalls: 1 }],
      });
      expect(publishRequest.requestedAllowedActions[0].reason).toBeUndefined();
      expect(writtenText).not.toContain("tenant_123");
      expect(writtenText).not.toContain("org_123");
      expect(writtenText).not.toContain("user_123");
      expect(writtenText).not.toContain("sbx_cancel_appointment_runtime");
      expect(writtenText).not.toContain("customer.example.test");
      expect(writtenText).not.toContain("bridge-secret-ref");
      expect(writtenText).not.toContain("publishedFromBranchId");
    });
  });

  test("resumes a branch snapshot from the mutable draft source", async () => {
    await withTempRoot(async (rootDir) => {
      const editedSource = `${cancelAppointmentGeneratedSource}\n// branch edit`;
      const branchSnapshot = {
        scope: {
          ownerTenantId: "tenant_123",
          ownerOrganizationId: "org_123",
          ownerUserId: "user_123",
        },
        branch: cancelAppointmentInteractionBranch satisfies InteractionBranch,
        draft: {
          ...cancelAppointmentInteractionDraft,
          source: editedSource,
        } satisfies InteractionDraft,
        publishRequest: toInteractionAuthoringWorkspacePublishRequest(
          cancelAppointmentPublishRequest,
        ),
        source: {
          interactionId: "ix.booking.cancelAppointment",
          visibility: "user",
          version: "1",
          sourceHash:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          source: "base artifact source that should not be written",
          actionCatalogId: "booking-actions",
          actionCatalogVersion: "2026-06-21",
          publishRequest: toInteractionAuthoringWorkspacePublishRequest(
            cancelAppointmentPublishRequest,
          ),
        },
        publishTarget: "same-interaction" as const,
        targetInteractionId: "ix.booking.cancelAppointment",
      };

      const result =
        await materializeInteractionAuthoringWorkspaceFromBranchSnapshot({
          actionCatalogManifest,
          branchSnapshot,
          rootDir,
          testSource,
        });

      await expect(readFile(result.paths.sourcePath, "utf8")).resolves.toBe(
        editedSource,
      );

      const writtenText = await readWorkspaceText(result.paths.interactionDir);

      expect(writtenText).not.toContain("base artifact source");
      expect(writtenText).not.toContain("branch_cancel_appointment_v1");
      expect(writtenText).not.toContain("draft_cancel_appointment_v1");
      expect(writtenText).not.toContain("tenant_123");
    });
  });

  test("derives a publish request snapshot from a published artifact", () => {
    const snapshot = publishRequestSnapshotFromPublishedArtifact({
      artifact: cancelAppointmentPublishedArtifact,
      record: cancelAppointmentInteractionRecord,
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        requestedInteractionId: "ix.booking.cancelAppointment",
        title: "Cancel appointment",
        visibility: "user",
        requestedAllowedActions: [{ id: "booking.cancel", maxCalls: 1, timeoutMs: 3000 }],
      }),
    );
    expect("source" in snapshot).toBe(false);
  });

  test("excludes publish gate evidence from authoring publish request snapshots", () => {
    const snapshot = toInteractionAuthoringWorkspacePublishRequest({
      ...cancelAppointmentPublishRequest,
      requireGreenTests: true,
      provenance: {
        sourceHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        testHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        publishRequestHash:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        actionCatalogId: "booking-actions",
        actionCatalogVersion: "2026-06-21",
        validationResultAt: "2026-06-21T00:01:00.000Z",
        vitestResultAt: "2026-06-21T00:02:00.000Z",
      },
    });

    expect("source" in snapshot).toBe(false);
    expect("requireGreenTests" in snapshot).toBe(false);
    expect("provenance" in snapshot).toBe(false);
  });
});

async function withTempRoot(work: (rootDir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "tidegate-authoring-workspace-"));
  const rootDir = join(dir, "tidegate-interactions");

  try {
    await work(rootDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readWorkspaceText(interactionDir: string) {
  const filenames = await listWorkspaceFiles(interactionDir);
  const contents = await Promise.all(
    filenames
      .sort((left, right) => left.localeCompare(right))
      .map((filename) => readFile(join(interactionDir, filename), "utf8")),
  );

  return contents.join("\n");
}

async function listWorkspaceFiles(
  dir: string,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = prefix.length > 0 ? join(prefix, entry.name) : entry.name;

      return entry.isDirectory() ? listWorkspaceFiles(dir, path) : [path];
    }),
  );

  return files.flat();
}

async function runTsc(dir: string, file: string) {
  const process = Bun.spawn(
    [
      "bunx",
      "tsc",
      "--noEmit",
      "--strict",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--target",
      "ESNext",
      "--lib",
      "ESNext",
      "--skipLibCheck",
      file,
    ],
    {
      cwd: dir,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);

  return {
    exitCode,
    stderr: `${stderr}\n${stdout}`,
  };
}
