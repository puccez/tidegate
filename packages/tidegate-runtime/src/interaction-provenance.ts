import type {
  InteractionDraft,
  InteractionDraftProvenance,
  InteractionDraftTestMetadata,
  PublishedInteractionProvenance,
  PublishInteractionProvenanceEvidence,
  PublishInteractionRequest,
} from "@tidegate/contracts";
import {
  hashInteractionAuthoringPublishRequest,
  hashInteractionAuthoringTest,
} from "./interaction-authoring-workspace.ts";
import { InteractionRegistryError } from "./interaction-registry-errors.ts";

export type InteractionProvenanceActionCatalogMetadata = {
  id: string;
  version: string;
};

export type PublishGateDiagnostic = {
  actual?: string;
  code: string;
  expected?: string;
  field?: string;
  message: string;
  severity: "error";
};

export function createValidationPublishEvidence({
  now = () => new Date(),
  publishRequest,
  sourceHash,
}: {
  now?: () => Date;
  publishRequest: PublishInteractionRequest;
  sourceHash: string;
}): InteractionDraftProvenance {
  return {
    sourceHash,
    publishRequestHash: hashInteractionAuthoringPublishRequest(publishRequest),
    validationResultAt: now().toISOString(),
  };
}

export function createTestPublishEvidence({
  now = () => new Date(),
  publishRequest,
  sourceHash,
  testMetadata,
  testSource,
  validationResultAt,
  vitestResultAt = now().toISOString(),
}: {
  now?: () => Date;
  publishRequest: PublishInteractionRequest;
  sourceHash: string;
  testMetadata: InteractionDraftTestMetadata;
  testSource: string;
  validationResultAt?: string;
  vitestResultAt?: string;
}): InteractionDraftProvenance {
  return {
    sourceHash,
    testHash: hashInteractionAuthoringTest(testSource),
    testSource,
    testMetadata,
    publishRequestHash: hashInteractionAuthoringPublishRequest(publishRequest),
    ...(validationResultAt === undefined ? {} : { validationResultAt }),
    vitestResultAt,
  };
}

export function publishGateDiagnostics({
  actionCatalogMetadata,
  evidence,
  publishRequest,
  requireActionCatalogEvidence = false,
  requirePreview = false,
  sourceHash: expectedSourceHash,
}: {
  actionCatalogMetadata: InteractionProvenanceActionCatalogMetadata;
  evidence:
    | PublishInteractionProvenanceEvidence
    | InteractionDraftProvenance
    | undefined;
  publishRequest: PublishInteractionRequest;
  requireActionCatalogEvidence?: boolean;
  requirePreview?: boolean;
  sourceHash: string;
}): PublishGateDiagnostic[] {
  const diagnostics: PublishGateDiagnostic[] = [];
  const expectedPublishRequestHash =
    hashInteractionAuthoringPublishRequest(publishRequest);

  if (evidence === undefined) {
    return [
      gateDiagnostic({
        code: "publish_gate_tests_missing",
        field: "provenance",
        message:
          "Green-test evidence is required before publishing this interaction.",
      }),
    ];
  }

  if (evidence.sourceHash === undefined) {
    diagnostics.push(
      gateDiagnostic({
        code: "publish_gate_source_hash_missing",
        field: "provenance.sourceHash",
        message: "Publish evidence must include the validated source hash.",
      }),
    );
  } else if (evidence.sourceHash !== expectedSourceHash) {
    diagnostics.push(
      gateDiagnostic({
        actual: evidence.sourceHash,
        code: "publish_gate_source_stale",
        expected: expectedSourceHash,
        field: "provenance.sourceHash",
        message:
          "The latest green-test evidence is stale relative to the interaction source.",
      }),
    );
  }

  if (evidence.testHash === undefined || evidence.vitestResultAt === undefined) {
    diagnostics.push(
      gateDiagnostic({
        code: "publish_gate_tests_missing",
        field:
          evidence.testHash === undefined
            ? "provenance.testHash"
            : "provenance.vitestResultAt",
        message: "A passing test run must be recorded before publishing.",
      }),
    );
  }

  const testStatus = testMetadataStatus(evidence.testMetadata);

  if (testStatus !== true) {
    diagnostics.push(
      gateDiagnostic({
        code: "publish_gate_tests_failed",
        field: "provenance.testMetadata",
        message: "The latest recorded test run must be explicitly passing.",
      }),
    );
  }

  if (
    evidence.testHash !== undefined &&
    evidence.testSource !== undefined &&
    evidence.testHash !== hashInteractionAuthoringTest(evidence.testSource)
  ) {
    diagnostics.push(
      gateDiagnostic({
        actual: evidence.testHash,
        code: "publish_gate_tests_stale",
        expected: hashInteractionAuthoringTest(evidence.testSource),
        field: "provenance.testHash",
        message:
          "The latest recorded test run is stale relative to the interaction tests.",
      }),
    );
  }

  if (evidence.publishRequestHash === undefined) {
    diagnostics.push(
      gateDiagnostic({
        code: "publish_gate_request_hash_missing",
        field: "provenance.publishRequestHash",
        message: "Publish evidence must include the validated publish request hash.",
      }),
    );
  } else if (evidence.publishRequestHash !== expectedPublishRequestHash) {
    diagnostics.push(
      gateDiagnostic({
        actual: evidence.publishRequestHash,
        code: "publish_gate_request_stale",
        expected: expectedPublishRequestHash,
        field: "provenance.publishRequestHash",
        message:
          "The latest green-test evidence is stale relative to the publish request.",
      }),
    );
  }

  if ("actionCatalogId" in evidence && evidence.actionCatalogId !== undefined) {
    if (evidence.actionCatalogId !== actionCatalogMetadata.id) {
      diagnostics.push(
        gateDiagnostic({
          actual: evidence.actionCatalogId,
          code: "publish_gate_action_catalog_stale",
          expected: actionCatalogMetadata.id,
          field: "provenance.actionCatalogId",
          message:
            "The latest green-test evidence is stale relative to the action catalog.",
        }),
      );
    }
  } else if (requireActionCatalogEvidence) {
    diagnostics.push(
      gateDiagnostic({
        code: "publish_gate_action_catalog_missing",
        field: "provenance.actionCatalogId",
        message: "Publish evidence must include the action catalog id.",
      }),
    );
  }

  if (
    "actionCatalogVersion" in evidence &&
    evidence.actionCatalogVersion !== undefined
  ) {
    if (evidence.actionCatalogVersion !== actionCatalogMetadata.version) {
      diagnostics.push(
        gateDiagnostic({
          actual: evidence.actionCatalogVersion,
          code: "publish_gate_action_catalog_stale",
          expected: actionCatalogMetadata.version,
          field: "provenance.actionCatalogVersion",
          message:
            "The latest green-test evidence is stale relative to the action catalog version.",
        }),
      );
    }
  } else if (requireActionCatalogEvidence) {
    diagnostics.push(
      gateDiagnostic({
        code: "publish_gate_action_catalog_missing",
        field: "provenance.actionCatalogVersion",
        message: "Publish evidence must include the action catalog version.",
      }),
    );
  }

  if (evidence.validationResultAt === undefined) {
    diagnostics.push(
      gateDiagnostic({
        code: "publish_gate_validation_missing",
        field: "provenance.validationResultAt",
        message: "A passing validation/typecheck result must be recorded before publishing.",
      }),
    );
  }

  if (requirePreview && evidence.previewResultAt === undefined) {
    diagnostics.push(
      gateDiagnostic({
        code: "publish_gate_preview_missing",
        field: "provenance.previewResultAt",
        message: "A passing preview result must be recorded before publishing.",
      }),
    );
  }

  return diagnostics;
}

export function publishedProvenanceFromEvidence({
  actionCatalogMetadata,
  evidence,
  sourceHash,
}: {
  actionCatalogMetadata: InteractionProvenanceActionCatalogMetadata;
  evidence: PublishInteractionProvenanceEvidence;
  sourceHash: string;
}): PublishedInteractionProvenance {
  return compactProvenance({
    sourceHash,
    testHash: evidence.testHash,
    publishRequestHash: evidence.publishRequestHash,
    actionCatalogId: actionCatalogMetadata.id,
    actionCatalogVersion: actionCatalogMetadata.version,
    validationResultAt: evidence.validationResultAt,
    vitestResultAt: evidence.vitestResultAt,
    previewResultAt: evidence.previewResultAt,
  });
}

export function testMetadataStatus(metadata: unknown): boolean | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  let hasExplicitPass = false;

  for (const field of ["ok", "passed"] as const) {
    const value = metadata[field];

    if (typeof value === "boolean") {
      if (!value) {
        return false;
      }

      hasExplicitPass = true;
    }
  }

  const status = metadata.status;

  if (typeof status === "string") {
    const normalized = status.toLowerCase();

    if (["ok", "pass", "passed", "green", "success"].includes(normalized)) {
      hasExplicitPass = true;
    }

    if (["fail", "failed", "red", "failure", "timeout"].includes(normalized)) {
      return false;
    }
  }

  const exitCode = metadata.exitCode;

  if (typeof exitCode === "number") {
    if (exitCode === 0) {
      hasExplicitPass = true;
    } else {
      return false;
    }
  }

  return hasExplicitPass ? true : undefined;
}

export function mergeDraftProvenance(
  existing: InteractionDraftProvenance | undefined,
  patch: InteractionDraftProvenance | undefined,
): InteractionDraftProvenance | undefined {
  if (patch === undefined) {
    return existing;
  }

  const merged = omitUndefinedProperties({
    ...existing,
    ...patch,
  });

  return Object.keys(merged).length === 0
    ? undefined
    : (merged as InteractionDraftProvenance);
}

export function assertDraftSourceProvenanceMatchesArtifact(
  draft: InteractionDraft,
  artifact: { sourceHash: string },
) {
  const provenance = draft.provenance;

  if (provenance === undefined) {
    return;
  }

  if (provenance.sourceHash === undefined) {
    if (!hasPublishedDraftProvenanceEvidence(provenance)) {
      return;
    }

    throw new InteractionRegistryError(
      "interaction_draft_source_conflict",
      `Interaction draft "${draft.draftId}" has validation provenance without a sourceHash.`,
    );
  }

  if (provenance.sourceHash === artifact.sourceHash) {
    return;
  }

  throw new InteractionRegistryError(
    "interaction_draft_source_conflict",
    `Interaction draft "${draft.draftId}" provenance sourceHash does not match the artifact sourceHash.`,
  );
}

export function withPublishedArtifactProvenance<
  T extends {
    sourceHash: string;
    actionCatalogId: string;
    actionCatalogVersion: string;
    provenance?: PublishedInteractionProvenance;
  },
>(artifact: T): T & { provenance: PublishedInteractionProvenance } {
  return {
    ...artifact,
    provenance:
      artifact.provenance ??
      compactProvenance({
        sourceHash: artifact.sourceHash,
        actionCatalogId: artifact.actionCatalogId,
        actionCatalogVersion: artifact.actionCatalogVersion,
      }),
  };
}

export function withDraftPublishedProvenance<
  T extends {
    sourceHash: string;
    actionCatalogId: string;
    actionCatalogVersion: string;
    provenance?: PublishedInteractionProvenance;
  },
>(
  artifact: T,
  draft: InteractionDraft,
): T & { provenance: PublishedInteractionProvenance } {
  assertExplicitPublishedProvenanceMatchesDraft(artifact, draft);

  return {
    ...artifact,
    provenance: compactProvenance({
      sourceHash: artifact.provenance?.sourceHash ?? artifact.sourceHash,
      testHash: artifact.provenance?.testHash ?? draft.provenance?.testHash,
      publishRequestHash:
        artifact.provenance?.publishRequestHash ??
        draft.provenance?.publishRequestHash,
      actionCatalogId:
        artifact.provenance?.actionCatalogId ?? artifact.actionCatalogId,
      actionCatalogVersion:
        artifact.provenance?.actionCatalogVersion ??
        artifact.actionCatalogVersion,
      validationResultAt:
        artifact.provenance?.validationResultAt ??
        draft.provenance?.validationResultAt,
      vitestResultAt:
        artifact.provenance?.vitestResultAt ?? draft.provenance?.vitestResultAt,
      previewResultAt:
        artifact.provenance?.previewResultAt ?? draft.provenance?.previewResultAt,
    }),
  };
}

export function publishedProvenanceFromDraft(
  fallback: PublishedInteractionProvenance,
  draft: InteractionDraft,
): PublishedInteractionProvenance {
  return compactProvenance({
    sourceHash: draft.provenance?.sourceHash ?? fallback.sourceHash,
    testHash: draft.provenance?.testHash ?? fallback.testHash,
    publishRequestHash:
      draft.provenance?.publishRequestHash ?? fallback.publishRequestHash,
    actionCatalogId: draft.actionCatalogId,
    actionCatalogVersion: draft.actionCatalogVersion,
    validationResultAt:
      draft.provenance?.validationResultAt ?? fallback.validationResultAt,
    vitestResultAt: draft.provenance?.vitestResultAt ?? fallback.vitestResultAt,
    previewResultAt: draft.provenance?.previewResultAt ?? fallback.previewResultAt,
  });
}

export function draftProvenanceFromPublishedProvenance(
  provenance: PublishedInteractionProvenance,
): InteractionDraftProvenance {
  return omitUndefinedProperties({
    sourceHash: provenance.sourceHash,
    testHash: provenance.testHash,
    publishRequestHash: provenance.publishRequestHash,
    validationResultAt: provenance.validationResultAt,
    vitestResultAt: provenance.vitestResultAt,
    previewResultAt: provenance.previewResultAt,
  }) as InteractionDraftProvenance;
}

function assertExplicitPublishedProvenanceMatchesDraft(
  artifact: {
    sourceHash: string;
    actionCatalogId: string;
    actionCatalogVersion: string;
    provenance?: PublishedInteractionProvenance;
  },
  draft: InteractionDraft,
) {
  if (artifact.provenance === undefined) {
    return;
  }

  if (
    artifact.provenance.sourceHash !== artifact.sourceHash ||
    artifact.provenance.actionCatalogId !== artifact.actionCatalogId ||
    artifact.provenance.actionCatalogVersion !== artifact.actionCatalogVersion
  ) {
    throw new InteractionRegistryError(
      "interaction_draft_source_conflict",
      `Interaction draft "${draft.draftId}" artifact provenance does not match the artifact snapshot.`,
    );
  }

  if (draft.provenance === undefined) {
    if (hasPublishedArtifactProvenanceEvidence(artifact.provenance)) {
      throw new InteractionRegistryError(
        "interaction_draft_source_conflict",
        `Interaction draft "${draft.draftId}" artifact provenance includes evidence that was not recorded on the draft.`,
      );
    }

    return;
  }

  for (const field of DRAFT_PUBLISHED_PROVENANCE_FIELDS) {
    const draftValue = draft.provenance[field];
    const artifactValue = artifact.provenance[field];

    if (draftValue === undefined && artifactValue !== undefined) {
      throw new InteractionRegistryError(
        "interaction_draft_source_conflict",
        `Interaction draft "${draft.draftId}" artifact provenance ${field} was not recorded on the draft.`,
      );
    }

    if (
      draftValue !== undefined &&
      artifactValue !== undefined &&
      draftValue !== artifactValue
    ) {
      throw new InteractionRegistryError(
        "interaction_draft_source_conflict",
        `Interaction draft "${draft.draftId}" provenance ${field} does not match the artifact provenance.`,
      );
    }
  }
}

const DRAFT_PUBLISHED_PROVENANCE_FIELDS = [
  "testHash",
  "publishRequestHash",
  "validationResultAt",
  "vitestResultAt",
  "previewResultAt",
] as const;

function hasPublishedDraftProvenanceEvidence(
  provenance: InteractionDraftProvenance,
) {
  return DRAFT_PUBLISHED_PROVENANCE_FIELDS.some(
    (field) => provenance[field] !== undefined,
  );
}

function hasPublishedArtifactProvenanceEvidence(
  provenance: PublishedInteractionProvenance,
) {
  return DRAFT_PUBLISHED_PROVENANCE_FIELDS.some(
    (field) => provenance[field] !== undefined,
  );
}

function compactProvenance(
  provenance: PublishedInteractionProvenance,
): PublishedInteractionProvenance {
  return omitUndefinedProperties(provenance) as PublishedInteractionProvenance;
}

function gateDiagnostic(
  diagnostic: Omit<PublishGateDiagnostic, "severity">,
): PublishGateDiagnostic {
  return {
    severity: "error",
    ...diagnostic,
  };
}

function omitUndefinedProperties<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
