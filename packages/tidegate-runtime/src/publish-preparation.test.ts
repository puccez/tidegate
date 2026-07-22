import { describe, expect, test } from "bun:test";
import {
  cancelAppointmentGeneratedSource,
  cancelAppointmentPublishRequest,
} from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog";
import { demoActions } from "./demo-fixtures";
import {
  isPublishValidationError,
  preparePublishIntent,
  publishRequestWithRequiredIdempotencyForAllowedActions,
  sourceHash,
} from "./publish-preparation";

const actionCatalogMetadata = {
  id: "booking-actions",
  version: "2026-06-25",
};

const auth: RuntimeAuthContext = {
  organizationId: "demo-salon",
  subjectId: "local-dev",
  subjectType: "user",
  credentialId: "local-dev",
  credentialType: "session",
  scopes: ["tidegate:interaction:publish"],
  userId: "local-dev",
  workosUserId: "local-dev",
  tenantId: "demo-salon",
  salonId: "demo-salon",
  authorization: {
    permissions: ["booking:write"],
    resourceGrants: [],
  },
  permissions: ["booking:write"],
  authMode: "local-dev",
};

function actionCatalog() {
  return new Map(Object.entries(demoActions));
}

function publishBody() {
  return {
    ...structuredClone(cancelAppointmentPublishRequest),
    requestedInteractionId: "ix.booking.runtimePolicyTest",
    source: `${cancelAppointmentGeneratedSource}\n// runtime publish preparation test`,
  };
}

describe("publish preparation", () => {
  test("adds required idempotency for effectful allowed actions", () => {
    const result = publishRequestWithRequiredIdempotencyForAllowedActions({
      actionEffects: ["write"],
      request: {
        ...publishBody(),
        effects: {
          declared: "read",
          riskLevel: "low",
          idempotency: "not_required",
        },
      },
    });

    expect(result.request.effects).toMatchObject({
      declared: "read",
      idempotency: "required",
    });
    expect(result.adjustments).toEqual([
      expect.objectContaining({
        code: "idempotency_required_for_effectful_actions",
        severity: "info",
      }),
    ]);
  });

  test("prepares a publishable artifact without app adapters", async () => {
    const body = publishBody();
    const prepared = await preparePublishIntent({
      auth,
      body,
      resolveActionCatalog: async () => ({
        actionCatalog: actionCatalog(),
        actionCatalogMetadata,
      }),
    });

    expect(prepared.owner).toEqual({
      tenantId: "demo-salon",
      organizationId: "demo-salon",
      userId: "local-dev",
    });
    expect(prepared.publishRequest).toMatchObject({
      requestedInteractionId: "ix.booking.runtimePolicyTest",
    });
    expect(prepared.artifact).toMatchObject({
      id: "ix.booking.runtimePolicyTest",
      sourceHash: sourceHash(body.source),
      actionCatalogId: actionCatalogMetadata.id,
      actionCatalogVersion: actionCatalogMetadata.version,
      allowedActions: [
        {
          id: "booking.cancel",
          reason: "Cancel one appointment in the current salon.",
          maxCalls: 1,
          timeoutMs: 3000,
        },
      ],
      policy: {
        requiredPermissions: ["booking:write"],
      },
    });
  });

  test("keeps wildcard permission grants while staying runtime-local", async () => {
    const wildcardAuth: RuntimeAuthContext = {
      ...auth,
      permissions: ["booking:*"],
      authorization: {
        permissions: ["booking:*"],
        resourceGrants: [],
      },
    };

    const prepared = await preparePublishIntent({
      auth: wildcardAuth,
      body: publishBody(),
      resolveActionCatalog: async () => ({
        actionCatalog: actionCatalog(),
        actionCatalogMetadata,
      }),
    });

    expect(prepared.artifact.id).toBe("ix.booking.runtimePolicyTest");
  });

  test("rejects publish intents whose auth cannot publish a requested action", async () => {
    const authWithoutBookingPermission: RuntimeAuthContext = {
      ...auth,
      permissions: ["tidegate:interaction:*"],
      authorization: {
        permissions: ["tidegate:interaction:*"],
        resourceGrants: [],
      },
    };

    try {
      await preparePublishIntent({
        auth: authWithoutBookingPermission,
        body: publishBody(),
        resolveActionCatalog: async () => ({
          actionCatalog: actionCatalog(),
          actionCatalogMetadata,
        }),
      });
      throw new Error("Expected publish intent preparation to fail.");
    } catch (error) {
      expect(isPublishValidationError(error)).toBe(true);
      expect(error).toMatchObject({
        code: "permission_denied",
        message:
          'The current auth context cannot publish action "booking.cancel".',
        status: 403,
      });
    }
  });
});
