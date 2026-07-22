import { describe, expect, test } from "bun:test";
import type { PublishedInteractionArtifact } from "@tidegate/contracts";
import {
  cancelAppointmentGeneratedSource,
  cancelAppointmentPublishedArtifact,
} from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog";
import { InMemoryPublishedInteractionLedger } from "./interaction-published-ledger";
import { InteractionRegistryError } from "./interaction-registry-errors";

type ArtifactInput = Parameters<
  InMemoryPublishedInteractionLedger["publishArtifactVersion"]
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

describe("published interaction ledger", () => {
  test("publishes immutable versions and resolves the active record", () => {
    const ledger = new InMemoryPublishedInteractionLedger();
    const first = ledger.publishArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        source: `${cancelAppointmentGeneratedSource}\n// ledger v1`,
        sourceHash: sourceHash("1"),
      }),
      now: "2026-06-30T00:00:00.000Z",
      title: "Cancel appointment",
    });
    const second = ledger.publishArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        source: `${cancelAppointmentGeneratedSource}\n// ledger v2`,
        sourceHash: sourceHash("2"),
      }),
      now: "2026-06-30T00:01:00.000Z",
    });

    expect(first.artifact.version).toBe("1");
    expect(second.artifact).toMatchObject({
      parentVersion: "1",
      version: "2",
    });
    expect(
      ledger.resolveActiveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
      })?.artifact.sourceHash,
    ).toBe(sourceHash("2"));
    expect(
      ledger.resolveVersion({
        auth: baseAuth,
        interactionId,
        version: "1",
        visibility: "user",
      })?.artifact.sourceHash,
    ).toBe(sourceHash("1"));
    expect(
      ledger.listVisibleActiveVersions({ auth: baseAuth }).map((resolution) => ({
        interactionId: resolution.record.id,
        version: resolution.artifact.version,
      })),
    ).toEqual([
      {
        interactionId,
        version: "2",
      },
    ]);
  });

  test("keeps source-hash collision policy local to the ledger", () => {
    const ledger = new InMemoryPublishedInteractionLedger();

    ledger.publishArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        id: "ix.booking.ledgerCollisionA",
        source: "source a",
        sourceHash: sourceHash("a"),
      }),
    });

    expectLedgerError(
      () =>
        ledger.publishArtifactVersion({
          auth: baseAuth,
          artifact: artifactInput({
            id: "ix.booking.ledgerCollisionB",
            source: "source b",
            sourceHash: sourceHash("a"),
          }),
        }),
      "source_hash_collision",
    );
  });

  test("detects stale branch bases using published active-version state", () => {
    const ledger = new InMemoryPublishedInteractionLedger();
    const first = ledger.publishArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        source: `${cancelAppointmentGeneratedSource}\n// branch base v1`,
        sourceHash: sourceHash("b"),
      }),
    });

    ledger.assertActiveVersionMatchesBranchSource({
      branchId: "branch_ledger_base",
      interactionId,
      scope: first.scope,
      sourceHash: sourceHash("b"),
      version: "1",
    });

    ledger.publishArtifactVersion({
      auth: baseAuth,
      artifact: artifactInput({
        source: `${cancelAppointmentGeneratedSource}\n// branch base v2`,
        sourceHash: sourceHash("c"),
      }),
    });

    expectLedgerError(
      () =>
        ledger.assertActiveVersionMatchesBranchSource({
          branchId: "branch_ledger_base",
          interactionId,
          scope: first.scope,
          sourceHash: sourceHash("b"),
          version: "1",
        }),
      "branch_base_changed",
    );
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
    version,
    ...input
  } = artifact;
  void version;

  return input;
}

function expectLedgerError(
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
