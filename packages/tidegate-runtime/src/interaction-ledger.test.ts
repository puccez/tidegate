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
  test("resolves a visible published interaction for invoke and defaults the active version", async () => {
    const registry = createScopedInteractionRegistry();
    const ledger = createScopedInteractionLedger({ registry });

    const published = registry.publishArtifactVersion({
      auth,
      artifact: artifactInput(),
    });
    const result = await ledger.resolvePublishedInteractionForInvoke({
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

  test("rejects pinned historical versions before runtime invocation", async () => {
    const registry = createScopedInteractionRegistry();
    const ledger = createScopedInteractionLedger({ registry });

    registry.publishArtifactVersion({
      auth,
      artifact: artifactInput(),
    });

    expect(
      await ledger.resolvePublishedInteractionForInvoke({
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

  test("overlays record availability onto the artifact used for runtime invoke", async () => {
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

    const published = await ledger.resolvePublishedInteractionForInvoke({
      auth,
      body: invokeBody(),
      interactionId,
    });
    const runtimeArtifact = await ledger.resolvePublishedArtifactForRuntime({
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

  test("returns unavailable when a visible record has no active artifact", async () => {
    const registry = createScopedInteractionRegistry();
    const ledger = createScopedInteractionLedger({ registry });

    registry.createInteractionRecord({
      auth,
      interactionId,
      status: "revoked",
      visibility: "user",
    });

    expect(
      await ledger.resolvePublishedInteractionForInvoke({
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

  test("passes through unresolved interactions for static runtime fallback", async () => {
    const registry = createScopedInteractionRegistry();
    const ledger = createScopedInteractionLedger({ registry });
    const body = invokeBody();

    expect(
      await ledger.resolvePublishedInteractionForInvoke({
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

describe("app-pinned interaction resolution (app-bound invoke)", () => {
  function registryWithTwoVersions() {
    const registry = createScopedInteractionRegistry();

    registry.publishArtifactVersion({
      auth,
      artifact: artifactInput({ sourceHash: sourceHash("a") }),
    });
    registry.publishArtifactVersion({
      auth,
      artifact: artifactInput({ sourceHash: sourceHash("b") }),
    });

    return registry;
  }

  test("serves the pinned historical version while a newer active version exists", async () => {
    const registry = registryWithTwoVersions();
    const ledger = createScopedInteractionLedger({ registry });

    const result = await ledger.resolveAppPinnedInteractionForInvoke({
      body: invokeBody(),
      interactionId,
      pinnedRefs: [{ interactionId, version: "1" }],
      resolutionAuth: auth,
    });

    expect(result).toMatchObject({
      status: "published",
      artifact: { id: interactionId, version: "1", status: "active" },
      request: { interactionVersion: "1" },
    });
  });

  test("still serves the pin when it is the active version", async () => {
    const registry = registryWithTwoVersions();
    const ledger = createScopedInteractionLedger({ registry });

    const result = await ledger.resolveAppPinnedInteractionForInvoke({
      body: invokeBody(),
      interactionId,
      pinnedRefs: [{ interactionId, version: "2" }],
      resolutionAuth: auth,
    });

    expect(result).toMatchObject({
      status: "published",
      artifact: { version: "2" },
      request: { interactionVersion: "2" },
    });
  });

  test("an interaction the app does not pin stays unresolvable", async () => {
    const registry = registryWithTwoVersions();
    const ledger = createScopedInteractionLedger({ registry });

    expect(
      await ledger.resolveAppPinnedInteractionForInvoke({
        body: invokeBody(),
        interactionId,
        pinnedRefs: [
          { interactionId: "ix.booking.somethingElse", version: "1" },
        ],
        resolutionAuth: auth,
      }),
    ).toEqual({
      status: "unavailable",
      code: "interaction_unavailable",
      message: "This interaction is not available.",
    });
  });

  test("a pinned version that was never published stays unresolvable", async () => {
    const registry = registryWithTwoVersions();
    const ledger = createScopedInteractionLedger({ registry });

    expect(
      await ledger.resolveAppPinnedInteractionForInvoke({
        body: invokeBody(),
        interactionId,
        pinnedRefs: [{ interactionId, version: "999" }],
        resolutionAuth: auth,
      }),
    ).toMatchObject({
      status: "unavailable",
      code: "interaction_unavailable",
    });
  });

  test("a resolution scope that cannot see the interaction resolves nothing", async () => {
    const registry = registryWithTwoVersions();
    const ledger = createScopedInteractionLedger({ registry });

    expect(
      await ledger.resolveAppPinnedInteractionForInvoke({
        body: invokeBody(),
        interactionId,
        pinnedRefs: [{ interactionId, version: "1" }],
        resolutionAuth: {
          ...auth,
          subjectId: "user_other_creator",
          userId: "user_other_creator",
          workosUserId: "user_other_creator",
        },
      }),
    ).toMatchObject({
      status: "unavailable",
      code: "interaction_unavailable",
    });
  });

  test("a record-level revoke wins over the pinned artifact", async () => {
    const registry = registryWithTwoVersions();
    const ledger = createScopedInteractionLedger({ registry });

    registry.setInteractionAvailabilityStatus({
      auth,
      interactionId,
      status: "revoked",
      visibility: "user",
    });

    const result = await ledger.resolveAppPinnedInteractionForInvoke({
      body: invokeBody(),
      interactionId,
      pinnedRefs: [{ interactionId, version: "1" }],
      resolutionAuth: auth,
    });

    // The availability overlay carries the revoke to the kernel's policy
    // engine, which hard-denies revoked interactions.
    expect(result).toMatchObject({
      status: "published",
      artifact: { status: "revoked" },
    });
  });

  test("a body that pins a version different from the app's pin is a mismatch", async () => {
    const registry = registryWithTwoVersions();
    const ledger = createScopedInteractionLedger({ registry });

    expect(
      await ledger.resolveAppPinnedInteractionForInvoke({
        body: invokeBody({ interactionVersion: "2" }),
        interactionId,
        pinnedRefs: [{ interactionId, version: "1" }],
        resolutionAuth: auth,
      }),
    ).toMatchObject({
      status: "version_mismatch",
      code: "interaction_version_mismatch",
    });
  });

  test("the machine route still rejects pinned historical versions", async () => {
    const registry = registryWithTwoVersions();
    const ledger = createScopedInteractionLedger({ registry });

    expect(
      await ledger.resolvePublishedInteractionForInvoke({
        auth,
        body: invokeBody({ interactionVersion: "1" }),
        interactionId,
      }),
    ).toMatchObject({
      status: "version_mismatch",
      code: "interaction_version_mismatch",
    });
  });
});
