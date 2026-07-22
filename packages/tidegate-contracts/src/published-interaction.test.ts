import { describe, expect, test } from "bun:test";
import {
  cancelAppointmentGeneratedSource,
  cancelAppointmentInteractionBranch,
  cancelAppointmentInteractionDraft,
  cancelAppointmentInteractionRecord,
  cancelAppointmentPublicDiscoveryDetailResponse,
  cancelAppointmentPublicDiscoveryItem,
  cancelAppointmentPublicDiscoveryListResponse,
  cancelAppointmentPublishRequest,
  cancelAppointmentPublishResponse,
  cancelAppointmentPublishedArtifact,
  cancelAppointmentSourceHash,
} from "@tidegate/contracts/fixtures";
import {
  InteractionBranchSchema,
  InteractionDraftSchema,
  InteractionRecordSchema,
  PublicInteractionDiscoveryDetailResponseSchema,
  PublicInteractionDiscoveryItemSchema,
  PublicInteractionDiscoveryListResponseSchema,
  PublishInteractionRequestSchema,
  PublishInteractionResponseSchema,
  PublishedInteractionArtifactSchema,
  toPublicInteractionDiscoveryItem,
} from "./published-interaction";

function cloned<T>(value: T): T {
  return structuredClone(value);
}

function clonedRequest(): Record<string, unknown> {
  return cloned(cancelAppointmentPublishRequest) as unknown as Record<
    string,
    unknown
  >;
}

function clonedArtifact(): Record<string, unknown> {
  return cloned(cancelAppointmentPublishedArtifact) as unknown as Record<
    string,
    unknown
  >;
}

function clonedDraft(): Record<string, unknown> {
  return cloned(cancelAppointmentInteractionDraft) as unknown as Record<
    string,
    unknown
  >;
}

function clonedBranch(): Record<string, unknown> {
  return cloned(cancelAppointmentInteractionBranch) as unknown as Record<
    string,
    unknown
  >;
}

function snapshotHash(hexChar: string) {
  return `sha256:${hexChar.repeat(64)}`;
}

function collectObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjectKeys(item, keys);
    }

    return keys;
  }

  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectObjectKeys(child, keys);
    }
  }

  return keys;
}

function collectStringValues(
  value: unknown,
  values = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    values.add(value);
    return values;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, values);
    }

    return values;
  }

  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      collectStringValues(child, values);
    }
  }

  return values;
}

describe("published interaction contracts", () => {
  test("parses generated cancel appointment fixtures", () => {
    expect(
      PublishInteractionRequestSchema.safeParse(cancelAppointmentPublishRequest)
        .success,
    ).toBe(true);
    expect(
      PublishInteractionResponseSchema.safeParse(cancelAppointmentPublishResponse)
        .success,
    ).toBe(true);
    expect(
      PublishedInteractionArtifactSchema.safeParse(
        cancelAppointmentPublishedArtifact,
      ).success,
    ).toBe(true);
    expect(
      InteractionRecordSchema.safeParse(cancelAppointmentInteractionRecord).success,
    ).toBe(true);
    expect(
      InteractionDraftSchema.safeParse(cancelAppointmentInteractionDraft).success,
    ).toBe(true);
    expect(
      InteractionBranchSchema.safeParse(cancelAppointmentInteractionBranch)
        .success,
    ).toBe(true);
    expect(
      PublicInteractionDiscoveryItemSchema.safeParse(
        cancelAppointmentPublicDiscoveryItem,
      ).success,
    ).toBe(true);
    expect(
      PublicInteractionDiscoveryListResponseSchema.safeParse(
        cancelAppointmentPublicDiscoveryListResponse,
      ).success,
    ).toBe(true);
    expect(
      PublicInteractionDiscoveryDetailResponseSchema.safeParse(
        cancelAppointmentPublicDiscoveryDetailResponse,
      ).success,
    ).toBe(true);
  });

  test("rejects body-supplied owner and authorization identifiers", () => {
    const forbiddenFields: Array<Record<string, unknown>> = [
      { owner: { tenantId: "tenant_attacker" } },
      { ownerTenantId: "tenant_attacker" },
      { ownerOrganizationId: "org_attacker" },
      { ownerUserId: "user_attacker" },
      { tenantId: "tenant_attacker" },
      { organizationId: "org_attacker" },
      { orgId: "org_attacker" },
      { userId: "user_attacker" },
      { role: "admin" },
      { roleId: "role_admin" },
      { roles: ["admin"] },
      { permission: "interactions.publish" },
      { permissionId: "perm_publish" },
      { permissions: ["interactions.publish"] },
      { requiredPermissions: ["interactions.publish"] },
    ];

    for (const forbiddenField of forbiddenFields) {
      expect(
        PublishInteractionRequestSchema.safeParse({
          ...clonedRequest(),
          ...forbiddenField,
        }).success,
      ).toBe(false);
    }

    const nestedActionPermission = clonedRequest();
    nestedActionPermission.requestedAllowedActions = [
      {
        id: "booking.cancel",
        maxCalls: 1,
        permissionId: "perm_publish",
      },
    ];

    expect(
      PublishInteractionRequestSchema.safeParse(nestedActionPermission).success,
    ).toBe(false);
  });

  test("accepts opt-in publish gate evidence on publish requests", () => {
    const request = clonedRequest();
    request.requireGreenTests = true;
    request.provenance = {
      sourceHash: cancelAppointmentSourceHash,
      testHash: snapshotHash("b"),
      testSource: "import { test } from 'bun:test';",
      testMetadata: {
        runner: "bun",
        status: "passed",
      },
      publishRequestHash: snapshotHash("c"),
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-21",
      validationResultAt: "2026-06-21T00:01:00.000Z",
      vitestResultAt: "2026-06-21T00:02:00.000Z",
    };

    expect(PublishInteractionRequestSchema.safeParse(request).success).toBe(true);
  });

  test("rejects invalid artifact shapes", () => {
    const invalidSourceHash = clonedArtifact();
    invalidSourceHash.sourceHash = "not-a-sha256-digest";
    expect(
      PublishedInteractionArtifactSchema.safeParse(invalidSourceHash).success,
    ).toBe(false);

    const missingSource = clonedArtifact();
    delete missingSource.source;
    expect(PublishedInteractionArtifactSchema.safeParse(missingSource).success).toBe(
      false,
    );

    const missingOwnerScope = clonedArtifact();
    delete missingOwnerScope.ownerUserId;
    expect(
      PublishedInteractionArtifactSchema.safeParse(missingOwnerScope).success,
    ).toBe(false);

    const missingActionCatalogId = clonedArtifact();
    delete missingActionCatalogId.actionCatalogId;
    expect(
      PublishedInteractionArtifactSchema.safeParse(missingActionCatalogId)
        .success,
    ).toBe(false);

    const emptyAllowedActions = clonedArtifact();
    emptyAllowedActions.allowedActions = [];
    expect(
      PublishedInteractionArtifactSchema.safeParse(emptyAllowedActions).success,
    ).toBe(false);

    const zeroTimeout = clonedArtifact();
    zeroTimeout.timeout = {
      ...(zeroTimeout.timeout as Record<string, unknown>),
      executionMs: 0,
    };
    expect(PublishedInteractionArtifactSchema.safeParse(zeroTimeout).success).toBe(
      false,
    );

    const invalidCreatedAt = clonedArtifact();
    invalidCreatedAt.createdAt = "not-a-timestamp";
    expect(
      PublishedInteractionArtifactSchema.safeParse(invalidCreatedAt).success,
    ).toBe(false);

    const withProvenance = clonedArtifact();
    withProvenance.provenance = {
      sourceHash: cancelAppointmentSourceHash,
      testHash: snapshotHash("b"),
      publishRequestHash: snapshotHash("c"),
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-21",
      validationResultAt: "2026-06-21T00:01:00.000Z",
      vitestResultAt: "2026-06-21T00:02:00.000Z",
      previewResultAt: "2026-06-21T00:03:00.000Z",
    };
    expect(
      PublishedInteractionArtifactSchema.safeParse(withProvenance).success,
    ).toBe(true);

    const mismatchedProvenance = clonedArtifact();
    mismatchedProvenance.provenance = {
      sourceHash: snapshotHash("d"),
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-21",
    };
    expect(
      PublishedInteractionArtifactSchema.safeParse(mismatchedProvenance).success,
    ).toBe(false);

    const mismatchedProvenanceCatalogId = clonedArtifact();
    mismatchedProvenanceCatalogId.provenance = {
      sourceHash: cancelAppointmentSourceHash,
      actionCatalogId: "other-actions",
      actionCatalogVersion: "2026-06-21",
    };
    expect(
      PublishedInteractionArtifactSchema.safeParse(mismatchedProvenanceCatalogId)
        .success,
    ).toBe(false);

    const mismatchedProvenanceCatalogVersion = clonedArtifact();
    mismatchedProvenanceCatalogVersion.provenance = {
      sourceHash: cancelAppointmentSourceHash,
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-22",
    };
    expect(
      PublishedInteractionArtifactSchema.safeParse(
        mismatchedProvenanceCatalogVersion,
      ).success,
    ).toBe(false);

    const invalidProvenanceTimestamp = clonedArtifact();
    invalidProvenanceTimestamp.provenance = {
      sourceHash: cancelAppointmentSourceHash,
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-21",
      validationResultAt: "not-a-timestamp",
    };
    expect(
      PublishedInteractionArtifactSchema.safeParse(invalidProvenanceTimestamp)
        .success,
    ).toBe(false);

    const leakedDraftTestSource = clonedArtifact();
    leakedDraftTestSource.provenance = {
      sourceHash: cancelAppointmentSourceHash,
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-21",
      testSource: "import { test } from 'vitest';",
      testMetadata: {
        file: "interaction.test.ts",
      },
    };
    expect(
      PublishedInteractionArtifactSchema.safeParse(leakedDraftTestSource).success,
    ).toBe(false);
  });

  test("rejects invalid draft and branch shapes", () => {
    const missingDraftSource = clonedDraft();
    delete missingDraftSource.source;
    expect(InteractionDraftSchema.safeParse(missingDraftSource).success).toBe(
      false,
    );

    const ownerlessDraft = clonedDraft();
    delete ownerlessDraft.ownerTenantId;
    delete ownerlessDraft.ownerOrganizationId;
    delete ownerlessDraft.ownerUserId;
    expect(InteractionDraftSchema.safeParse(ownerlessDraft).success).toBe(false);

    const invalidDraftBaseHash = clonedDraft();
    invalidDraftBaseHash.baseSourceHash = "sha1:abc";
    expect(InteractionDraftSchema.safeParse(invalidDraftBaseHash).success).toBe(
      false,
    );

    const draftWithProvenance = clonedDraft();
    draftWithProvenance.provenance = {
      sourceHash: cancelAppointmentSourceHash,
      testHash: snapshotHash("b"),
      testSource: "import { test } from 'vitest';",
      testMetadata: {
        runner: "vitest",
        file: "interaction.test.ts",
      },
      validationResultAt: "2026-06-21T00:01:00.000Z",
      vitestResultAt: "2026-06-21T00:02:00.000Z",
      previewResultAt: "2026-06-21T00:03:00.000Z",
    };
    expect(InteractionDraftSchema.safeParse(draftWithProvenance).success).toBe(
      true,
    );

    const invalidDraftProvenance = clonedDraft();
    invalidDraftProvenance.provenance = {
      sourceHash: "sha1:abc",
    };
    expect(InteractionDraftSchema.safeParse(invalidDraftProvenance).success).toBe(
      false,
    );

    const missingBranchId = clonedBranch();
    delete missingBranchId.branchId;
    expect(InteractionBranchSchema.safeParse(missingBranchId).success).toBe(
      false,
    );

    const invalidBranchStatus = clonedBranch();
    invalidBranchStatus.status = "published";
    expect(InteractionBranchSchema.safeParse(invalidBranchStatus).success).toBe(
      false,
    );

    const ownerlessBranch = clonedBranch();
    delete ownerlessBranch.ownerTenantId;
    delete ownerlessBranch.ownerOrganizationId;
    delete ownerlessBranch.ownerUserId;
    expect(InteractionBranchSchema.safeParse(ownerlessBranch).success).toBe(
      false,
    );
  });

  test("projects browser-safe discovery from private artifacts", () => {
    const discoveryItem = toPublicInteractionDiscoveryItem(
      cancelAppointmentInteractionRecord,
      cancelAppointmentPublishedArtifact,
    );

    const keys = collectObjectKeys(discoveryItem);
    const forbiddenKeys = [
      "source",
      "sourceHash",
      "allowedActions",
      "actionCatalogId",
      "actionCatalogVersion",
      "audit",
      "redactPaths",
      "policy",
      "requiredPermissions",
      "tenantScope",
      "runtime",
      "provenance",
      "testHash",
      "testSource",
      "testMetadata",
      "publishRequestHash",
      "validationResultAt",
      "vitestResultAt",
      "previewResultAt",
      "actionBridge",
      "endpointUrl",
      "secretRef",
      "bridgeSecret",
      "sandboxId",
      "draftId",
      "branchId",
      "publishedFromBranchId",
      "mutableDraftData",
    ];

    for (const forbiddenKey of forbiddenKeys) {
      expect(keys.has(forbiddenKey)).toBe(false);
    }

    const values = collectStringValues(discoveryItem);
    const forbiddenValues = [
      cancelAppointmentGeneratedSource,
      "ctx.actions.invoke",
      "booking.cancel",
      cancelAppointmentSourceHash,
      "The interaction cancels one selected appointment.",
      "/input/reason",
      "/output/internalNote",
      "appointments:write",
      "tenantId",
      "sbx_cancel_appointment_runtime",
      "https://customer.example.test/tidegate/actions",
      "bridge-secret-ref:cancel-appointment",
      cancelAppointmentInteractionDraft.draftId,
      cancelAppointmentInteractionDraft.source,
      cancelAppointmentInteractionBranch.branchId,
    ];

    for (const forbiddenValue of forbiddenValues) {
      expect(values.has(forbiddenValue)).toBe(false);
    }
  });

  test("projects discovery invoke paths through the canonical public route builder", () => {
    const record = {
      ...cloned(cancelAppointmentInteractionRecord),
      id: "ix.booking.cancel appointment",
    };
    const artifact = {
      ...cloned(cancelAppointmentPublishedArtifact),
      id: record.id,
    };

    expect(toPublicInteractionDiscoveryItem(record, artifact).invoke).toEqual({
      method: "POST",
      path:
        "/api/v1/interactions/ix.booking.cancel%20appointment/invoke",
    });
  });

  test("rejects public discovery payloads with private fields", () => {
    const unsafeFields: Array<Record<string, unknown>> = [
      { source: cancelAppointmentGeneratedSource },
      { sourceHash: cancelAppointmentSourceHash },
      { allowedActions: [{ id: "booking.cancel" }] },
      { backendActionIds: ["booking.cancel"] },
      {
        actionBridge: {
          endpointUrl: "https://customer.example.test/tidegate/actions",
        },
      },
      { bridgeUrl: "https://customer.example.test/tidegate/actions" },
      { bridgeSecret: "secret_value" },
      { audit: { redactPaths: ["/input/reason"] } },
      { policy: { tenantScope: { fromAuth: "tenantId" } } },
      {
        provenance: {
          sourceHash: cancelAppointmentSourceHash,
          actionCatalogId: "booking-actions",
          actionCatalogVersion: "2026-06-21",
        },
      },
      { testHash: snapshotHash("b") },
      { publishRequestHash: snapshotHash("c") },
      { tenantPolicy: { fromAuth: "tenantId" } },
      { sandboxId: "sbx_cancel_appointment_runtime" },
      { draftId: cancelAppointmentInteractionDraft.draftId },
      { draft: cancelAppointmentInteractionDraft },
      { mutableDraftData: { source: cancelAppointmentInteractionDraft.source } },
      { internalReason: "The interaction cancels one selected appointment." },
    ];

    for (const unsafeField of unsafeFields) {
      expect(
        PublicInteractionDiscoveryItemSchema.safeParse({
          ...cancelAppointmentPublicDiscoveryItem,
          ...unsafeField,
        }).success,
      ).toBe(false);
    }

    expect(
      PublicInteractionDiscoveryItemSchema.safeParse({
        ...cancelAppointmentPublicDiscoveryItem,
        invoke: {
          ...cancelAppointmentPublicDiscoveryItem.invoke,
          bridgeUrl: "https://customer.example.test/tidegate/actions",
        },
      }).success,
    ).toBe(false);

    expect(
      PublicInteractionDiscoveryListResponseSchema.safeParse({
        interactions: [
          {
            ...cancelAppointmentPublicDiscoveryItem,
            sourceHash: cancelAppointmentSourceHash,
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      PublicInteractionDiscoveryDetailResponseSchema.safeParse({
        interaction: {
          ...cancelAppointmentPublicDiscoveryItem,
          draftId: cancelAppointmentInteractionDraft.draftId,
        },
      }).success,
    ).toBe(false);
  });

  test("rejects private fields in publish responses", () => {
    expect(
      PublishInteractionResponseSchema.safeParse({
        ...cancelAppointmentPublishResponse,
        source: cancelAppointmentGeneratedSource,
      }).success,
    ).toBe(false);

    expect(
      PublishInteractionResponseSchema.safeParse({
        ...cancelAppointmentPublishResponse,
        allowedActions: [{ id: "booking.cancel" }],
      }).success,
    ).toBe(false);

    expect(
      PublishInteractionResponseSchema.safeParse({
        ...cancelAppointmentPublishResponse,
        owner: {},
      }).success,
    ).toBe(false);
  });

  test("rejects discovery projection across mismatched record and artifact scope", () => {
    const inactiveRecord = cloned(cancelAppointmentInteractionRecord);
    delete inactiveRecord.activeVersion;
    expect(() =>
      toPublicInteractionDiscoveryItem(
        inactiveRecord,
        cancelAppointmentPublishedArtifact,
      ),
    ).toThrow();

    const tenantArtifact = cloned(cancelAppointmentPublishedArtifact);
    tenantArtifact.visibility = "tenant";
    expect(() =>
      toPublicInteractionDiscoveryItem(
        cancelAppointmentInteractionRecord,
        tenantArtifact,
      ),
    ).toThrow();

    const revokedArtifact = cloned(cancelAppointmentPublishedArtifact);
    revokedArtifact.status = "revoked";
    expect(() =>
      toPublicInteractionDiscoveryItem(
        cancelAppointmentInteractionRecord,
        revokedArtifact,
      ),
    ).toThrow();

    const scopedArtifact = cloned(cancelAppointmentPublishedArtifact);
    scopedArtifact.ownerUserId = "user_other";
    expect(() =>
      toPublicInteractionDiscoveryItem(
        cancelAppointmentInteractionRecord,
        scopedArtifact,
      ),
    ).toThrow();
  });
});
