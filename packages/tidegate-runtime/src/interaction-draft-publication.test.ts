import { describe, expect, test } from "bun:test";
import type { PublishedInteractionArtifact } from "@tidegate/contracts";
import {
  cancelAppointmentGeneratedSource,
  cancelAppointmentPublishRequest,
  cancelAppointmentPublishedArtifact,
} from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog";
import {
  createInteractionDraftPublicationPlan,
  publishValidatedInteractionDraft,
} from "./interaction-draft-publication";
import {
  createScopedInteractionRegistry,
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

describe("interaction draft publication", () => {
  test("rejects branch-only publish options for ordinary drafts", () => {
    const registry = createScopedInteractionRegistry();
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest({
        requestedInteractionId: "ix.booking.ordinaryDraft",
      }),
      source: `${cancelAppointmentGeneratedSource}\n// ordinary draft`,
    });

    const plan = createInteractionDraftPublicationPlan({
      branch: undefined,
      draft,
      options: {
        title: "Branch-only title",
      },
    });

    expect(plan).toEqual({
      ok: false,
      message:
        "Draft publish target overrides are only available for branch-backed drafts.",
      reason: "branch_publish_options_without_branch",
    });
  });

  test("prepares branch publish requests behind one plan interface", () => {
    const registry = createScopedInteractionRegistry();
    publishActiveArtifact(registry, {
      auth: baseAuth,
      interactionId,
      source: `${cancelAppointmentGeneratedSource}\n// branch plan base`,
      sourceHash: sourceHash("a"),
      visibility: "user",
    });
    const branch = registry.createBranch({
      auth: baseAuth,
      interactionId,
      publishTarget: "new-interaction",
    });

    const plan = createInteractionDraftPublicationPlan({
      branch,
      draft: branch,
      options: {
        description: "A planned branch variant.",
        requestedInteractionId: "ix.booking.cancelAppointmentVariant",
        title: "Cancel appointment variant",
      },
    });

    expect(plan).toMatchObject({
      ok: true,
      publishTarget: "new-interaction",
      validationDraft: {
        publishRequest: {
          description: "A planned branch variant.",
          requestedInteractionId: "ix.booking.cancelAppointmentVariant",
          title: "Cancel appointment variant",
        },
      },
    });

    const invalidPlan = createInteractionDraftPublicationPlan({
      branch,
      draft: branch,
      options: {
        publishTarget: "same-interaction",
        requestedInteractionId: "ix.booking.notTheBranchSource",
      },
    });

    expect(invalidPlan).toEqual({
      ok: false,
      message:
        "A same-interaction branch publish cannot override requestedInteractionId.",
      reason: "same_interaction_requested_id_override",
    });
  });

  test("publishes validated ordinary drafts and marks the draft publishable", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// validated publication`;
    const sourceHashValue = sourceHash("b");
    const draft = registry.createDraft({
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      auth: baseAuth,
      publishRequest: draftPublishRequest({
        requestedInteractionId: "ix.booking.validatedDraftPublication",
      }),
      source,
      provenance: {
        sourceHash: sourceHashValue,
      },
    });
    const plan = createInteractionDraftPublicationPlan({
      branch: undefined,
      draft,
      options: {},
    });

    if (!plan.ok) {
      throw new Error(plan.message);
    }

    const published = publishValidatedInteractionDraft({
      auth: baseAuth,
      draftId: draft.draft.draftId,
      now: "2026-06-30T00:00:00.000Z",
      plan,
      publication: {
        artifact: artifactInput({
          actionCatalogVersion: "2026-06-25",
          id: "ix.booking.validatedDraftPublication",
          source,
          sourceHash: sourceHashValue,
        }),
        publishRequest: draft.publishRequest,
      },
      registry,
    });

    expect(published.artifact).toMatchObject({
      id: "ix.booking.validatedDraftPublication",
      sourceHash: sourceHashValue,
      version: "1",
    });
    expect(
      registry.resolveDraft({
        auth: baseAuth,
        draftId: draft.draft.draftId,
      })?.draft.status,
    ).toBe("publishable");
  });

  test("publishes validated branch drafts and merges the branch", () => {
    const registry = createScopedInteractionRegistry();
    const source = `${cancelAppointmentGeneratedSource}\n// branch publication`;
    const sourceHashValue = sourceHash("c");
    publishActiveArtifact(registry, {
      auth: baseAuth,
      interactionId,
      source: `${cancelAppointmentGeneratedSource}\n// branch publication base`,
      sourceHash: sourceHash("d"),
      visibility: "user",
    });
    const branch = registry.createBranch({
      auth: baseAuth,
      interactionId,
      publishTarget: "same-interaction",
    });
    registry.updateDraftSource({
      auth: baseAuth,
      draftId: branch.draft.draftId,
      provenance: {
        sourceHash: sourceHashValue,
      },
      source,
    });
    const resolvedBranch = registry.resolveBranchForDraft({
      auth: baseAuth,
      draftId: branch.draft.draftId,
    });

    if (resolvedBranch === undefined) {
      throw new Error("Expected branch-backed draft to resolve.");
    }

    const plan = createInteractionDraftPublicationPlan({
      branch: resolvedBranch,
      draft: resolvedBranch,
      options: {
        title: "Merged branch title",
      },
    });

    if (!plan.ok) {
      throw new Error(plan.message);
    }

    const published = publishValidatedInteractionDraft({
      auth: baseAuth,
      draftId: branch.draft.draftId,
      now: "2026-06-30T00:01:00.000Z",
      plan,
      publication: {
        artifact: artifactInput({
          actionCatalogVersion: "2026-06-25",
          id: interactionId,
          source,
          sourceHash: sourceHashValue,
          version: "2",
        }),
        publishRequest: plan.validationDraft.publishRequest,
      },
      registry,
    });

    expect(published.artifact).toMatchObject({
      id: interactionId,
      sourceHash: sourceHashValue,
      version: "2",
    });
    expect("branch" in published ? published.branch.status : undefined).toBe(
      "merged",
    );
    expect(
      registry.resolveDraft({
        auth: baseAuth,
        draftId: branch.draft.draftId,
      })?.draft.status,
    ).toBe("publishable");
    expect(
      registry.resolveActiveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
      })?.artifact.version,
    ).toBe("2");
  });
});

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

  void source;

  return {
    ...snapshot,
    ...overrides,
  };
}

function publishActiveArtifact(
  registry: ReturnType<typeof createScopedInteractionRegistry>,
  input: {
    auth: RuntimeAuthContext;
    interactionId: string;
    visibility: PublishedInteractionArtifact["visibility"];
    source: string;
    sourceHash: string;
  },
) {
  registry.createInteractionRecord({
    auth: input.auth,
    interactionId: input.interactionId,
    visibility: input.visibility,
  });
  registry.createArtifactVersion({
    auth: input.auth,
    artifact: artifactInput({
      actionCatalogVersion: "2026-06-25",
      id: input.interactionId,
      source: input.source,
      sourceHash: input.sourceHash,
      visibility: input.visibility,
    }),
  });
  registry.moveActiveVersion({
    auth: input.auth,
    interactionId: input.interactionId,
    nextVersion: "1",
    visibility: input.visibility,
  });
}

function sourceHash(hexChar: string) {
  return `sha256:${hexChar.repeat(64)}`;
}
