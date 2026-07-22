import type {
  InteractionRecord,
  PublishedInteractionArtifact,
} from "@tidegate/contracts";
import {
  InteractionRecordSchema,
  PublishedInteractionArtifactSchema,
} from "@tidegate/contracts";
import { InteractionRegistryError } from "./interaction-registry-errors.ts";
import {
  assertNoCallerSuppliedOwnerFields,
  createdBySubjectIdFromAuth,
  deriveInteractionRegistryScope,
  interactionRecordKey,
  interactionScopeKey,
  INTERACTION_VISIBILITIES,
  OWNER_FIELD_NAMES,
  ownerFieldsForScope,
} from "./interaction-registry-scope.ts";
import type { InteractionRegistryScope } from "./interaction-registry-scope.ts";
import {
  immutableClone,
  toIsoTimestamp,
} from "./interaction-registry-storage.ts";
import type {
  CreatePublishedInteractionArtifactVersionInput,
  CreateScopedInteractionRecordInput,
  ListVisibleScopedInteractionsInput,
  MoveActiveInteractionVersionInput,
  PublishInteractionArtifactVersionInput,
  PublishInteractionArtifactVersionResult,
  ResolveScopedInteractionInput,
  ResolveScopedInteractionVersionInput,
  ResolveVisibleScopedInteractionInput,
  ScopedInteractionRecordResolution,
  ScopedInteractionResolution,
  SetInteractionAvailabilityStatusInput,
} from "./interaction-registry.ts";

export type AssertPublishedInteractionBaseInput = {
  branchId: string;
  interactionId: string;
  scope: InteractionRegistryScope;
  sourceHash: string;
  version: string;
};

export class InMemoryPublishedInteractionLedger {
  private readonly records = new Map<string, InteractionRecord>();
  private readonly artifactsByRecord = new Map<
    string,
    Map<string, PublishedInteractionArtifact>
  >();
  private readonly sourceByHashByScope = new Map<string, Map<string, string>>();

  createInteractionRecord(input: CreateScopedInteractionRecordInput) {
    assertNoCallerSuppliedOwnerFields(input, "interaction record");

    const scope = deriveInteractionRegistryScope(input.auth, input.visibility);
    const key = interactionRecordKey(scope, input.interactionId);

    if (this.records.has(key)) {
      throw new InteractionRegistryError(
        "unsafe_interaction_id_reuse",
        `Interaction "${input.interactionId}" already exists in this ${input.visibility} scope.`,
      );
    }

    const now = toIsoTimestamp(input.now);
    const record = InteractionRecordSchema.parse({
      id: input.interactionId,
      ...ownerFieldsForScope(scope),
      visibility: input.visibility,
      activeVersion: input.activeVersion,
      status: input.status ?? "active",
      title: input.title,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    });
    const storedRecord = immutableClone(record);

    this.records.set(key, storedRecord);

    return storedRecord;
  }

  createArtifactVersion(input: CreatePublishedInteractionArtifactVersionInput) {
    assertNoCallerSuppliedOwnerFields(input.artifact, "published artifact");

    const scope = deriveInteractionRegistryScope(
      input.auth,
      input.artifact.visibility,
    );
    const key = interactionRecordKey(scope, input.artifact.id);
    const record = this.records.get(key);

    if (record === undefined) {
      throw new InteractionRegistryError(
        "interaction_record_missing",
        `Interaction "${input.artifact.id}" does not exist in this ${input.artifact.visibility} scope.`,
      );
    }

    assertRecordCanReceivePublishedVersion(record);

    const versions = this.artifactsByRecord.get(key) ?? new Map();

    if (versions.has(input.artifact.version)) {
      throw new InteractionRegistryError(
        "interaction_version_exists",
        `Interaction "${input.artifact.id}" version "${input.artifact.version}" already exists in this scope.`,
      );
    }

    const artifact = PublishedInteractionArtifactSchema.parse({
      ...input.artifact,
      ...ownerFieldsForScope(scope),
      createdAt: input.artifact.createdAt ?? toIsoTimestamp(input.now),
      createdBySubjectId:
        input.artifact.createdBySubjectId ??
        input.createdBySubjectId ??
        createdBySubjectIdFromAuth(input.auth),
    });

    assertArtifactMatchesRecord(record, artifact);
    this.assertNoSourceHashCollision(scope, artifact);

    const storedArtifact = immutableClone(artifact);
    versions.set(storedArtifact.version, storedArtifact);
    this.artifactsByRecord.set(key, versions);
    this.recordSourceHash(scope, storedArtifact);

    return storedArtifact;
  }

  resolveActiveVersion(
    input: ResolveScopedInteractionInput,
  ): ScopedInteractionResolution | undefined {
    const scope = deriveInteractionRegistryScope(input.auth, input.visibility);
    const key = interactionRecordKey(scope, input.interactionId);
    const record = this.records.get(key);

    if (record === undefined || record.activeVersion === undefined) {
      return undefined;
    }

    const artifact = this.artifactsByRecord.get(key)?.get(record.activeVersion);

    if (artifact === undefined) {
      throw new InteractionRegistryError(
        "interaction_version_missing",
        `Interaction "${input.interactionId}" active version "${record.activeVersion}" is missing from this scope.`,
      );
    }

    return {
      scope,
      record,
      artifact,
    };
  }

  resolveVersion(
    input: ResolveScopedInteractionVersionInput,
  ): ScopedInteractionResolution | undefined {
    const scope = deriveInteractionRegistryScope(input.auth, input.visibility);
    const key = interactionRecordKey(scope, input.interactionId);
    const record = this.records.get(key);

    if (record === undefined) {
      return undefined;
    }

    const artifact = this.artifactsByRecord.get(key)?.get(input.version);

    if (artifact === undefined) {
      return undefined;
    }

    return {
      scope,
      record,
      artifact,
    };
  }

  listVisibleActiveVersions(
    input: ListVisibleScopedInteractionsInput,
  ): ScopedInteractionResolution[] {
    return this.listVisibleInteractionRecords(input)
      .filter(
        (resolution): resolution is ScopedInteractionResolution =>
          resolution.record.status === "active" &&
          resolution.artifact !== undefined,
      )
      .sort(compareScopedInteractionResolutions);
  }

  resolveVisibleInteraction(
    input: ResolveVisibleScopedInteractionInput,
  ): ScopedInteractionRecordResolution | undefined {
    const visibilities =
      input.visibility === undefined ? INTERACTION_VISIBILITIES : [input.visibility];

    for (const visibility of visibilities) {
      let scope: InteractionRegistryScope;

      try {
        scope = deriveInteractionRegistryScope(input.auth, visibility);
      } catch (error) {
        if (
          input.visibility === undefined &&
          error instanceof InteractionRegistryError &&
          error.code === "scope_unavailable"
        ) {
          continue;
        }

        throw error;
      }

      const key = interactionRecordKey(scope, input.interactionId);
      const record = this.records.get(key);

      if (record === undefined) {
        continue;
      }

      return {
        scope,
        record,
        artifact: this.resolveActiveArtifactForRecord(key, record),
      };
    }

    return undefined;
  }

  moveActiveVersion(input: MoveActiveInteractionVersionInput) {
    const scope = deriveInteractionRegistryScope(input.auth, input.visibility);
    const key = interactionRecordKey(scope, input.interactionId);
    const record = this.requireRecord(key, input);
    const versions = this.artifactsByRecord.get(key);

    if (versions?.has(input.nextVersion) !== true) {
      throw new InteractionRegistryError(
        "interaction_version_missing",
        `Interaction "${input.interactionId}" version "${input.nextVersion}" is missing from this scope.`,
      );
    }

    if ("expectedActiveVersion" in input) {
      const expectedActiveVersion = input.expectedActiveVersion ?? undefined;

      if (record.activeVersion !== expectedActiveVersion) {
        throw new InteractionRegistryError(
          "interaction_version_conflict",
          `Interaction "${input.interactionId}" active version changed from "${expectedActiveVersion ?? "none"}" to "${record.activeVersion ?? "none"}".`,
        );
      }
    }

    const updatedRecord = InteractionRecordSchema.parse({
      ...record,
      activeVersion: input.nextVersion,
      updatedAt: toIsoTimestamp(input.now),
    });
    const storedRecord = immutableClone(updatedRecord);

    this.records.set(key, storedRecord);

    return storedRecord;
  }

  publishArtifactVersion(
    input: PublishInteractionArtifactVersionInput,
  ): PublishInteractionArtifactVersionResult {
    const scope = deriveInteractionRegistryScope(
      input.auth,
      input.artifact.visibility,
    );

    return this.publishArtifactVersionInScope({
      ...input,
      scope,
    });
  }

  publishArtifactVersionInScope(
    input: PublishInteractionArtifactVersionInput & {
      scope: InteractionRegistryScope;
    },
  ): PublishInteractionArtifactVersionResult {
    assertNoCallerSuppliedOwnerFields(input.artifact, "published artifact");

    const key = interactionRecordKey(input.scope, input.artifact.id);
    const existingRecord = this.records.get(key);

    if (existingRecord !== undefined) {
      assertRecordCanReceivePublishedVersion(existingRecord);
    }

    if ("expectedActiveVersion" in input) {
      const expectedActiveVersion = input.expectedActiveVersion ?? undefined;

      if (existingRecord?.activeVersion !== expectedActiveVersion) {
        throw new InteractionRegistryError(
          "interaction_version_conflict",
          `Interaction "${input.artifact.id}" active version changed from "${expectedActiveVersion ?? "none"}" to "${existingRecord?.activeVersion ?? "none"}".`,
        );
      }
    }

    const now = toIsoTimestamp(input.now);
    const versions = this.artifactsByRecord.get(key) ?? new Map();
    const version = input.artifact.version ?? nextArtifactVersion(existingRecord);

    if (versions.has(version)) {
      throw new InteractionRegistryError(
        "interaction_version_exists",
        `Interaction "${input.artifact.id}" version "${version}" already exists in this scope.`,
      );
    }

    const record = InteractionRecordSchema.parse({
      ...(existingRecord ?? {
        id: input.artifact.id,
        ...ownerFieldsForScope(input.scope),
        visibility: input.artifact.visibility,
        status: "active",
        createdAt: now,
      }),
      title: input.title ?? existingRecord?.title,
      description: input.description ?? existingRecord?.description,
      activeVersion: version,
      status: existingRecord?.status ?? "active",
      updatedAt: now,
    });
    const artifact = PublishedInteractionArtifactSchema.parse({
      ...input.artifact,
      ...ownerFieldsForScope(input.scope),
      version,
      status: input.artifact.status ?? "active",
      parentVersion:
        input.artifact.parentVersion ?? existingRecord?.activeVersion,
      createdAt: input.artifact.createdAt ?? now,
      createdBySubjectId:
        input.artifact.createdBySubjectId ??
        input.createdBySubjectId ??
        createdBySubjectIdFromAuth(input.auth),
    });

    assertArtifactMatchesRecord(record, artifact);
    this.assertNoSourceHashCollision(input.scope, artifact);

    const storedRecord = immutableClone(record);
    const storedArtifact = immutableClone(artifact);
    const nextVersions = new Map(versions);

    nextVersions.set(storedArtifact.version, storedArtifact);
    this.artifactsByRecord.set(key, nextVersions);
    this.records.set(key, storedRecord);
    this.recordSourceHash(input.scope, storedArtifact);

    return {
      scope: input.scope,
      record: storedRecord,
      artifact: storedArtifact,
    };
  }

  setInteractionAvailabilityStatus(
    input: SetInteractionAvailabilityStatusInput,
  ) {
    const scope = deriveInteractionRegistryScope(input.auth, input.visibility);
    const key = interactionRecordKey(scope, input.interactionId);
    const record = this.requireRecord(key, input);
    const updatedRecord = InteractionRecordSchema.parse({
      ...record,
      status: input.status,
      updatedAt: toIsoTimestamp(input.now),
    });
    const storedRecord = immutableClone(updatedRecord);

    this.records.set(key, storedRecord);

    return storedRecord;
  }

  assertActiveVersionMatchesBranchSource({
    branchId,
    interactionId,
    scope,
    sourceHash,
    version,
  }: AssertPublishedInteractionBaseInput) {
    const key = interactionRecordKey(scope, interactionId);
    const record = this.records.get(key);
    const activeVersion = record?.activeVersion;
    const activeArtifact =
      activeVersion === undefined
        ? undefined
        : this.artifactsByRecord.get(key)?.get(activeVersion);

    if (
      activeVersion !== version ||
      activeArtifact?.sourceHash !== sourceHash
    ) {
      throw new InteractionRegistryError(
        "branch_base_changed",
        `Interaction "${interactionId}" active version changed after branch "${branchId}" was created.`,
      );
    }
  }

  private listVisibleInteractionRecords(
    input: ListVisibleScopedInteractionsInput,
  ): ScopedInteractionRecordResolution[] {
    const visibilities =
      input.visibility === undefined ? INTERACTION_VISIBILITIES : [input.visibility];
    const resolutions: ScopedInteractionRecordResolution[] = [];

    for (const visibility of visibilities) {
      let scope: InteractionRegistryScope;

      try {
        scope = deriveInteractionRegistryScope(input.auth, visibility);
      } catch (error) {
        if (
          input.visibility === undefined &&
          error instanceof InteractionRegistryError &&
          error.code === "scope_unavailable"
        ) {
          continue;
        }

        throw error;
      }

      for (const [key, record] of this.records) {
        if (interactionRecordKey(scope, record.id) !== key) {
          continue;
        }

        resolutions.push({
          scope,
          record,
          artifact: this.resolveActiveArtifactForRecord(key, record),
        });
      }
    }

    return resolutions;
  }

  private resolveActiveArtifactForRecord(
    key: string,
    record: InteractionRecord,
  ): PublishedInteractionArtifact | undefined {
    if (record.activeVersion === undefined) {
      return undefined;
    }

    const artifact = this.artifactsByRecord.get(key)?.get(record.activeVersion);

    if (artifact === undefined) {
      throw new InteractionRegistryError(
        "interaction_version_missing",
        `Interaction "${record.id}" active version "${record.activeVersion}" is missing from this scope.`,
      );
    }

    return artifact;
  }

  private requireRecord(
    key: string,
    input: ResolveScopedInteractionInput,
  ): InteractionRecord {
    const record = this.records.get(key);

    if (record === undefined) {
      throw new InteractionRegistryError(
        "interaction_record_missing",
        `Interaction "${input.interactionId}" does not exist in this ${input.visibility} scope.`,
      );
    }

    return record;
  }

  private assertNoSourceHashCollision(
    scope: InteractionRegistryScope,
    artifact: PublishedInteractionArtifact,
  ) {
    const key = interactionScopeKey(scope);
    const sourcesByHash = this.sourceByHashByScope.get(key) ?? new Map();
    const existingSource = sourcesByHash.get(artifact.sourceHash);

    if (existingSource !== undefined && existingSource !== artifact.source) {
      throw new InteractionRegistryError(
        "source_hash_collision",
        `Source hash "${artifact.sourceHash}" already belongs to different source in this ${scope.visibility} scope.`,
      );
    }
  }

  private recordSourceHash(
    scope: InteractionRegistryScope,
    artifact: PublishedInteractionArtifact,
  ) {
    const key = interactionScopeKey(scope);
    const sourcesByHash = this.sourceByHashByScope.get(key) ?? new Map();
    sourcesByHash.set(artifact.sourceHash, artifact.source);
    this.sourceByHashByScope.set(key, sourcesByHash);
  }
}

const INTERACTION_VISIBILITY_SORT_ORDER = new Map(
  INTERACTION_VISIBILITIES.map((visibility, index) => [visibility, index]),
);

function compareScopedInteractionResolutions(
  left: ScopedInteractionResolution,
  right: ScopedInteractionResolution,
) {
  const visibilityDiff =
    (INTERACTION_VISIBILITY_SORT_ORDER.get(left.record.visibility) ?? 0) -
    (INTERACTION_VISIBILITY_SORT_ORDER.get(right.record.visibility) ?? 0);

  if (visibilityDiff !== 0) {
    return visibilityDiff;
  }

  return left.record.id.localeCompare(right.record.id);
}

function assertArtifactMatchesRecord(
  record: InteractionRecord,
  artifact: PublishedInteractionArtifact,
) {
  if (record.id !== artifact.id) {
    throw new InteractionRegistryError(
      "interaction_record_missing",
      `Artifact "${artifact.id}" does not match interaction record "${record.id}".`,
    );
  }

  if (record.visibility !== artifact.visibility) {
    throw new InteractionRegistryError(
      "interaction_record_missing",
      `Artifact "${artifact.id}" visibility does not match its interaction record.`,
    );
  }

  for (const ownerField of OWNER_FIELD_NAMES) {
    if (record[ownerField] !== artifact[ownerField]) {
      throw new InteractionRegistryError(
        "interaction_record_missing",
        `Artifact "${artifact.id}" owner scope does not match its interaction record.`,
      );
    }
  }
}

function assertRecordCanReceivePublishedVersion(record: InteractionRecord) {
  if (record.status !== "revoked") {
    return;
  }

  throw new InteractionRegistryError(
    "interaction_unavailable",
    `Interaction "${record.id}" is revoked and cannot receive new published versions.`,
  );
}

function nextArtifactVersion(record: InteractionRecord | undefined) {
  if (record?.activeVersion === undefined) {
    return "1";
  }

  const activeVersionNumber = Number.parseInt(record.activeVersion, 10);

  if (
    Number.isSafeInteger(activeVersionNumber) &&
    String(activeVersionNumber) === record.activeVersion
  ) {
    return String(activeVersionNumber + 1);
  }

  return `${record.activeVersion}.1`;
}
