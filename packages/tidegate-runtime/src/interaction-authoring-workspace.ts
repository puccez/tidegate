import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PublishedInteractionArtifactSchema,
  PublishInteractionRequestSchema,
  TidegateActionCatalogManifestV1Schema,
  type InteractionDraft,
  type InteractionRecord,
  type PublishedInteractionArtifact,
  type PublishInteractionRequest,
  type TidegateActionCatalogManifestV1,
} from "@tidegate/contracts";
import {
  generateTidegateCapabilitiesClient,
  TIDEGATE_CAPABILITIES_GENERATED_FILENAME,
} from "./capability-codegen.ts";
import {
  createTidegateActionAuthoringManifest,
  generateTidegateActionAuthoringFiles,
  TIDEGATE_INTERACTION_AUTHORING_ACTION_CATALOG_FILENAME,
  TIDEGATE_INTERACTION_AUTHORING_ACTION_INDEX_FILENAME,
  TIDEGATE_INTERACTION_AUTHORING_ACTION_README_FILENAME,
  TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME,
} from "./interaction-action-authoring-files.ts";
import type {
  InteractionDraftPublishRequestSnapshot,
  ScopedInteractionBranchResolution,
} from "./interaction-registry.ts";

export const TIDEGATE_INTERACTION_AUTHORING_WORKSPACE_ROOT =
  "tidegate-interactions";
export const TIDEGATE_INTERACTION_AUTHORING_SOURCE_FILENAME = "interaction.ts";
export const TIDEGATE_INTERACTION_AUTHORING_TEST_FILENAME =
  "interaction.test.ts";
export const TIDEGATE_INTERACTION_AUTHORING_PUBLISH_REQUEST_FILENAME =
  "publish-request.json";
export {
  TIDEGATE_INTERACTION_AUTHORING_ACTION_CATALOG_FILENAME,
  TIDEGATE_INTERACTION_AUTHORING_ACTION_INDEX_FILENAME,
  TIDEGATE_INTERACTION_AUTHORING_ACTION_README_FILENAME,
  TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME,
};

const SOURCE_VALIDATION_PLACEHOLDER =
  "export default async function run() { return {}; }";

export type InteractionAuthoringWorkspacePublishRequest =
  InteractionDraftPublishRequestSnapshot;

export type InteractionAuthoringWorkspacePaths = {
  rootDir: string;
  interactionDir: string;
  sourcePath: string;
  testPath: string;
  publishRequestPath: string;
  capabilitiesPath: string;
  actionsDir: string;
  actionsCatalogPath: string;
  actionsIndexPath: string;
  actionsReadmePath: string;
};

export type InteractionAuthoringWorkspaceHashes = {
  sourceHash: string;
  testHash: string;
  publishRequestHash: string;
};

export type InteractionAuthoringWorkspaceMaterialization = {
  interactionId: string;
  actionCatalogManifest: TidegateActionCatalogManifestV1;
  actionIds: string[];
  actionFiles: Record<string, string>;
  paths: InteractionAuthoringWorkspacePaths;
  editableFiles: string[];
  generatedFiles: string[];
  trustedFiles: string[];
  publishRequest: InteractionAuthoringWorkspacePublishRequest;
  hashes: InteractionAuthoringWorkspaceHashes;
};

export type InteractionAuthoringWorkspaceFile = {
  actionId?: string;
  content: string;
  path: string;
  type: "editable" | "generated" | "trusted";
};

export type InteractionAuthoringWorkspacePlan = {
  materialization: InteractionAuthoringWorkspaceMaterialization;
  files: InteractionAuthoringWorkspaceFile[];
};

export type InteractionAuthoringWorkspaceActionCatalogSnapshot = {
  actionCatalogId: string;
  actionCatalogVersion: string;
};

export type MaterializeInteractionAuthoringWorkspaceInput = {
  rootDir?: string;
  actionCatalogManifest: unknown;
  publishRequest:
    | PublishInteractionRequest
    | InteractionAuthoringWorkspacePublishRequest;
  source?: string;
  testSource: string;
  expectedActionCatalog?: InteractionAuthoringWorkspaceActionCatalogSnapshot;
};

export type MaterializeInteractionAuthoringWorkspaceFromNewRequestInput = Omit<
  MaterializeInteractionAuthoringWorkspaceInput,
  "publishRequest"
> & {
  publishRequest: PublishInteractionRequest;
};

export type MaterializeInteractionAuthoringWorkspaceFromDraftSnapshotInput = Omit<
  MaterializeInteractionAuthoringWorkspaceInput,
  "expectedActionCatalog" | "publishRequest" | "source"
> & {
  draft: Pick<
    InteractionDraft,
    "actionCatalogId" | "actionCatalogVersion" | "source"
  >;
  publishRequest: InteractionAuthoringWorkspacePublishRequest;
};

export type MaterializeInteractionAuthoringWorkspaceFromPublishedArtifactInput =
  Omit<
    MaterializeInteractionAuthoringWorkspaceInput,
    "expectedActionCatalog" | "publishRequest" | "source"
  > & {
    artifact: PublishedInteractionArtifact;
    record?: Pick<InteractionRecord, "description" | "title">;
  };

export type MaterializeInteractionAuthoringWorkspaceFromBranchSnapshotInput = Omit<
  MaterializeInteractionAuthoringWorkspaceInput,
  "expectedActionCatalog" | "publishRequest" | "source"
> & {
  branchSnapshot: Pick<
    ScopedInteractionBranchResolution,
    "draft" | "publishRequest"
  >;
};

export function interactionAuthoringWorkspacePaths({
  interactionId,
  rootDir = TIDEGATE_INTERACTION_AUTHORING_WORKSPACE_ROOT,
}: {
  interactionId: string;
  rootDir?: string;
}): InteractionAuthoringWorkspacePaths {
  const normalizedRootDir = normalizeWorkspaceRoot(rootDir);
  const interactionDirName = safeInteractionWorkspaceDirectoryName(interactionId);
  const interactionDir = join(normalizedRootDir, interactionDirName);

  return {
    rootDir: normalizedRootDir,
    interactionDir,
    sourcePath: join(interactionDir, TIDEGATE_INTERACTION_AUTHORING_SOURCE_FILENAME),
    testPath: join(interactionDir, TIDEGATE_INTERACTION_AUTHORING_TEST_FILENAME),
    publishRequestPath: join(
      interactionDir,
      TIDEGATE_INTERACTION_AUTHORING_PUBLISH_REQUEST_FILENAME,
    ),
    capabilitiesPath: join(
      interactionDir,
      TIDEGATE_CAPABILITIES_GENERATED_FILENAME,
    ),
    actionsDir: join(interactionDir, TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME),
    actionsCatalogPath: join(
      interactionDir,
      TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME,
      TIDEGATE_INTERACTION_AUTHORING_ACTION_CATALOG_FILENAME,
    ),
    actionsIndexPath: join(
      interactionDir,
      TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME,
      TIDEGATE_INTERACTION_AUTHORING_ACTION_INDEX_FILENAME,
    ),
    actionsReadmePath: join(
      interactionDir,
      TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME,
      TIDEGATE_INTERACTION_AUTHORING_ACTION_README_FILENAME,
    ),
  };
}

export async function materializeInteractionAuthoringWorkspace({
  actionCatalogManifest,
  expectedActionCatalog,
  publishRequest,
  rootDir,
  source,
  testSource,
}: MaterializeInteractionAuthoringWorkspaceInput): Promise<InteractionAuthoringWorkspaceMaterialization> {
  const plan = planInteractionAuthoringWorkspace({
    actionCatalogManifest,
    expectedActionCatalog,
    publishRequest,
    rootDir,
    source,
    testSource,
  });

  await mkdir(plan.materialization.paths.interactionDir, { recursive: true });
  await Promise.all(plan.files.map(writeWorkspaceFile));

  return plan.materialization;
}

export function planInteractionAuthoringWorkspace({
  actionCatalogManifest,
  expectedActionCatalog,
  publishRequest,
  rootDir,
  source,
  testSource,
}: MaterializeInteractionAuthoringWorkspaceInput): InteractionAuthoringWorkspacePlan {
  const parsedManifest =
    TidegateActionCatalogManifestV1Schema.parse(actionCatalogManifest);

  if (expectedActionCatalog !== undefined) {
    assertActionCatalogSnapshotMatchesManifest({
      expected: expectedActionCatalog,
      manifest: parsedManifest,
    });
  }

  const sourceText = assertNonEmptyText(
    source ?? sourceFromPublishRequest(publishRequest),
    "interaction source",
  );
  const testSourceText = assertText(testSource, "interaction test source");
  const publishRequestSnapshot =
    toInteractionAuthoringWorkspacePublishRequest(publishRequest, sourceText);
  const paths = interactionAuthoringWorkspacePaths({
    interactionId: publishRequestSnapshot.requestedInteractionId,
    rootDir,
  });
  const authoringManifest = createTidegateActionAuthoringManifest(parsedManifest, {
    allowedActions: publishRequestSnapshot.requestedAllowedActions,
  });
  const generated = generateTidegateCapabilitiesClient(authoringManifest.manifest);
  const actionAuthoringFiles = generateTidegateActionAuthoringFiles(
    authoringManifest.manifest,
    {
      allowedActions: publishRequestSnapshot.requestedAllowedActions,
    },
  );
  const generatedActionFiles = Object.fromEntries(
    Object.entries(actionAuthoringFiles.actionFiles).map(
      ([actionId, relativePath]) => [
        actionId,
        join(paths.interactionDir, relativePath),
      ],
    ),
  );
  const formattedPublishRequest = formatInteractionAuthoringPublishRequest(
    publishRequestSnapshot,
  );

  return {
    materialization: {
      interactionId: publishRequestSnapshot.requestedInteractionId,
      actionCatalogManifest: authoringManifest.manifest,
      actionIds: Object.keys(authoringManifest.manifest.actions).sort((left, right) =>
        left.localeCompare(right),
      ),
      actionFiles: generatedActionFiles,
      paths,
      editableFiles: [paths.sourcePath, paths.testPath],
      generatedFiles: [
        paths.capabilitiesPath,
        ...actionAuthoringFiles.files.map((file) =>
          join(paths.interactionDir, file.relativePath),
        ),
      ],
      trustedFiles: [paths.publishRequestPath],
      publishRequest: publishRequestSnapshot,
      hashes: {
        sourceHash: hashInteractionAuthoringSource(sourceText),
        testHash: hashInteractionAuthoringTest(testSourceText),
        publishRequestHash: hashInteractionAuthoringPublishRequest(
          publishRequestSnapshot,
        ),
      },
    },
    files: [
      {
        content: sourceText,
        path: paths.sourcePath,
        type: "editable",
      },
      {
        content: testSourceText,
        path: paths.testPath,
        type: "editable",
      },
      {
        content: formattedPublishRequest,
        path: paths.publishRequestPath,
        type: "trusted",
      },
      {
        content: generated.source,
        path: paths.capabilitiesPath,
        type: "generated",
      },
      ...actionAuthoringFiles.files.map((file) => ({
        actionId: file.actionId,
        content: file.source,
        path: join(paths.interactionDir, file.relativePath),
        type: "generated" as const,
      })),
    ],
  };
}

async function writeWorkspaceFile(file: InteractionAuthoringWorkspaceFile) {
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, file.content, "utf8");
}

export async function materializeInteractionAuthoringWorkspaceFromNewRequest(
  input: MaterializeInteractionAuthoringWorkspaceFromNewRequestInput,
): Promise<InteractionAuthoringWorkspaceMaterialization> {
  return materializeInteractionAuthoringWorkspace(input);
}

export async function materializeInteractionAuthoringWorkspaceFromDraftSnapshot({
  draft,
  ...input
}: MaterializeInteractionAuthoringWorkspaceFromDraftSnapshotInput): Promise<InteractionAuthoringWorkspaceMaterialization> {
  return materializeInteractionAuthoringWorkspace({
    ...input,
    expectedActionCatalog: {
      actionCatalogId: draft.actionCatalogId,
      actionCatalogVersion: draft.actionCatalogVersion,
    },
    source: draft.source,
  });
}

export async function materializeInteractionAuthoringWorkspaceFromPublishedArtifact({
  artifact,
  record,
  ...input
}: MaterializeInteractionAuthoringWorkspaceFromPublishedArtifactInput): Promise<InteractionAuthoringWorkspaceMaterialization> {
  const parsedArtifact = PublishedInteractionArtifactSchema.parse(artifact);

  return materializeInteractionAuthoringWorkspace({
    ...input,
    expectedActionCatalog: {
      actionCatalogId: parsedArtifact.actionCatalogId,
      actionCatalogVersion: parsedArtifact.actionCatalogVersion,
    },
    publishRequest: publishRequestSnapshotFromPublishedArtifact({
      artifact: parsedArtifact,
      record,
    }),
    source: parsedArtifact.source,
  });
}

export async function materializeInteractionAuthoringWorkspaceFromBranchSnapshot({
  branchSnapshot,
  ...input
}: MaterializeInteractionAuthoringWorkspaceFromBranchSnapshotInput): Promise<InteractionAuthoringWorkspaceMaterialization> {
  return materializeInteractionAuthoringWorkspace({
    ...input,
    expectedActionCatalog: {
      actionCatalogId: branchSnapshot.draft.actionCatalogId,
      actionCatalogVersion: branchSnapshot.draft.actionCatalogVersion,
    },
    publishRequest: branchSnapshot.publishRequest,
    source: branchSnapshot.draft.source,
  });
}

export function publishRequestSnapshotFromPublishedArtifact({
  artifact,
  record,
}: {
  artifact: PublishedInteractionArtifact;
  record?: Pick<InteractionRecord, "description" | "title">;
}): InteractionAuthoringWorkspacePublishRequest {
  const parsedArtifact = PublishedInteractionArtifactSchema.parse(artifact);

  return toInteractionAuthoringWorkspacePublishRequest({
    requestedInteractionId: parsedArtifact.id,
    title: record?.title,
    description: record?.description,
    visibility: parsedArtifact.visibility,
    input: parsedArtifact.inputSchema,
    output: parsedArtifact.outputSchema,
    requestedAllowedActions: parsedArtifact.allowedActions.map((action) =>
      omitUndefined({
        id: action.id,
        maxCalls: action.maxCalls,
        timeoutMs: action.timeoutMs,
      }),
    ),
    effects: parsedArtifact.effects,
    timeout: parsedArtifact.timeout,
    confirmation: parsedArtifact.confirmation,
    audit: parsedArtifact.audit,
  });
}

export function toInteractionAuthoringWorkspacePublishRequest(
  publishRequest:
    | PublishInteractionRequest
    | InteractionAuthoringWorkspacePublishRequest,
  sourceForValidation = SOURCE_VALIDATION_PLACEHOLDER,
): InteractionAuthoringWorkspacePublishRequest {
  if (!isRecord(publishRequest)) {
    throw new Error("Tidegate authoring publish request must be an object.");
  }

  const parsed = PublishInteractionRequestSchema.parse({
    ...publishRequest,
    source: sourceForValidation,
  });
  const {
    provenance: _provenance,
    requireGreenTests: _requireGreenTests,
    source: _source,
    ...snapshot
  } = parsed;

  return omitUndefined(snapshot) as InteractionAuthoringWorkspacePublishRequest;
}

export function formatInteractionAuthoringPublishRequest(
  publishRequest:
    | PublishInteractionRequest
    | InteractionAuthoringWorkspacePublishRequest,
): string {
  return `${stableJson(
    toInteractionAuthoringWorkspacePublishRequest(publishRequest),
  )}\n`;
}

export function hashInteractionAuthoringSource(source: string): string {
  return sha256(assertText(source, "interaction source"));
}

export function hashInteractionAuthoringTest(testSource: string): string {
  return sha256(assertText(testSource, "interaction test source"));
}

export function hashInteractionAuthoringPublishRequest(
  publishRequest:
    | PublishInteractionRequest
    | InteractionAuthoringWorkspacePublishRequest,
): string {
  return sha256(formatInteractionAuthoringPublishRequest(publishRequest));
}

export function hashInteractionAuthoringWorkspaceFiles({
  publishRequest,
  source,
  testSource,
}: {
  publishRequest:
    | PublishInteractionRequest
    | InteractionAuthoringWorkspacePublishRequest;
  source: string;
  testSource: string;
}): InteractionAuthoringWorkspaceHashes {
  return {
    sourceHash: hashInteractionAuthoringSource(source),
    testHash: hashInteractionAuthoringTest(testSource),
    publishRequestHash: hashInteractionAuthoringPublishRequest(publishRequest),
  };
}

function sourceFromPublishRequest(
  publishRequest:
    | PublishInteractionRequest
    | InteractionAuthoringWorkspacePublishRequest,
): string | undefined {
  const request: Record<string, unknown> = isRecord(publishRequest)
    ? publishRequest
    : {};

  return typeof request.source === "string"
    ? request.source
    : undefined;
}

function assertActionCatalogSnapshotMatchesManifest({
  expected,
  manifest,
}: {
  expected: InteractionAuthoringWorkspaceActionCatalogSnapshot;
  manifest: TidegateActionCatalogManifestV1;
}) {
  if (
    expected.actionCatalogId === manifest.catalogId &&
    expected.actionCatalogVersion === manifest.version
  ) {
    return;
  }

  throw new Error(
    `Tidegate authoring workspace action catalog mismatch: snapshot uses ${expected.actionCatalogId}@${expected.actionCatalogVersion}, but the manifest is ${manifest.catalogId}@${manifest.version}.`,
  );
}

function normalizeWorkspaceRoot(rootDir: string): string {
  if (rootDir.length === 0) {
    throw new Error("Tidegate authoring workspace root cannot be empty.");
  }

  if (rootDir.includes("\0")) {
    throw new Error(
      "Tidegate authoring workspace root cannot contain NUL bytes.",
    );
  }

  return rootDir;
}

function safeInteractionWorkspaceDirectoryName(interactionId: string): string {
  const parsedInteractionId = assertNonEmptyText(
    interactionId,
    "interaction id",
  );

  if (
    parsedInteractionId === "." ||
    parsedInteractionId === ".." ||
    parsedInteractionId.includes("/") ||
    parsedInteractionId.includes("\\") ||
    parsedInteractionId.includes("\0")
  ) {
    throw new Error(
      "Tidegate authoring workspace interaction id must be a safe directory name without path separators.",
    );
  }

  return parsedInteractionId;
}

function assertNonEmptyText(value: unknown, name: string): string {
  const text = assertText(value, name);

  if (text.length === 0) {
    throw new Error(`Tidegate authoring workspace ${name} cannot be empty.`);
  }

  return text;
}

function assertText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Tidegate authoring workspace ${name} must be a string.`);
  }

  return value;
}

function omitUndefined<TValue extends Record<string, unknown>>(
  value: TValue,
): TValue {
  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }

  return result as TValue;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};

  for (const key of Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const item = sortJson(value[key]);

    if (item !== undefined) {
      sorted[key] = item;
    }
  }

  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
