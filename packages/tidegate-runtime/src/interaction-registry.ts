import type {
  GeneratedInteractionContractV1,
  InteractionBranch,
  InteractionBranchPublishTarget,
  InteractionDraft,
  InteractionDraftProvenance,
  InteractionDraftStatus,
  InteractionAvailabilityStatus,
  InteractionRecord,
  InteractionVisibility,
  InvokeInteractionRequest,
  PublishInteractionRequest,
  PublishedInteractionArtifact,
  PublishedInteractionProvenance,
} from "@tidegate/contracts";
import {
  InteractionBranchSchema,
  InteractionDraftSchema,
} from "@tidegate/contracts";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import {
  publishValidatedInteractionDraft as publishValidatedInteractionDraftWithRegistry,
  type PublishValidatedInteractionDraftRegistryInput,
} from "./interaction-draft-publication.ts";
import {
  assertDraftSourceProvenanceMatchesArtifact,
  draftProvenanceFromPublishedProvenance,
  mergeDraftProvenance,
  publishedProvenanceFromDraft,
  withDraftPublishedProvenance,
  withPublishedArtifactProvenance,
} from "./interaction-provenance.ts";
import { InMemoryPublishedInteractionLedger } from "./interaction-published-ledger.ts";
import { InteractionRegistryError } from "./interaction-registry-errors.ts";
import {
  assertNoCallerSuppliedOwnerFields,
  deriveInteractionDraftRegistryScope,
  draftOwnerFieldsForScope,
  interactionBranchKey,
  interactionDraftKey,
  interactionRegistryScopeFromDraftScope,
  INTERACTION_VISIBILITIES,
} from "./interaction-registry-scope.ts";
import {
  createRegistryId,
  immutableClone,
  toIsoTimestamp,
} from "./interaction-registry-storage.ts";
import type {
  InteractionDraftRegistryScope,
  InteractionOwnerField,
  InteractionRegistryScope,
} from "./interaction-registry-scope.ts";

export { InteractionRegistryError } from "./interaction-registry-errors.ts";
export type { InteractionRegistryErrorCode } from "./interaction-registry-errors.ts";
export { deriveInteractionRegistryScope } from "./interaction-registry-scope.ts";
export type {
  InteractionDraftRegistryScope,
  InteractionOwnerField,
  InteractionRegistryScope,
} from "./interaction-registry-scope.ts";

export type InteractionRuntimeContext = {
  auth: RuntimeAuthContext;
  signal: AbortSignal;
  actions: {
    call: (actionId: string, input: unknown) => Promise<unknown>;
  };
};

export type StaticInteraction = {
  contract: GeneratedInteractionContractV1;
  run: (
    input: InvokeInteractionRequest["input"],
    ctx: InteractionRuntimeContext,
  ) => Promise<unknown>;
};

export function defineInteraction(interaction: StaticInteraction) {
  return interaction;
}

export function createInteractionRegistry(
  interactions: StaticInteraction[],
): Map<string, StaticInteraction> {
  return new Map(
    interactions.map((interaction) => [interaction.contract.id, interaction]),
  );
}

export type CreateScopedInteractionRecordInput = {
  auth: RuntimeAuthContext;
  interactionId: string;
  visibility: InteractionVisibility;
  activeVersion?: string;
  status?: InteractionAvailabilityStatus;
  title?: string;
  description?: string;
  now?: Date | string;
};

export type PublishedInteractionArtifactVersionInput = Omit<
  PublishedInteractionArtifact,
  InteractionOwnerField | "createdAt" | "createdBySubjectId"
> &
  Partial<
    Pick<PublishedInteractionArtifact, "createdAt" | "createdBySubjectId">
  >;

export type CreatePublishedInteractionArtifactVersionInput = {
  auth: RuntimeAuthContext;
  artifact: PublishedInteractionArtifactVersionInput;
  createdBySubjectId?: string;
  now?: Date | string;
};

export type ResolveScopedInteractionInput = {
  auth: RuntimeAuthContext;
  interactionId: string;
  visibility: InteractionVisibility;
};

export type ListVisibleScopedInteractionsInput = {
  auth: RuntimeAuthContext;
  visibility?: InteractionVisibility;
};

export type ResolveVisibleScopedInteractionInput = {
  auth: RuntimeAuthContext;
  interactionId: string;
  visibility?: InteractionVisibility;
};

export type ResolveScopedInteractionVersionInput =
  ResolveScopedInteractionInput & {
    version: string;
  };

export type MoveActiveInteractionVersionInput = ResolveScopedInteractionInput & {
  nextVersion: string;
  expectedActiveVersion?: string | null;
  now?: Date | string;
};

export type PublishInteractionArtifactVersionInput = {
  auth: RuntimeAuthContext;
  artifact: Omit<
    PublishedInteractionArtifactVersionInput,
    "parentVersion" | "status" | "version"
  > &
    Partial<
      Pick<
        PublishedInteractionArtifactVersionInput,
        "parentVersion" | "status" | "version"
      >
    >;
  title?: string;
  description?: string;
  createdBySubjectId?: string;
  expectedActiveVersion?: string | null;
  now?: Date | string;
};

export type PublishInteractionArtifactVersionResult = {
  scope: InteractionRegistryScope;
  record: InteractionRecord;
  artifact: PublishedInteractionArtifact;
};

export type InteractionDraftPublishRequestSnapshot = Omit<
  PublishInteractionRequest,
  "provenance" | "requireGreenTests" | "source"
>;

export type CreateInteractionDraftInput = {
  auth: RuntimeAuthContext;
  actionCatalogId: string;
  actionCatalogVersion: string;
  publishRequest: InteractionDraftPublishRequestSnapshot;
  source?: string;
  draftId?: string;
  branchId?: string;
  baseVersion?: string;
  baseSourceHash?: string;
  provenance?: InteractionDraftProvenance;
  status?: InteractionDraftStatus;
  now?: Date | string;
};

export type ResolveInteractionDraftInput = {
  auth: RuntimeAuthContext;
  draftId: string;
  allowReviewerAccess?: boolean;
};

export type UpdateInteractionDraftSourceInput = ResolveInteractionDraftInput & {
  source: string;
  provenance?: InteractionDraftProvenance;
  now?: Date | string;
};

export type SetInteractionDraftStatusInput = ResolveInteractionDraftInput & {
  status: InteractionDraftStatus;
  provenance?: InteractionDraftProvenance;
  now?: Date | string;
};

export type RecordInteractionDraftProvenanceInput = ResolveInteractionDraftInput & {
  provenance: InteractionDraftProvenance;
  now?: Date | string;
};

export type ScopedInteractionDraftResolution = {
  scope: InteractionDraftRegistryScope;
  draft: InteractionDraft;
  publishRequest: InteractionDraftPublishRequestSnapshot;
};

export type InteractionBranchSourceSnapshot = {
  interactionId: string;
  visibility: InteractionVisibility;
  version: string;
  sourceHash: string;
  source: string;
  actionCatalogId: string;
  actionCatalogVersion: string;
  provenance: PublishedInteractionProvenance;
  publishRequest: InteractionDraftPublishRequestSnapshot;
};

export type CreateInteractionBranchInput = {
  auth: RuntimeAuthContext;
  interactionId: string;
  visibility?: InteractionVisibility;
  version?: string;
  parentBranchId?: string;
  publishTarget?: InteractionBranchPublishTarget;
  requestedInteractionId?: string;
  title?: string;
  description?: string;
  name?: string;
  branchId?: string;
  draftId?: string;
  now?: Date | string;
};

export type ResolveInteractionBranchInput = {
  auth: RuntimeAuthContext;
  branchId: string;
  allowReviewerAccess?: boolean;
};

export type ResolveInteractionBranchForDraftInput = {
  auth: RuntimeAuthContext;
  draftId: string;
  allowReviewerAccess?: boolean;
};

export type ScopedInteractionBranchResolution = {
  scope: InteractionDraftRegistryScope;
  branch: InteractionBranch;
  draft: InteractionDraft;
  publishRequest: InteractionDraftPublishRequestSnapshot;
  source: InteractionBranchSourceSnapshot;
  publishTarget: InteractionBranchPublishTarget;
  targetInteractionId?: string;
};

export type PublishInteractionDraftArtifactVersionInput =
  ResolveInteractionDraftInput & {
    artifact: Omit<
      PublishedInteractionArtifactVersionInput,
      "parentVersion" | "status" | "version"
    > &
      Partial<
        Pick<
          PublishedInteractionArtifactVersionInput,
          "parentVersion" | "status" | "version"
        >
      >;
    title?: string;
    description?: string;
    createdBySubjectId?: string;
    expectedActiveVersion?: string | null;
    now?: Date | string;
  };

export type PublishInteractionDraftArtifactVersionResult =
  PublishInteractionArtifactVersionResult & {
    draft: InteractionDraft;
  };

export type PublishInteractionBranchDraftArtifactVersionInput =
  PublishInteractionDraftArtifactVersionInput & {
    publishTarget?: InteractionBranchPublishTarget;
    requestedInteractionId?: string;
  };

export type PublishInteractionBranchDraftArtifactVersionResult =
  PublishInteractionDraftArtifactVersionResult & {
    branch: InteractionBranch;
  };

export type SetInteractionAvailabilityStatusInput =
  ResolveScopedInteractionInput & {
    status: InteractionAvailabilityStatus;
    now?: Date | string;
  };

export type ScopedInteractionResolution = {
  scope: InteractionRegistryScope;
  record: InteractionRecord;
  artifact: PublishedInteractionArtifact;
};

export type ScopedInteractionRecordResolution = {
  scope: InteractionRegistryScope;
  record: InteractionRecord;
  artifact?: PublishedInteractionArtifact;
};

type StoredInteractionDraft = ScopedInteractionDraftResolution;
type StoredInteractionBranch = Omit<ScopedInteractionBranchResolution, "draft"> & {
  draftId: string;
};

export function createScopedInteractionRegistry() {
  return new InMemoryScopedInteractionRegistry();
}

export class InMemoryScopedInteractionRegistry {
  private readonly published = new InMemoryPublishedInteractionLedger();
  private readonly branchesByScopedKey = new Map<
    string,
    StoredInteractionBranch
  >();
  private readonly branchScopedKeyByBranchId = new Map<string, string>();
  private readonly branchIdByDraftId = new Map<string, string>();
  private readonly draftsByScopedKey = new Map<string, StoredInteractionDraft>();
  private readonly draftScopedKeyByDraftId = new Map<string, string>();

  createInteractionRecord(input: CreateScopedInteractionRecordInput) {
    return this.published.createInteractionRecord(input);
  }

  createArtifactVersion(input: CreatePublishedInteractionArtifactVersionInput) {
    return this.published.createArtifactVersion(input);
  }

  resolveActiveVersion(
    input: ResolveScopedInteractionInput,
  ): ScopedInteractionResolution | undefined {
    return this.published.resolveActiveVersion(input);
  }

  resolveVersion(
    input: ResolveScopedInteractionVersionInput,
  ): ScopedInteractionResolution | undefined {
    return this.published.resolveVersion(input);
  }

  listVisibleActiveVersions(
    input: ListVisibleScopedInteractionsInput,
  ): ScopedInteractionResolution[] {
    return this.published.listVisibleActiveVersions(input);
  }

  resolveVisibleInteraction(
    input: ResolveVisibleScopedInteractionInput,
  ): ScopedInteractionRecordResolution | undefined {
    return this.published.resolveVisibleInteraction(input);
  }

  moveActiveVersion(input: MoveActiveInteractionVersionInput) {
    return this.published.moveActiveVersion(input);
  }

  publishArtifactVersion(
    input: PublishInteractionArtifactVersionInput,
  ): PublishInteractionArtifactVersionResult {
    return this.published.publishArtifactVersion(input);
  }

  createBranch(input: CreateInteractionBranchInput): ScopedInteractionBranchResolution {
    assertNoCallerSuppliedOwnerFields(input, "interaction branch");

    const scope = deriveInteractionDraftRegistryScope(input.auth);
    const branchId = input.branchId ?? createRegistryId("branch");

    if (this.branchScopedKeyByBranchId.has(branchId)) {
      throw new InteractionRegistryError(
        "interaction_branch_exists",
        `Interaction branch "${branchId}" already exists.`,
      );
    }

    const key = interactionBranchKey(scope, branchId);
    const source = this.branchSourceSnapshot(input);
    const publishTarget = input.publishTarget ?? "same-interaction";
    const targetInteractionId =
      publishTarget === "same-interaction"
        ? source.interactionId
        : input.requestedInteractionId;
    const now = toIsoTimestamp(input.now);
    const branch = InteractionBranchSchema.parse({
      branchId,
      interactionId: source.interactionId,
      parentBranchId: input.parentBranchId,
      parentVersion: source.version,
      baseVersion: source.version,
      ...draftOwnerFieldsForScope(scope),
      baseSourceHash: source.sourceHash,
      publishTarget,
      targetInteractionId,
      name: input.name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const publishRequest = {
      ...source.publishRequest,
      requestedInteractionId: targetInteractionId ?? source.interactionId,
      title: input.title ?? source.publishRequest.title,
      description: input.description ?? source.publishRequest.description,
    };
    const draft = this.createDraft({
      actionCatalogId: source.actionCatalogId,
      actionCatalogVersion: source.actionCatalogVersion,
      auth: input.auth,
      baseSourceHash: source.sourceHash,
      baseVersion: source.version,
      branchId,
      draftId: input.draftId,
      now: input.now,
      publishRequest,
      provenance: draftProvenanceFromPublishedProvenance(source.provenance),
      source: source.source,
    });
    const storedBranch = immutableClone({
      scope,
      branch,
      draftId: draft.draft.draftId,
      publishRequest,
      source,
      publishTarget,
      targetInteractionId,
    });

    this.branchesByScopedKey.set(key, storedBranch);
    this.branchScopedKeyByBranchId.set(branchId, key);
    this.branchIdByDraftId.set(draft.draft.draftId, branchId);

    return {
      ...storedBranch,
      draft: draft.draft,
    };
  }

  resolveBranch(
    input: ResolveInteractionBranchInput,
  ): ScopedInteractionBranchResolution | undefined {
    const storageEntry = this.resolveBranchStorageEntry(input);

    if (storageEntry === undefined) {
      return undefined;
    }

    return this.branchResolutionFromStorageEntry(storageEntry.entry);
  }

  resolveBranchForDraft(
    input: ResolveInteractionBranchForDraftInput,
  ): ScopedInteractionBranchResolution | undefined {
    const draft = this.resolveDraftStorageEntry(input);

    if (draft === undefined) {
      return undefined;
    }

    const branchId = this.branchIdByDraftId.get(input.draftId);

    if (branchId === undefined) {
      return undefined;
    }

    const key = this.branchScopedKeyByBranchId.get(branchId);
    const entry = key === undefined ? undefined : this.branchesByScopedKey.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.draftId !== draft.entry.draft.draftId) {
      return undefined;
    }

    return this.branchResolutionFromStorageEntry(entry);
  }

  createDraft(input: CreateInteractionDraftInput): ScopedInteractionDraftResolution {
    const scope = deriveInteractionDraftRegistryScope(input.auth);
    const draftId = input.draftId ?? createRegistryId("draft");

    if (this.draftScopedKeyByDraftId.has(draftId)) {
      throw new InteractionRegistryError(
        "interaction_draft_exists",
        `Interaction draft "${draftId}" already exists.`,
      );
    }

    const key = interactionDraftKey(scope, draftId);
    const now = toIsoTimestamp(input.now);
    const draft = InteractionDraftSchema.parse({
      draftId,
      interactionId: input.publishRequest.requestedInteractionId,
      branchId: input.branchId ?? createRegistryId("branch"),
      ...draftOwnerFieldsForScope(scope),
      baseVersion: input.baseVersion,
      baseSourceHash: input.baseSourceHash,
      actionCatalogId: input.actionCatalogId,
      actionCatalogVersion: input.actionCatalogVersion,
      source: input.source ?? DEFAULT_INTERACTION_DRAFT_SOURCE,
      provenance: input.provenance,
      status: input.status ?? "draft",
      createdAt: now,
      updatedAt: now,
    });
    const storedDraft = immutableClone({
      scope,
      draft,
      publishRequest: input.publishRequest,
    });

    this.draftsByScopedKey.set(key, storedDraft);
    this.draftScopedKeyByDraftId.set(draftId, key);

    return storedDraft;
  }

  resolveDraft(
    input: ResolveInteractionDraftInput,
  ): ScopedInteractionDraftResolution | undefined {
    return this.resolveDraftStorageEntry(input)?.entry;
  }

  updateDraftSource(
    input: UpdateInteractionDraftSourceInput,
  ): ScopedInteractionDraftResolution {
    const { entry, key } = this.requireDraftStorageEntry(input);
    const sourceChanged = entry.draft.source !== input.source;
    const updatedDraft = InteractionDraftSchema.parse({
      ...entry.draft,
      source: input.source,
      provenance:
        input.provenance === undefined
          ? sourceChanged
            ? undefined
            : entry.draft.provenance
          : mergeDraftProvenance(
              sourceChanged ? undefined : entry.draft.provenance,
              input.provenance,
            ),
      status: "draft",
      updatedAt: toIsoTimestamp(input.now),
    });
    const storedDraft = immutableClone({
      ...entry,
      draft: updatedDraft,
    });

    this.draftsByScopedKey.set(key, storedDraft);

    return storedDraft;
  }

  setDraftStatus(
    input: SetInteractionDraftStatusInput,
  ): ScopedInteractionDraftResolution {
    const { entry, key } = this.requireDraftStorageEntry(input);
    const updatedDraft = InteractionDraftSchema.parse({
      ...entry.draft,
      status: input.status,
      provenance: mergeDraftProvenance(
        entry.draft.provenance,
        input.provenance,
      ),
      updatedAt: toIsoTimestamp(input.now),
    });
    const storedDraft = immutableClone({
      ...entry,
      draft: updatedDraft,
    });

    this.draftsByScopedKey.set(key, storedDraft);

    return storedDraft;
  }

  recordDraftProvenance(
    input: RecordInteractionDraftProvenanceInput,
  ): ScopedInteractionDraftResolution {
    const { entry, key } = this.requireDraftStorageEntry(input);
    const updatedDraft = InteractionDraftSchema.parse({
      ...entry.draft,
      provenance: mergeDraftProvenance(
        entry.draft.provenance,
        input.provenance,
      ),
      updatedAt: toIsoTimestamp(input.now),
    });
    const storedDraft = immutableClone({
      ...entry,
      draft: updatedDraft,
    });

    this.draftsByScopedKey.set(key, storedDraft);

    return storedDraft;
  }

  publishDraftArtifactVersion(
    input: PublishInteractionDraftArtifactVersionInput,
  ): PublishInteractionDraftArtifactVersionResult {
    const { entry } = this.requireDraftStorageEntry(input);

    if (
      entry.draft.source !== input.artifact.source ||
      entry.draft.actionCatalogId !== input.artifact.actionCatalogId ||
      entry.draft.actionCatalogVersion !== input.artifact.actionCatalogVersion
    ) {
      throw new InteractionRegistryError(
        "interaction_draft_source_conflict",
        `Interaction draft "${input.draftId}" changed before publish could use its validated source snapshot.`,
      );
    }
    assertDraftSourceProvenanceMatchesArtifact(entry.draft, input.artifact);

    const artifact = withDraftPublishedProvenance(input.artifact, entry.draft);
    const published = this.published.publishArtifactVersionInScope({
      ...input,
      artifact,
      scope: interactionRegistryScopeFromDraftScope(
        entry.scope,
        input.artifact.visibility,
      ),
    });

    return {
      ...published,
      draft: entry.draft,
    };
  }

  publishBranchDraftArtifactVersion(
    input: PublishInteractionBranchDraftArtifactVersionInput,
  ): PublishInteractionBranchDraftArtifactVersionResult {
    const { entry } = this.requireDraftStorageEntry(input);
    const branchEntry = this.requireBranchStorageEntryForDraft(input.draftId);

    if (branchEntry.branch.status !== "active") {
      throw new InteractionRegistryError(
        "interaction_version_conflict",
        `Interaction branch "${branchEntry.branch.branchId}" is ${branchEntry.branch.status}.`,
      );
    }

    if (
      entry.draft.source !== input.artifact.source ||
      entry.draft.actionCatalogId !== input.artifact.actionCatalogId ||
      entry.draft.actionCatalogVersion !== input.artifact.actionCatalogVersion
    ) {
      throw new InteractionRegistryError(
        "interaction_draft_source_conflict",
        `Interaction draft "${input.draftId}" changed before publish could use its validated source snapshot.`,
      );
    }
    assertDraftSourceProvenanceMatchesArtifact(entry.draft, input.artifact);

    const artifact = withDraftPublishedProvenance(input.artifact, entry.draft);
    const publishTarget = input.publishTarget ?? branchEntry.publishTarget;
    const targetInteractionId =
      input.requestedInteractionId ??
      branchEntry.targetInteractionId ??
      (publishTarget === "same-interaction"
        ? branchEntry.source.interactionId
        : input.artifact.id);

    if (
      publishTarget === "same-interaction" &&
      targetInteractionId !== branchEntry.source.interactionId
    ) {
      throw new InteractionRegistryError(
        "interaction_draft_source_conflict",
        `Interaction branch "${branchEntry.branch.branchId}" cannot publish a same-interaction update to "${targetInteractionId}".`,
      );
    }

    const scope = interactionRegistryScopeFromDraftScope(
      entry.scope,
      input.artifact.visibility,
    );

    if (publishTarget === "same-interaction") {
      this.published.assertActiveVersionMatchesBranchSource({
        branchId: branchEntry.branch.branchId,
        interactionId: branchEntry.source.interactionId,
        scope,
        sourceHash: branchEntry.source.sourceHash,
        version: branchEntry.source.version,
      });
    }

    const published = this.published.publishArtifactVersionInScope({
      ...input,
      artifact: {
        ...artifact,
        id: targetInteractionId,
        parentVersion:
          artifact.parentVersion ??
          branchEntry.branch.baseVersion ??
          branchEntry.branch.parentVersion ??
          branchEntry.source.version,
        publishedFromBranchId:
          artifact.publishedFromBranchId ?? branchEntry.branch.branchId,
      },
      expectedActiveVersion:
        publishTarget === "same-interaction"
          ? branchEntry.source.version
          : (input.expectedActiveVersion ?? null),
      scope,
    });
    const updatedBranch = InteractionBranchSchema.parse({
      ...branchEntry.branch,
      publishTarget,
      targetInteractionId,
      status: "merged",
      updatedAt: toIsoTimestamp(input.now),
    });
    const storedBranch = immutableClone({
      ...branchEntry,
      branch: updatedBranch,
      publishTarget,
      targetInteractionId,
    });
    const key = this.branchScopedKeyByBranchId.get(branchEntry.branch.branchId);

    if (key !== undefined) {
      this.branchesByScopedKey.set(key, storedBranch);
    }

    return {
      ...published,
      branch: updatedBranch,
      draft: entry.draft,
    };
  }

  publishValidatedInteractionDraft(
    input: PublishValidatedInteractionDraftRegistryInput,
  ) {
    return publishValidatedInteractionDraftWithRegistry({
      ...input,
      registry: this,
    });
  }

  setInteractionAvailabilityStatus(
    input: SetInteractionAvailabilityStatusInput,
  ) {
    return this.published.setInteractionAvailabilityStatus(input);
  }

  private branchSourceSnapshot(
    input: CreateInteractionBranchInput,
  ): InteractionBranchSourceSnapshot {
    if (input.parentBranchId !== undefined) {
      return this.branchSourceSnapshotFromParentBranch({
        ...input,
        parentBranchId: input.parentBranchId,
      });
    }

    return this.branchSourceSnapshotFromArtifact(input);
  }

  private branchSourceSnapshotFromParentBranch(
    input: CreateInteractionBranchInput & { parentBranchId: string },
  ): InteractionBranchSourceSnapshot {
    const parentBranch = this.requireBranchStorageEntry({
      auth: input.auth,
      branchId: input.parentBranchId,
    }).entry;
    const parentDraft = this.requireDraftStorageEntry({
      auth: input.auth,
      draftId: parentBranch.draftId,
    }).entry;

    if (parentBranch.source.interactionId !== input.interactionId) {
      throw new InteractionRegistryError(
        "interaction_branch_missing",
        `Interaction branch "${input.parentBranchId}" does not belong to interaction "${input.interactionId}".`,
      );
    }

    return {
      ...parentBranch.source,
      actionCatalogId: parentDraft.draft.actionCatalogId,
      actionCatalogVersion: parentDraft.draft.actionCatalogVersion,
      publishRequest: parentDraft.publishRequest,
      provenance: publishedProvenanceFromDraft(
        parentBranch.source.provenance,
        parentDraft.draft,
      ),
      source: parentDraft.draft.source,
    };
  }

  private branchSourceSnapshotFromArtifact(
    input: CreateInteractionBranchInput,
  ): InteractionBranchSourceSnapshot {
    const resolution = this.resolveBranchArtifactSource(input);

    if (resolution === undefined) {
      throw new InteractionRegistryError(
        "interaction_version_missing",
        input.version === undefined
          ? `Interaction "${input.interactionId}" does not have an active version in this scope.`
          : `Interaction "${input.interactionId}" version "${input.version}" does not exist in this scope.`,
      );
    }

    const { artifact, record } = resolution;

    return {
      interactionId: artifact.id,
      visibility: artifact.visibility,
      version: artifact.version,
      sourceHash: artifact.sourceHash,
      source: artifact.source,
      actionCatalogId: artifact.actionCatalogId,
      actionCatalogVersion: artifact.actionCatalogVersion,
      provenance: withPublishedArtifactProvenance(artifact).provenance,
      publishRequest: publishRequestSnapshotFromArtifact(record, artifact),
    };
  }

  private resolveBranchArtifactSource(
    input: CreateInteractionBranchInput,
  ): ScopedInteractionResolution | undefined {
    const visibilities =
      input.visibility === undefined ? INTERACTION_VISIBILITIES : [input.visibility];
    const matches: ScopedInteractionResolution[] = [];

    for (const visibility of visibilities) {
      try {
        const resolution =
          input.version === undefined
            ? this.resolveActiveVersion({
                auth: input.auth,
                interactionId: input.interactionId,
                visibility,
              })
            : this.resolveVersion({
                auth: input.auth,
                interactionId: input.interactionId,
                version: input.version,
                visibility,
              });

        if (resolution !== undefined) {
          matches.push(resolution);
        }
      } catch (error) {
        if (
          input.visibility !== undefined ||
          !(error instanceof InteractionRegistryError) ||
          error.code !== "scope_unavailable"
        ) {
          throw error;
        }
      }
    }

    if (matches.length > 1) {
      throw new InteractionRegistryError(
        "interaction_version_conflict",
        `Interaction "${input.interactionId}" exists in more than one visible scope; pass visibility when creating a branch.`,
      );
    }

    return matches[0];
  }

  private requireBranchStorageEntry(
    input: ResolveInteractionBranchInput,
  ): {
    key: string;
    entry: StoredInteractionBranch;
  } {
    const storageEntry = this.resolveBranchStorageEntry(input);

    if (storageEntry === undefined) {
      throw new InteractionRegistryError(
        "interaction_branch_missing",
        `Interaction branch "${input.branchId}" does not exist in this scope.`,
      );
    }

    return storageEntry;
  }

  private resolveBranchStorageEntry(
    input: ResolveInteractionBranchInput,
  ):
    | {
        key: string;
        entry: StoredInteractionBranch;
      }
    | undefined {
    let ownerScopedKey: string | undefined;

    try {
      ownerScopedKey = interactionBranchKey(
        deriveInteractionDraftRegistryScope(input.auth),
        input.branchId,
      );
    } catch (error) {
      if (
        !input.allowReviewerAccess ||
        !(error instanceof InteractionRegistryError) ||
        error.code !== "scope_unavailable"
      ) {
        throw error;
      }
    }

    if (ownerScopedKey !== undefined) {
      const ownEntry = this.branchesByScopedKey.get(ownerScopedKey);

      if (ownEntry !== undefined) {
        return {
          key: ownerScopedKey,
          entry: ownEntry,
        };
      }
    }

    if (!input.allowReviewerAccess) {
      return undefined;
    }

    const reviewerScopedKey = this.branchScopedKeyByBranchId.get(input.branchId);

    if (reviewerScopedKey === undefined) {
      return undefined;
    }

    const reviewerEntry = this.branchesByScopedKey.get(reviewerScopedKey);

    if (reviewerEntry === undefined) {
      return undefined;
    }

    return {
      key: reviewerScopedKey,
      entry: reviewerEntry,
    };
  }

  private requireBranchStorageEntryForDraft(
    draftId: string,
  ): StoredInteractionBranch {
    const branchId = this.branchIdByDraftId.get(draftId);
    const branchKey =
      branchId === undefined ? undefined : this.branchScopedKeyByBranchId.get(branchId);
    const branchEntry =
      branchKey === undefined ? undefined : this.branchesByScopedKey.get(branchKey);

    if (branchEntry === undefined) {
      throw new InteractionRegistryError(
        "interaction_branch_missing",
        `Interaction draft "${draftId}" is not backed by an interaction branch.`,
      );
    }

    return branchEntry;
  }

  private branchResolutionFromStorageEntry(
    entry: StoredInteractionBranch,
  ): ScopedInteractionBranchResolution {
    const draftKey = this.draftScopedKeyByDraftId.get(entry.draftId);
    const draftEntry =
      draftKey === undefined ? undefined : this.draftsByScopedKey.get(draftKey);

    if (draftEntry === undefined) {
      throw new InteractionRegistryError(
        "interaction_draft_missing",
        `Interaction branch "${entry.branch.branchId}" draft "${entry.draftId}" is missing.`,
      );
    }

    return {
      scope: entry.scope,
      branch: entry.branch,
      draft: draftEntry.draft,
      publishRequest: draftEntry.publishRequest,
      source: entry.source,
      publishTarget: entry.publishTarget,
      targetInteractionId: entry.targetInteractionId,
    };
  }

  private requireDraftStorageEntry(input: ResolveInteractionDraftInput): {
    key: string;
    entry: StoredInteractionDraft;
  } {
    const storageEntry = this.resolveDraftStorageEntry(input);

    if (storageEntry === undefined) {
      throw new InteractionRegistryError(
        "interaction_draft_missing",
        `Interaction draft "${input.draftId}" does not exist in this scope.`,
      );
    }

    return storageEntry;
  }

  private resolveDraftStorageEntry(
    input: ResolveInteractionDraftInput,
  ):
    | {
        key: string;
        entry: StoredInteractionDraft;
      }
    | undefined {
    let ownerScopedKey: string | undefined;

    try {
      ownerScopedKey = interactionDraftKey(
        deriveInteractionDraftRegistryScope(input.auth),
        input.draftId,
      );
    } catch (error) {
      if (
        !input.allowReviewerAccess ||
        !(error instanceof InteractionRegistryError) ||
        error.code !== "scope_unavailable"
      ) {
        throw error;
      }
    }

    if (ownerScopedKey !== undefined) {
      const ownEntry = this.draftsByScopedKey.get(ownerScopedKey);

      if (ownEntry !== undefined) {
        return {
          key: ownerScopedKey,
          entry: ownEntry,
        };
      }
    }

    if (!input.allowReviewerAccess) {
      return undefined;
    }

    const reviewerScopedKey = this.draftScopedKeyByDraftId.get(input.draftId);

    if (reviewerScopedKey === undefined) {
      return undefined;
    }

    const reviewerEntry = this.draftsByScopedKey.get(reviewerScopedKey);

    if (reviewerEntry === undefined) {
      return undefined;
    }

    return {
      key: reviewerScopedKey,
      entry: reviewerEntry,
    };
  }
}

function publishRequestSnapshotFromArtifact(
  record: InteractionRecord,
  artifact: PublishedInteractionArtifact,
): InteractionDraftPublishRequestSnapshot {
  return {
    requestedInteractionId: artifact.id,
    title: record.title,
    description: record.description,
    visibility: artifact.visibility,
    input: artifact.inputSchema,
    output: artifact.outputSchema,
    requestedAllowedActions: artifact.allowedActions.map((action) => ({
      id: action.id,
      maxCalls: action.maxCalls,
      timeoutMs: action.timeoutMs,
    })),
    effects: artifact.effects,
    timeout: artifact.timeout,
    confirmation: artifact.confirmation,
    audit: artifact.audit,
  };
}

const DEFAULT_INTERACTION_DRAFT_SOURCE =
  "// Tidegate draft source has not been written yet.";
