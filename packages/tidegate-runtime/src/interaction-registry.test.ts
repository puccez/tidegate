import { describe, expect, test } from "bun:test";
import type { PublishedInteractionArtifact } from "@tidegate/contracts";
import {
  cancelAppointmentContract,
  cancelAppointmentGeneratedSource,
  cancelAppointmentPublishRequest,
  cancelAppointmentPublishedArtifact,
} from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog";
import {
  createScopedInteractionRegistry,
  createInteractionRegistry,
  defineInteraction,
  InteractionRegistryError,
  type InteractionDraftPublishRequestSnapshot,
} from "./interaction-registry";

type ArtifactInput = Parameters<
  ReturnType<typeof createScopedInteractionRegistry>["createArtifactVersion"]
>[0]["artifact"];

const interactionId = "ix.booking.cancelAppointment";
const baseAuth: RuntimeAuthContext = {
  organizationId: "org_123",
  subjectId: "user_123",
  subjectType: "user",
  credentialId: "cred_123",
  credentialType: "session",
  scopes: ["tidegate:interaction:publish"],
  userId: "user_123",
  workosUserId: "user_123",
  tenantId: "tenant_123",
  clientId: "app_123",
  authorization: {
    permissions: ["interactions:publish"],
    resourceGrants: [],
  },
  permissions: ["interactions:publish"],
  authMode: "user",
};

describe("interaction registry helpers", () => {
  test("maps static interactions by public interaction id", () => {
    const interaction = defineInteraction({
      contract: cancelAppointmentContract,
      async run(input) {
        return input;
      },
    });

    const registry = createInteractionRegistry([interaction]);

    expect(registry.get("ix.booking.cancelAppointment")).toBe(interaction);
  });

  test("stores published artifact versions immutably", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// immutable v1`;

    registry.createInteractionRecord({
      auth: baseAuth,
      interactionId,
      visibility: "user",
    });

    const artifact = artifactInput({
      source,
      sourceHash: sourceHash("a"),
    });

    registry.createArtifactVersion({
      auth: baseAuth,
      artifact,
    });

    artifact.source = "tampered after create";

    const resolved = registry.resolveVersion({
      auth: baseAuth,
      interactionId,
      visibility: "user",
      version: "1",
    });

    expect(resolved?.artifact.source).toBe(source);
    expect(resolved?.artifact.provenance).toBeUndefined();
    expect(Object.isFrozen(resolved?.artifact)).toBe(true);
    expect(Object.isFrozen(resolved?.artifact.allowedActions[0])).toBe(true);

    try {
      (resolved?.artifact as unknown as { source: string }).source =
        "tampered resolved artifact";
    } catch {
      // Frozen ESM objects throw; the important assertion is that storage is unchanged.
    }

    expect(
      registry.resolveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        version: "1",
      })?.artifact.source,
    ).toBe(source);
  });

  test("moves activeVersion from version 1 to version 2 without changing version 1", () => {
    const registry = createScopedInteractionRegistry();

    registry.createInteractionRecord({
      auth: baseAuth,
      interactionId,
      visibility: "user",
      now: "2026-06-21T00:00:00.000Z",
    });
    registry.createArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        version: "1",
        source: "export default async function run() { return { version: 1 }; }",
        sourceHash: sourceHash("1"),
      }),
    });
    registry.createArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        version: "2",
        parentVersion: "1",
        source: "export default async function run() { return { version: 2 }; }",
        sourceHash: sourceHash("2"),
      }),
    });

    registry.moveActiveVersion({
      auth: baseAuth,
      interactionId,
      visibility: "user",
      nextVersion: "1",
      expectedActiveVersion: null,
      now: "2026-06-21T00:01:00.000Z",
    });

    const versionOneBeforeMove = registry.resolveVersion({
      auth: baseAuth,
      interactionId,
      visibility: "user",
      version: "1",
    });

    registry.moveActiveVersion({
      auth: baseAuth,
      interactionId,
      visibility: "user",
      nextVersion: "2",
      expectedActiveVersion: "1",
      now: "2026-06-21T00:02:00.000Z",
    });

    expect(
      registry.resolveActiveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
      })?.artifact.version,
    ).toBe("2");
    expect(versionOneBeforeMove?.artifact.version).toBe("1");
    expect(
      registry.resolveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        version: "1",
      })?.artifact.source,
    ).toContain("version: 1");
  });

  test("does not implicitly reactivate archived or revoked interactions during publish", () => {
    const registry = createScopedInteractionRegistry();
    const archivedId = "ix.booking.archivedPublish";
    const revokedId = "ix.booking.revokedPublish";

    registry.publishArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        id: archivedId,
        version: "1",
        source: "export default async function run() { return { version: 1 }; }",
        sourceHash: sourceHash("a"),
      }),
    });
    registry.setInteractionAvailabilityStatus({
      auth: baseAuth,
      interactionId: archivedId,
      visibility: "user",
      status: "archived",
    });
    registry.publishArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        id: archivedId,
        version: "2",
        parentVersion: "1",
        source: "export default async function run() { return { version: 2 }; }",
        sourceHash: sourceHash("b"),
      }),
    });

    const archived = registry.resolveActiveVersion({
      auth: baseAuth,
      interactionId: archivedId,
      visibility: "user",
    });
    expect(archived?.record.status).toBe("archived");
    expect(archived?.artifact.version).toBe("2");

    registry.publishArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        id: revokedId,
        version: "1",
        source: "export default async function run() { return { version: 1 }; }",
        sourceHash: sourceHash("c"),
      }),
    });
    registry.setInteractionAvailabilityStatus({
      auth: baseAuth,
      interactionId: revokedId,
      visibility: "user",
      status: "revoked",
    });

    expect(() =>
      registry.publishArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          id: revokedId,
          version: "2",
          parentVersion: "1",
          source:
            "export default async function run() { return { version: 2 }; }",
          sourceHash: sourceHash("d"),
        }),
      }),
    ).toThrow(
      new InteractionRegistryError(
        "interaction_unavailable",
        `Interaction "${revokedId}" is revoked and cannot receive new published versions.`,
      ),
    );

    expect(
      registry.resolveActiveVersion({
        auth: baseAuth,
        interactionId: revokedId,
        visibility: "user",
      })?.record.status,
    ).toBe("revoked");
  });

  test("keeps the same interaction id isolated across user, tenant, organization, and app scopes", () => {
    const registry = createScopedInteractionRegistry();
    const scopedArtifacts = [
      {
        visibility: "user" as const,
        auth: auth({ userId: "user_scope", subjectId: "user_scope" }),
        source: "user scoped source",
        hash: sourceHash("3"),
      },
      {
        visibility: "tenant" as const,
        auth: auth({ tenantId: "tenant_scope" }),
        source: "tenant scoped source",
        hash: sourceHash("4"),
      },
      {
        visibility: "organization" as const,
        auth: auth({ organizationId: "org_scope" }),
        source: "organization scoped source",
        hash: sourceHash("5"),
      },
      {
        visibility: "app" as const,
        auth: auth({ clientId: "app_scope" }),
        source: "app scoped source",
        hash: sourceHash("6"),
      },
      {
        visibility: "app" as const,
        auth: auth({ clientId: "app_scope_other" }),
        source: "other app scoped source",
        hash: sourceHash("f"),
      },
    ];

    for (const scopedArtifact of scopedArtifacts) {
      registry.createInteractionRecord({
        auth: scopedArtifact.auth,
        interactionId,
        visibility: scopedArtifact.visibility,
      });
      registry.createArtifactVersion({
        auth: scopedArtifact.auth,
        artifact: artifactInput({
          visibility: scopedArtifact.visibility,
          source: scopedArtifact.source,
          sourceHash: scopedArtifact.hash,
        }),
      });
      registry.moveActiveVersion({
        auth: scopedArtifact.auth,
        interactionId,
        visibility: scopedArtifact.visibility,
        nextVersion: "1",
      });
    }

    for (const scopedArtifact of scopedArtifacts) {
      expect(
        registry.resolveActiveVersion({
          auth: scopedArtifact.auth,
          interactionId,
          visibility: scopedArtifact.visibility,
        })?.artifact.source,
      ).toBe(scopedArtifact.source);
    }
  });

  test("returns scoped misses for callers from another user, tenant, or organization", () => {
    const registry = createScopedInteractionRegistry();

    publishActiveArtifact(registry, {
      auth: baseAuth,
      visibility: "user",
      source: "private user source",
      sourceHash: sourceHash("7"),
    });

    expect(
      registry.resolveActiveVersion({
        auth: auth({ userId: "user_other", subjectId: "user_other" }),
        interactionId,
        visibility: "user",
      }),
    ).toBeUndefined();
    expect(
      registry.resolveActiveVersion({
        auth: auth({ tenantId: "tenant_other" }),
        interactionId,
        visibility: "user",
      }),
    ).toBeUndefined();
    expect(
      registry.resolveActiveVersion({
        auth: auth({ organizationId: "org_other" }),
        interactionId,
        visibility: "user",
      }),
    ).toBeUndefined();

    publishActiveArtifact(registry, {
      auth: auth({ tenantId: "tenant_owner" }),
      visibility: "tenant",
      source: "private tenant source",
      sourceHash: sourceHash("8"),
    });
    publishActiveArtifact(registry, {
      auth: auth({ organizationId: "org_owner" }),
      visibility: "organization",
      source: "private organization source",
      sourceHash: sourceHash("9"),
    });

    expect(
      registry.resolveActiveVersion({
        auth: auth({ tenantId: "tenant_other" }),
        interactionId,
        visibility: "tenant",
      }),
    ).toBeUndefined();
    expect(
      registry.resolveActiveVersion({
        auth: auth({ organizationId: "org_other" }),
        interactionId,
        visibility: "organization",
      }),
    ).toBeUndefined();
  });

  test("distinguishes missing, active, and explicit version mismatch cases", () => {
    const registry = createScopedInteractionRegistry();

    expect(
      registry.resolveActiveVersion({
        auth: baseAuth,
        interactionId: "ix.booking.missing",
        visibility: "user",
      }),
    ).toBeUndefined();

    registry.createInteractionRecord({
      auth: baseAuth,
      interactionId,
      visibility: "user",
    });
    expect(
      registry.resolveActiveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
      }),
    ).toBeUndefined();

    registry.createArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        sourceHash: sourceHash("b"),
      }),
    });
    registry.moveActiveVersion({
      auth: baseAuth,
      interactionId,
      visibility: "user",
      nextVersion: "1",
    });

    expect(
      registry.resolveActiveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
      })?.artifact.version,
    ).toBe("1");
    expect(
      registry.resolveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        version: "2",
      }),
    ).toBeUndefined();
    expectRegistryError(
      () =>
        registry.moveActiveVersion({
          auth: baseAuth,
          interactionId,
          visibility: "user",
          nextVersion: "2",
        }),
      "interaction_version_missing",
    );
  });

  test("stores archived and revoked availability state", () => {
    const registry = createScopedInteractionRegistry();

    publishActiveArtifact(registry, {
      auth: baseAuth,
      visibility: "user",
      source: "status source",
      sourceHash: sourceHash("c"),
    });

    const artifactBeforeArchive = registry.resolveVersion({
      auth: baseAuth,
      interactionId,
      visibility: "user",
      version: "1",
    })?.artifact;

    expect(
      registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        status: "archived",
      }).status,
    ).toBe("archived");
    expect(
      registry.resolveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        version: "1",
      })?.artifact,
    ).toEqual(artifactBeforeArchive);
    expect(
      registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        status: "revoked",
      }).status,
    ).toBe("revoked");
    expect(
      registry.resolveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        version: "1",
      })?.artifact,
    ).toEqual(artifactBeforeArchive);

    const revokedInteractionId = "ix.booking.revokedCancelAppointment";
    registry.createInteractionRecord({
      auth: baseAuth,
      interactionId: revokedInteractionId,
      visibility: "user",
    });
    registry.createArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        id: revokedInteractionId,
        status: "revoked",
        source: "revoked source",
        sourceHash: sourceHash("d"),
      }),
    });
    registry.setInteractionAvailabilityStatus({
      auth: baseAuth,
      interactionId: revokedInteractionId,
      visibility: "user",
      status: "revoked",
    });

    expect(
      registry.resolveVersion({
        auth: baseAuth,
        interactionId: revokedInteractionId,
        visibility: "user",
        version: "1",
      })?.artifact.status,
    ).toBe("revoked");
  });

  test("lists active visible interactions without archived, revoked, or foreign scoped records", () => {
    const registry = createScopedInteractionRegistry();
    const visibleUserId = "ix.booking.visibleUser";
    const visibleTenantId = "ix.booking.visibleTenant";
    const archivedId = "ix.booking.archived";
    const revokedId = "ix.booking.revoked";

    publishActiveArtifact(registry, {
      auth: baseAuth,
      interactionId: visibleUserId,
      visibility: "user",
      source: "visible user source",
      sourceHash: sourceHash("0"),
    });
    publishActiveArtifact(registry, {
      auth: baseAuth,
      interactionId: visibleTenantId,
      visibility: "tenant",
      source: "visible tenant source",
      sourceHash: sourceHash("1"),
    });
    publishActiveArtifact(registry, {
      auth: auth({ userId: "user_other", subjectId: "user_other" }),
      interactionId: "ix.booking.hiddenUser",
      visibility: "user",
      source: "hidden user source",
      sourceHash: sourceHash("2"),
    });
    publishActiveArtifact(registry, {
      auth: auth({ tenantId: "tenant_other" }),
      interactionId: "ix.booking.hiddenTenant",
      visibility: "tenant",
      source: "hidden tenant source",
      sourceHash: sourceHash("3"),
    });
    publishActiveArtifact(registry, {
      auth: baseAuth,
      interactionId: archivedId,
      visibility: "user",
      source: "archived source",
      sourceHash: sourceHash("4"),
    });
    publishActiveArtifact(registry, {
      auth: baseAuth,
      interactionId: revokedId,
      visibility: "user",
      source: "revoked source",
      sourceHash: sourceHash("5"),
    });

    registry.setInteractionAvailabilityStatus({
      auth: baseAuth,
      interactionId: archivedId,
      visibility: "user",
      status: "archived",
    });
    registry.setInteractionAvailabilityStatus({
      auth: baseAuth,
      interactionId: revokedId,
      visibility: "user",
      status: "revoked",
    });

    const visible = registry.listVisibleActiveVersions({ auth: baseAuth });

    expect(
      visible.map((resolution) => ({
        interactionId: resolution.record.id,
        visibility: resolution.record.visibility,
      })),
    ).toEqual([
      { interactionId: visibleUserId, visibility: "user" },
      { interactionId: visibleTenantId, visibility: "tenant" },
    ]);
    expect(
      registry.resolveVisibleInteraction({
        auth: baseAuth,
        interactionId: archivedId,
      })?.record.status,
    ).toBe("archived");
    expect(
      registry.resolveVisibleInteraction({
        auth: baseAuth,
        interactionId: "ix.booking.hiddenTenant",
      }),
    ).toBeUndefined();
  });

  test("rejects unsafe id reuse and source hash collisions within a scope", () => {
    const registry = createScopedInteractionRegistry();

    registry.createInteractionRecord({
      auth: baseAuth,
      interactionId,
      visibility: "user",
    });
    expectRegistryError(
      () =>
        registry.createInteractionRecord({
          auth: baseAuth,
          interactionId,
          visibility: "user",
        }),
      "unsafe_interaction_id_reuse",
    );

    registry.createArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        source: "collision source one",
        sourceHash: sourceHash("e"),
      }),
    });

    const collisionInteractionId = "ix.booking.collision";
    registry.createInteractionRecord({
      auth: baseAuth,
      interactionId: collisionInteractionId,
      visibility: "user",
    });
    expectRegistryError(
      () =>
        registry.createArtifactVersion({
          auth: baseAuth,
          artifact: artifactInput({
            id: collisionInteractionId,
            source: "collision source two",
            sourceHash: sourceHash("e"),
          }),
        }),
      "source_hash_collision",
    );

    registry.createInteractionRecord({
      auth: auth({ userId: "user_other", subjectId: "user_other" }),
      interactionId,
      visibility: "user",
    });
  });

  test("materializes artifact-backed branches from immutable published source", () => {
    const registry = createScopedInteractionRegistry();
    const publishedSource = `${cancelAppointmentGeneratedSource}\n// published source`;
    const artifactProvenance = {
      sourceHash: sourceHash("a"),
      testHash: sourceHash("b"),
      publishRequestHash: sourceHash("c"),
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      validationResultAt: "2026-06-25T00:01:00.000Z",
      vitestResultAt: "2026-06-25T00:02:00.000Z",
      previewResultAt: "2026-06-25T00:03:00.000Z",
    };

    publishActiveArtifact(registry, {
      auth: baseAuth,
      visibility: "user",
      source: publishedSource,
      sourceHash: sourceHash("a"),
      artifact: {
        actionCatalogVersion: "2026-06-25",
        provenance: artifactProvenance,
      },
    });

    const firstBranch = registry.createBranch({
      auth: baseAuth,
      interactionId,
    });
    registry.updateDraftSource({
      auth: baseAuth,
      draftId: firstBranch.draft.draftId,
      source: `${cancelAppointmentGeneratedSource}\n// mutable branch draft`,
      provenance: {
        sourceHash: sourceHash("d"),
      },
    });

    const secondBranch = registry.createBranch({
      auth: baseAuth,
      branchId: "branch_from_artifact_snapshot",
      draftId: "draft_from_artifact_snapshot",
      interactionId,
    });

    expect(secondBranch.source.source).toBe(publishedSource);
    expect(secondBranch.draft.source).toBe(publishedSource);
    expect(secondBranch.source.provenance).toEqual(artifactProvenance);
    expect(secondBranch.draft.provenance).toMatchObject({
      sourceHash: sourceHash("a"),
      testHash: sourceHash("b"),
      publishRequestHash: sourceHash("c"),
      validationResultAt: "2026-06-25T00:01:00.000Z",
      vitestResultAt: "2026-06-25T00:02:00.000Z",
      previewResultAt: "2026-06-25T00:03:00.000Z",
    });
  });

  test("stores draft source by owner scope and allows explicit reviewer lookup", () => {
    const registry = createScopedInteractionRegistry();
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source: `${cancelAppointmentGeneratedSource}\n// draft owner source`,
    });

    expect(draft.draft.ownerUserId).toBe("user_123");
    expect(Object.isFrozen(draft.draft)).toBe(true);
    expect(
      registry.resolveDraft({
        auth: auth({ userId: "user_other", subjectId: "user_other" }),
        draftId: draft.draft.draftId,
      }),
    ).toBeUndefined();

    expectRegistryError(
      () =>
        registry.updateDraftSource({
          auth: auth({ userId: "user_other", subjectId: "user_other" }),
          draftId: draft.draft.draftId,
          source: "export default async function run() { return {}; }",
        }),
      "interaction_draft_missing",
    );

    const reviewerDraft = registry.resolveDraft({
      allowReviewerAccess: true,
      auth: auth({
        subjectId: "reviewer_123",
        userId: "reviewer_123",
      }),
      draftId: draft.draft.draftId,
    });

    expect(reviewerDraft?.draft.draftId).toBe(draft.draft.draftId);
  });

  test("records draft provenance and clears stale source-coupled metadata", () => {
    const registry = createScopedInteractionRegistry();
    const emptyDraft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      draftId: "draft_empty_provenance",
      publishRequest: draftPublishRequest({
        requestedInteractionId: "ix.booking.emptyProvenance",
      }),
      source: `${cancelAppointmentGeneratedSource}\n// empty provenance`,
    });
    const emptyProvenance = registry.recordDraftProvenance({
      auth: baseAuth,
      draftId: emptyDraft.draft.draftId,
      provenance: {},
    });

    expect(emptyProvenance.draft.provenance).toBeUndefined();

    const source = `${cancelAppointmentGeneratedSource}\n// draft provenance`;
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source,
      provenance: {
        sourceHash: sourceHash("1"),
        testHash: sourceHash("2"),
        testSource: "import { describe, test } from 'vitest';",
        testMetadata: {
          file: "interaction.test.ts",
          runner: "vitest",
        },
        publishRequestHash: sourceHash("3"),
        validationResultAt: "2026-06-25T00:01:00.000Z",
        vitestResultAt: "2026-06-25T00:02:00.000Z",
      },
    });

    const previewed = registry.recordDraftProvenance({
      auth: baseAuth,
      draftId: draft.draft.draftId,
      provenance: {
        previewResultAt: "2026-06-25T00:03:00.000Z",
      },
    });

    expect(previewed.draft.provenance).toMatchObject({
      sourceHash: sourceHash("1"),
      testHash: sourceHash("2"),
      publishRequestHash: sourceHash("3"),
      validationResultAt: "2026-06-25T00:01:00.000Z",
      vitestResultAt: "2026-06-25T00:02:00.000Z",
      previewResultAt: "2026-06-25T00:03:00.000Z",
    });

    const publishable = registry.setDraftStatus({
      auth: baseAuth,
      draftId: draft.draft.draftId,
      status: "publishable",
      provenance: {
        validationResultAt: "2026-06-25T00:04:00.000Z",
      },
    });

    expect(publishable.draft).toMatchObject({
      status: "publishable",
      provenance: {
        sourceHash: sourceHash("1"),
        testHash: sourceHash("2"),
        validationResultAt: "2026-06-25T00:04:00.000Z",
        previewResultAt: "2026-06-25T00:03:00.000Z",
      },
    });

    const staleCleared = registry.updateDraftSource({
      auth: baseAuth,
      draftId: draft.draft.draftId,
      source: `${source}\n// source changed without synced hash`,
    });

    expect(staleCleared.draft.provenance).toBeUndefined();

    const synced = registry.updateDraftSource({
      auth: baseAuth,
      draftId: draft.draft.draftId,
      source: `${source}\n// synced source`,
      provenance: {
        sourceHash: sourceHash("4"),
        testHash: sourceHash("5"),
      },
    });

    expect(synced.draft.provenance).toMatchObject({
      sourceHash: sourceHash("4"),
      testHash: sourceHash("5"),
    });
  });

  test("publishes reviewer-approved drafts into the draft owner scope", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// reviewer approved`;
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source,
    });
    const reviewerAuth = auth({
      subjectId: "reviewer_123",
      userId: "reviewer_123",
    });

    const published = registry.publishDraftArtifactVersion({
      allowReviewerAccess: true,
      artifact: artifactInput({
        actionCatalogVersion: "2026-06-25",
        source,
        sourceHash: sourceHash("f"),
      }),
      auth: reviewerAuth,
      draftId: draft.draft.draftId,
      expectedActiveVersion: null,
      title: "Reviewer approved cancel appointment",
    });

    expect(published.artifact.createdBySubjectId).toBe("reviewer_123");
    expect(
      registry.resolveActiveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
      })?.artifact.source,
    ).toBe(source);
    expect(
      registry.resolveActiveVersion({
        auth: reviewerAuth,
        interactionId,
        visibility: "user",
      }),
    ).toBeUndefined();
  });

  test("copies draft validation provenance into published artifacts", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// provenance publish`;
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source,
      provenance: {
        sourceHash: sourceHash("a"),
        testHash: sourceHash("b"),
        publishRequestHash: sourceHash("c"),
        validationResultAt: "2026-06-25T00:01:00.000Z",
        vitestResultAt: "2026-06-25T00:02:00.000Z",
        previewResultAt: "2026-06-25T00:03:00.000Z",
      },
    });

    const published = registry.publishDraftArtifactVersion({
      artifact: artifactInput({
        actionCatalogVersion: "2026-06-25",
        source,
        sourceHash: sourceHash("a"),
      }),
      auth: baseAuth,
      draftId: draft.draft.draftId,
      expectedActiveVersion: null,
    });

    expect(published.artifact.provenance).toEqual({
      sourceHash: sourceHash("a"),
      testHash: sourceHash("b"),
      publishRequestHash: sourceHash("c"),
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      validationResultAt: "2026-06-25T00:01:00.000Z",
      vitestResultAt: "2026-06-25T00:02:00.000Z",
      previewResultAt: "2026-06-25T00:03:00.000Z",
    });

    const artifactBeforeArchive = published.artifact;
    registry.setInteractionAvailabilityStatus({
      auth: baseAuth,
      interactionId,
      visibility: "user",
      status: "archived",
    });
    expect(
      registry.resolveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        version: "1",
      })?.artifact.provenance,
    ).toEqual(artifactBeforeArchive.provenance);

    registry.setInteractionAvailabilityStatus({
      auth: baseAuth,
      interactionId,
      visibility: "user",
      status: "revoked",
    });
    expect(
      registry.resolveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        version: "1",
      })?.artifact.provenance,
    ).toEqual(artifactBeforeArchive.provenance);
  });

  test("rejects publishing draft artifacts with stale source provenance", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// stale provenance`;
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source,
      provenance: {
        sourceHash: sourceHash("a"),
      },
    });

    expectRegistryError(
      () =>
        registry.publishDraftArtifactVersion({
          artifact: artifactInput({
            actionCatalogVersion: "2026-06-25",
            source,
            sourceHash: sourceHash("b"),
          }),
          auth: baseAuth,
          draftId: draft.draft.draftId,
          expectedActiveVersion: null,
        }),
      "interaction_draft_source_conflict",
    );
  });

  test("rejects publishing draft result metadata without source provenance", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// missing source hash`;
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source,
      provenance: {
        validationResultAt: "2026-06-25T00:01:00.000Z",
      },
    });

    expectRegistryError(
      () =>
        registry.publishDraftArtifactVersion({
          artifact: artifactInput({
            actionCatalogVersion: "2026-06-25",
            source,
            sourceHash: sourceHash("a"),
          }),
          auth: baseAuth,
          draftId: draft.draft.draftId,
          expectedActiveVersion: null,
        }),
      "interaction_draft_source_conflict",
    );
  });

  test("rejects explicit artifact provenance that contradicts draft evidence", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// explicit mismatch`;
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source,
      provenance: {
        sourceHash: sourceHash("a"),
        testHash: sourceHash("b"),
      },
    });

    expectRegistryError(
      () =>
        registry.publishDraftArtifactVersion({
          artifact: artifactInput({
            actionCatalogVersion: "2026-06-25",
            source,
            sourceHash: sourceHash("a"),
            provenance: {
              sourceHash: sourceHash("a"),
              testHash: sourceHash("c"),
              actionCatalogId: "booking-actions",
              actionCatalogVersion: "2026-06-25",
            },
          }),
          auth: baseAuth,
          draftId: draft.draft.draftId,
          expectedActiveVersion: null,
        }),
      "interaction_draft_source_conflict",
    );
  });

  test("rejects explicit artifact provenance that invents draft evidence", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// explicit invented evidence`;
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source,
      provenance: {
        sourceHash: sourceHash("a"),
      },
    });

    expectRegistryError(
      () =>
        registry.publishDraftArtifactVersion({
          artifact: artifactInput({
            actionCatalogVersion: "2026-06-25",
            source,
            sourceHash: sourceHash("a"),
            provenance: {
              sourceHash: sourceHash("a"),
              testHash: sourceHash("b"),
              actionCatalogId: "booking-actions",
              actionCatalogVersion: "2026-06-25",
            },
          }),
          auth: baseAuth,
          draftId: draft.draft.draftId,
          expectedActiveVersion: null,
        }),
      "interaction_draft_source_conflict",
    );
  });

  test("rejects explicit artifact provenance that mismatches the artifact snapshot", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// explicit snapshot mismatch`;
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source,
    });

    expectRegistryError(
      () =>
        registry.publishDraftArtifactVersion({
          artifact: artifactInput({
            actionCatalogVersion: "2026-06-25",
            source,
            sourceHash: sourceHash("a"),
            provenance: {
              sourceHash: sourceHash("b"),
              actionCatalogId: "booking-actions",
              actionCatalogVersion: "2026-06-25",
            },
          }),
          auth: baseAuth,
          draftId: draft.draft.draftId,
          expectedActiveVersion: null,
        }),
      "interaction_draft_source_conflict",
    );
  });

  test("omits undefined optional provenance keys from published artifacts", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// compact provenance`;
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest(),
      source,
      provenance: {
        sourceHash: sourceHash("a"),
      },
    });

    const published = registry.publishDraftArtifactVersion({
      artifact: artifactInput({
        actionCatalogVersion: "2026-06-25",
        source,
        sourceHash: sourceHash("a"),
      }),
      auth: baseAuth,
      draftId: draft.draft.draftId,
      expectedActiveVersion: null,
    });

    expect(published.artifact.provenance).toEqual({
      sourceHash: sourceHash("a"),
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
    });
  });
});

function auth(overrides: Partial<RuntimeAuthContext> = {}): RuntimeAuthContext {
  return {
    ...baseAuth,
    ...overrides,
  };
}

function artifactInput(
  overrides: Partial<PublishedInteractionArtifact> = {},
): ArtifactInput {
  const artifact = {
    ...structuredClone(cancelAppointmentPublishedArtifact),
    ...overrides,
  };
  const {
    ownerTenantId,
    ownerOrganizationId,
    ownerUserId,
    createdAt,
    createdBySubjectId,
    ...input
  } = artifact;

  return input;
}

function draftPublishRequest(
  overrides: Partial<InteractionDraftPublishRequestSnapshot> = {},
): InteractionDraftPublishRequestSnapshot {
  const { source, ...snapshot } = structuredClone(
    cancelAppointmentPublishRequest,
  );

  return {
    ...snapshot,
    ...overrides,
  };
}

function publishActiveArtifact(
  registry: ReturnType<typeof createScopedInteractionRegistry>,
  input: {
    auth: RuntimeAuthContext;
    interactionId?: string;
    visibility: PublishedInteractionArtifact["visibility"];
    source: string;
    sourceHash: string;
    artifact?: Partial<PublishedInteractionArtifact>;
  },
) {
  registry.createInteractionRecord({
    auth: input.auth,
    interactionId: input.interactionId ?? interactionId,
    visibility: input.visibility,
  });
  registry.createArtifactVersion({
    auth: input.auth,
    artifact: artifactInput({
      id: input.interactionId ?? interactionId,
      visibility: input.visibility,
      source: input.source,
      sourceHash: input.sourceHash,
      ...input.artifact,
    }),
  });
  registry.moveActiveVersion({
    auth: input.auth,
    interactionId: input.interactionId ?? interactionId,
    visibility: input.visibility,
    nextVersion: "1",
  });
}

function expectRegistryError(
  action: () => unknown,
  code: InteractionRegistryError["code"],
) {
  let caught: unknown;

  try {
    action();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(InteractionRegistryError);
  expect((caught as InteractionRegistryError).code).toBe(code);
}

function sourceHash(hexChar: string) {
  return `sha256:${hexChar.repeat(64)}`;
}
