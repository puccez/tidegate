import { describe, expect, test } from "bun:test";
import type { PublishedInteractionArtifact } from "@tidegate/contracts";
import { cancelAppointmentPublishedArtifact } from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import { createScopedInteractionLedger } from "./interaction-ledger.ts";
import { createScopedInteractionRegistry } from "./interaction-registry.ts";

type ArtifactInput = Parameters<
  ReturnType<typeof createScopedInteractionRegistry>["publishArtifactVersion"]
>[0]["artifact"];

const interactionId = "ix.booking.ledgerInvoke";
const auth: RuntimeAuthContext = {
  authMode: "user",
  credentialId: "cred_ledger",
  credentialType: "session",
  organizationId: "demo-salon",
  orgId: "demo-salon",
  tenantId: "demo-salon",
  subjectId: "user_ledger",
  subjectType: "user",
  userId: "user_ledger",
  workosUserId: "user_ledger",
  scopes: ["tidegate:interaction:invoke"],
  permissions: ["booking:write"],
  authorization: {
    permissions: ["booking:write"],
    resourceGrants: [],
  },
};

function invokeBody(overrides: Record<string, unknown> = {}) {
  return {
    input: {
      appointmentId: "apt_ledger",
      reason: "Client requested cancellation",
    },
    surfaceId: "ledger-test",
    sessionId: "sess_ledger",
    messageId: "msg_ledger",
    idempotencyKey: "ledger-test-idempotency",
    ...overrides,
  };
}

function artifactInput(
  overrides: Partial<PublishedInteractionArtifact> = {},
): ArtifactInput {
  const artifact = {
    ...structuredClone(cancelAppointmentPublishedArtifact),
    id: interactionId,
    sourceHash: sourceHash("a"),
    ...overrides,
  };
  const {
    ownerTenantId,
    ownerOrganizationId,
    ownerUserId,
    createdAt,
    createdBySubjectId,
    parentVersion,
    version,
    ...input
  } = artifact;

  return input;
}

function sourceHash(hexChar: string) {
  return `sha256:${hexChar.repeat(64)}`;
}

describe("scoped interaction ledger", () => {
  test("resolves a visible published interaction for invoke and defaults the active version", () => {
    const registry = createScopedInteractionRegistry();
    const ledger = createScopedInteractionLedger({ registry });

    const published = registry.publishArtifactVersion({
      auth,
      artifact: artifactInput(),
    });
    const result = ledger.resolvePublishedInteractionForInvoke({
      auth,
      body: invokeBody(),
      interactionId,
    });

    expect(result).toMatchObject({
      status: "published",
      artifact: {
        id: interactionId,
        version: published.artifact.version,
      },
      request: {
        interactionVersion: published.artifact.version,
      },
    });
  });

  test("rejects pinned historical versions before runtime invocation", () => {
    const registry = createScopedInteractionRegistry();
    const ledger = createScopedInteractionLedger({ registry });

    registry.publishArtifactVersion({
      auth,
      artifact: artifactInput(),
    });

    expect(
      ledger.resolvePublishedInteractionForInvoke({
        auth,
        body: invokeBody({ interactionVersion: "0" }),
        interactionId,
      }),
    ).toEqual({
      status: "version_mismatch",
      code: "interaction_version_mismatch",
      message:
        "Pinned historical interaction versions are not available on this route yet.",
    });
  });

  test("overlays record availability onto the artifact used for runtime invoke", () => {
    const registry = createScopedInteractionRegistry();
    const ledger = createScopedInteractionLedger({ registry });

    registry.publishArtifactVersion({
      auth,
      artifact: artifactInput(),
    });
    registry.setInteractionAvailabilityStatus({
      auth,
      interactionId,
      status: "archived",
      visibility: "user",
    });

    const published = ledger.resolvePublishedInteractionForInvoke({
      auth,
      body: invokeBody(),
      interactionId,
    });
    const runtimeArtifact = ledger.resolvePublishedArtifactForRuntime({
      auth,
      interactionId,
    });

    expect(published).toMatchObject({
      status: "published",
      artifact: {
        status: "archived",
      },
    });
    expect(runtimeArtifact).toMatchObject({
      status: "archived",
    });
  });

  test("returns unavailable when a visible record has no active artifact", () => {
    const registry = createScopedInteractionRegistry();
    const ledger = createScopedInteractionLedger({ registry });

    registry.createInteractionRecord({
      auth,
      interactionId,
      status: "revoked",
      visibility: "user",
    });

    expect(
      ledger.resolvePublishedInteractionForInvoke({
        auth,
        body: invokeBody(),
        interactionId,
      }),
    ).toEqual({
      status: "unavailable",
      code: "interaction_revoked",
      message: "This interaction has been revoked.",
    });
  });

  test("passes through unresolved interactions for static runtime fallback", () => {
    const registry = createScopedInteractionRegistry();
    const ledger = createScopedInteractionLedger({ registry });
    const body = invokeBody();

    expect(
      ledger.resolvePublishedInteractionForInvoke({
        auth,
        body,
        interactionId,
      }),
    ).toEqual({
      status: "not_found",
      request: body,
    });
  });
});
