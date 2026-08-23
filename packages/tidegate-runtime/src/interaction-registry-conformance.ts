/**
 * Cross-backend conformance suite for the `ScopedInteractionRegistry` seam.
 *
 * `runScopedInteractionRegistryConformance({ name, createRegistry })`
 * registers the executable contract every registry backend must pass:
 * record/version storage, scope isolation, optimistic concurrency on the
 * publish/move/revoke paths, draft and branch lifecycles, and provenance
 * propagation. The suite only talks to the `ScopedInteractionRegistry`
 * interface and awaits every call, so it runs identically against the
 * synchronous in-memory backend and async database-backed ones.
 *
 * Every scenario derives its owner scope from a fresh random namespace:
 * a persistent backend (Postgres) stays hermetic across runs without any
 * truncation step. A new backend is correct iff this suite passes against
 * it (prior art: `sandbox-backend-conformance.ts`).
 *
 * NOTE: this module imports `bun:test` — import it from test files only.
 */
import { describe, expect, test } from "bun:test";
import type { PublishedInteractionArtifact } from "@tidegate/contracts";
import {
  cancelAppointmentGeneratedSource,
  cancelAppointmentPublishRequest,
  cancelAppointmentPublishedArtifact,
} from "@tidegate/contracts/fixtures";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import { createInteractionDraftPublicationPlan } from "./interaction-draft-publication.ts";
import {
  InteractionRegistryError,
  type CreatePublishedInteractionArtifactVersionInput,
  type InteractionDraftPublishRequestSnapshot,
} from "./interaction-registry.ts";
import type {
  ScopedInteractionRegistry,
  ScopedInteractionRegistryResult,
} from "./scoped-interaction-registry.ts";

export type ScopedInteractionRegistryConformanceOptions = {
  name: string;
  /**
   * One backend per scenario. In-memory backends return a fresh instance;
   * database-backed backends may return a shared instance — scenarios never
   * collide because every one lives in its own random owner scope.
   */
  createRegistry: () => ScopedInteractionRegistryResult<ScopedInteractionRegistry>;
  /** Per-test timeout for slow backends (a real database round-trip per call). */
  timeoutMs?: number;
};

type ArtifactInput = CreatePublishedInteractionArtifactVersionInput["artifact"];

const interactionId = "ix.booking.cancelAppointment";

type ConformanceScenario = {
  registry: ScopedInteractionRegistry;
  baseAuth: RuntimeAuthContext;
  auth: (overrides?: Partial<RuntimeAuthContext>) => RuntimeAuthContext;
  /** Namespaces globally-unique identifiers (draft ids, branch ids, owners). */
  id: (value: string) => string;
};

export function runScopedInteractionRegistryConformance({
  createRegistry,
  name,
  timeoutMs,
}: ScopedInteractionRegistryConformanceOptions): void {
  const scenarioTest: typeof test =
    timeoutMs === undefined
      ? test
      : (((label: string, fn: () => Promise<void>) =>
          test(label, fn, timeoutMs)) as typeof test);

  async function scenario(): Promise<ConformanceScenario> {
    const ns = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const id = (value: string) => `${value}_${ns}`;
    const baseAuth: RuntimeAuthContext = {
      organizationId: id("org"),
      subjectId: id("user"),
      subjectType: "user",
      credentialId: id("cred"),
      credentialType: "session",
      scopes: ["tidegate:interaction:publish"],
      userId: id("user"),
      workosUserId: id("user"),
      tenantId: id("tenant"),
      clientId: id("app"),
      authorization: {
        permissions: ["interactions:publish"],
        resourceGrants: [],
      },
      permissions: ["interactions:publish"],
      authMode: "user",
    };

    return {
      registry: await createRegistry(),
      baseAuth,
      auth: (overrides = {}) => ({ ...baseAuth, ...overrides }),
      id,
    };
  }

  describe(`scoped interaction registry conformance: ${name}`, () => {
    scenarioTest("stores published artifact versions immutably", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// immutable v1`;

      await registry.createInteractionRecord({
        auth: baseAuth,
        interactionId,
        visibility: "user",
      });

      const artifact = artifactInput({
        source,
        sourceHash: sourceHash("a"),
      });

      await registry.createArtifactVersion({
        auth: baseAuth,
        artifact,
      });

      artifact.source = "tampered after create";

      const resolved = await registry.resolveVersion({
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
        (
          await registry.resolveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            version: "1",
          })
        )?.artifact.source,
      ).toBe(source);
    });

    scenarioTest("moves activeVersion from version 1 to version 2 without changing version 1", async () => {
      const { registry, baseAuth } = await scenario();

      await registry.createInteractionRecord({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        now: "2026-06-21T00:00:00.000Z",
      });
      await registry.createArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          version: "1",
          source: "export default async function run() { return { version: 1 }; }",
          sourceHash: sourceHash("1"),
        }),
      });
      await registry.createArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          version: "2",
          parentVersion: "1",
          source: "export default async function run() { return { version: 2 }; }",
          sourceHash: sourceHash("2"),
        }),
      });

      await registry.moveActiveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        nextVersion: "1",
        expectedActiveVersion: null,
        now: "2026-06-21T00:01:00.000Z",
      });

      const versionOneBeforeMove = await registry.resolveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        version: "1",
      });

      await registry.moveActiveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        nextVersion: "2",
        expectedActiveVersion: "1",
        now: "2026-06-21T00:02:00.000Z",
      });

      expect(
        (
          await registry.resolveActiveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
          })
        )?.artifact.version,
      ).toBe("2");
      expect(versionOneBeforeMove?.artifact.version).toBe("1");
      expect(
        (
          await registry.resolveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            version: "1",
          })
        )?.artifact.source,
      ).toContain("version: 1");
    });

    scenarioTest("rejects stale expectations on the move and publish concurrency paths", async () => {
      const { registry, baseAuth } = await scenario();

      await publishActiveArtifact(registry, {
        auth: baseAuth,
        visibility: "user",
        source: "export default async function run() { return { version: 1 }; }",
        sourceHash: sourceHash("1"),
      });
      await registry.createArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          version: "2",
          parentVersion: "1",
          source: "export default async function run() { return { version: 2 }; }",
          sourceHash: sourceHash("2"),
        }),
      });

      // The record is on active version "1": a mover that believed it was
      // still unset (or already on "2") must fail without side effects.
      await expectRegistryError(
        () =>
          registry.moveActiveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            nextVersion: "2",
            expectedActiveVersion: null,
          }),
        "interaction_version_conflict",
      );
      await expectRegistryError(
        () =>
          registry.moveActiveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            nextVersion: "2",
            expectedActiveVersion: "2",
          }),
        "interaction_version_conflict",
      );
      expect(
        (
          await registry.resolveActiveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
          })
        )?.artifact.version,
      ).toBe("1");

      // Same guard on the publish path: expectedActiveVersion pins the base.
      await expectRegistryError(
        () =>
          registry.publishArtifactVersion({
            auth: baseAuth,
            artifact: artifactInput({
              version: "3",
              source: "export default async function run() { return { version: 3 }; }",
              sourceHash: sourceHash("3"),
            }),
            expectedActiveVersion: null,
          }),
        "interaction_version_conflict",
      );

      const published = await registry.publishArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          version: "3",
          source: "export default async function run() { return { version: 3 }; }",
          sourceHash: sourceHash("3"),
        }),
        expectedActiveVersion: "1",
      });

      expect(published.record.activeVersion).toBe("3");
    });

    scenarioTest("reactivates archived interactions during publish and keeps revoked ones blocked", async () => {
      const { registry, baseAuth } = await scenario();
      const archivedId = "ix.booking.archivedPublish";
      const revokedId = "ix.booking.revokedPublish";

      await registry.publishArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          id: archivedId,
          version: "1",
          source: "export default async function run() { return { version: 1 }; }",
          sourceHash: sourceHash("a"),
        }),
      });
      await registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId: archivedId,
        visibility: "user",
        status: "archived",
      });
      await registry.publishArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          id: archivedId,
          version: "2",
          parentVersion: "1",
          source: "export default async function run() { return { version: 2 }; }",
          sourceHash: sourceHash("b"),
        }),
      });

      const republished = await registry.resolveActiveVersion({
        auth: baseAuth,
        interactionId: archivedId,
        visibility: "user",
      });
      expect(republished?.record.status).toBe("active");
      expect(republished?.artifact.version).toBe("2");

      await registry.publishArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          id: revokedId,
          version: "1",
          source: "export default async function run() { return { version: 1 }; }",
          sourceHash: sourceHash("c"),
        }),
      });
      await registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId: revokedId,
        visibility: "user",
        status: "revoked",
      });

      await expectRegistryError(
        () =>
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
        "interaction_unavailable",
      );

      expect(
        (
          await registry.resolveActiveVersion({
            auth: baseAuth,
            interactionId: revokedId,
            visibility: "user",
          })
        )?.record.status,
      ).toBe("revoked");
    });

    scenarioTest("keeps the same interaction id isolated across user, tenant, organization, and app scopes", async () => {
      const { registry, auth, id } = await scenario();
      const scopedArtifacts = [
        {
          visibility: "user" as const,
          auth: auth({ userId: id("user_scope"), subjectId: id("user_scope") }),
          source: "user scoped source",
          hash: sourceHash("3"),
        },
        {
          visibility: "tenant" as const,
          auth: auth({ tenantId: id("tenant_scope") }),
          source: "tenant scoped source",
          hash: sourceHash("4"),
        },
        {
          visibility: "organization" as const,
          auth: auth({ organizationId: id("org_scope") }),
          source: "organization scoped source",
          hash: sourceHash("5"),
        },
        {
          visibility: "app" as const,
          auth: auth({ clientId: id("app_scope") }),
          source: "app scoped source",
          hash: sourceHash("6"),
        },
        {
          visibility: "app" as const,
          auth: auth({ clientId: id("app_scope_other") }),
          source: "other app scoped source",
          hash: sourceHash("f"),
        },
      ];

      for (const scopedArtifact of scopedArtifacts) {
        await registry.createInteractionRecord({
          auth: scopedArtifact.auth,
          interactionId,
          visibility: scopedArtifact.visibility,
        });
        await registry.createArtifactVersion({
          auth: scopedArtifact.auth,
          artifact: artifactInput({
            visibility: scopedArtifact.visibility,
            source: scopedArtifact.source,
            sourceHash: scopedArtifact.hash,
          }),
        });
        await registry.moveActiveVersion({
          auth: scopedArtifact.auth,
          interactionId,
          visibility: scopedArtifact.visibility,
          nextVersion: "1",
        });
      }

      for (const scopedArtifact of scopedArtifacts) {
        expect(
          (
            await registry.resolveActiveVersion({
              auth: scopedArtifact.auth,
              interactionId,
              visibility: scopedArtifact.visibility,
            })
          )?.artifact.source,
        ).toBe(scopedArtifact.source);
      }
    });

    scenarioTest("returns scoped misses for callers from another user, tenant, or organization", async () => {
      const { registry, baseAuth, auth, id } = await scenario();

      await publishActiveArtifact(registry, {
        auth: baseAuth,
        visibility: "user",
        source: "private user source",
        sourceHash: sourceHash("7"),
      });

      expect(
        await registry.resolveActiveVersion({
          auth: auth({ userId: id("user_other"), subjectId: id("user_other") }),
          interactionId,
          visibility: "user",
        }),
      ).toBeUndefined();
      expect(
        await registry.resolveActiveVersion({
          auth: auth({ tenantId: id("tenant_other") }),
          interactionId,
          visibility: "user",
        }),
      ).toBeUndefined();
      expect(
        await registry.resolveActiveVersion({
          auth: auth({ organizationId: id("org_other") }),
          interactionId,
          visibility: "user",
        }),
      ).toBeUndefined();

      await publishActiveArtifact(registry, {
        auth: auth({ tenantId: id("tenant_owner") }),
        visibility: "tenant",
        source: "private tenant source",
        sourceHash: sourceHash("8"),
      });
      await publishActiveArtifact(registry, {
        auth: auth({ organizationId: id("org_owner") }),
        visibility: "organization",
        source: "private organization source",
        sourceHash: sourceHash("9"),
      });

      expect(
        await registry.resolveActiveVersion({
          auth: auth({ tenantId: id("tenant_other") }),
          interactionId,
          visibility: "tenant",
        }),
      ).toBeUndefined();
      expect(
        await registry.resolveActiveVersion({
          auth: auth({ organizationId: id("org_other") }),
          interactionId,
          visibility: "organization",
        }),
      ).toBeUndefined();
    });

    scenarioTest("distinguishes missing, active, and explicit version mismatch cases", async () => {
      const { registry, baseAuth } = await scenario();

      expect(
        await registry.resolveActiveVersion({
          auth: baseAuth,
          interactionId: "ix.booking.missing",
          visibility: "user",
        }),
      ).toBeUndefined();

      await registry.createInteractionRecord({
        auth: baseAuth,
        interactionId,
        visibility: "user",
      });
      expect(
        await registry.resolveActiveVersion({
          auth: baseAuth,
          interactionId,
          visibility: "user",
        }),
      ).toBeUndefined();

      await registry.createArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          sourceHash: sourceHash("b"),
        }),
      });
      await registry.moveActiveVersion({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        nextVersion: "1",
      });

      expect(
        (
          await registry.resolveActiveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
          })
        )?.artifact.version,
      ).toBe("1");
      expect(
        await registry.resolveVersion({
          auth: baseAuth,
          interactionId,
          visibility: "user",
          version: "2",
        }),
      ).toBeUndefined();
      await expectRegistryError(
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

    scenarioTest("stores archived and revoked availability state", async () => {
      const { registry, baseAuth } = await scenario();

      await publishActiveArtifact(registry, {
        auth: baseAuth,
        visibility: "user",
        source: "status source",
        sourceHash: sourceHash("c"),
      });

      const artifactBeforeArchive = (
        await registry.resolveVersion({
          auth: baseAuth,
          interactionId,
          visibility: "user",
          version: "1",
        })
      )?.artifact;

      expect(
        (
          await registry.setInteractionAvailabilityStatus({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            status: "archived",
          })
        ).status,
      ).toBe("archived");
      expect(
        (
          await registry.resolveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            version: "1",
          })
        )?.artifact,
      ).toEqual(artifactBeforeArchive);
      expect(
        (
          await registry.setInteractionAvailabilityStatus({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            status: "revoked",
          })
        ).status,
      ).toBe("revoked");
      expect(
        (
          await registry.resolveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            version: "1",
          })
        )?.artifact,
      ).toEqual(artifactBeforeArchive);

      const revokedInteractionId = "ix.booking.revokedCancelAppointment";
      await registry.createInteractionRecord({
        auth: baseAuth,
        interactionId: revokedInteractionId,
        visibility: "user",
      });
      await registry.createArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          id: revokedInteractionId,
          status: "revoked",
          source: "revoked source",
          sourceHash: sourceHash("d"),
        }),
      });
      await registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId: revokedInteractionId,
        visibility: "user",
        status: "revoked",
      });

      expect(
        (
          await registry.resolveVersion({
            auth: baseAuth,
            interactionId: revokedInteractionId,
            visibility: "user",
            version: "1",
          })
        )?.artifact.status,
      ).toBe("revoked");
    });

    scenarioTest("keeps revoked as a terminal state on the availability write path", async () => {
      const { registry, baseAuth } = await scenario();

      await publishActiveArtifact(registry, {
        auth: baseAuth,
        visibility: "user",
        source: "terminal revoke source",
        sourceHash: sourceHash("e"),
      });
      await registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        status: "revoked",
      });

      // A stale archive request that lost the race against the revoke must
      // not resurrect the record (revoking again stays idempotent).
      await expectRegistryError(
        () =>
          registry.setInteractionAvailabilityStatus({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            status: "archived",
          }),
        "interaction_version_conflict",
      );
      expect(
        (
          await registry.setInteractionAvailabilityStatus({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            status: "revoked",
          })
        ).status,
      ).toBe("revoked");
      expect(
        (
          await registry.resolveVisibleInteraction({
            auth: baseAuth,
            interactionId,
          })
        )?.record.status,
      ).toBe("revoked");
    });

    scenarioTest("lists active visible interactions without archived, revoked, or foreign scoped records", async () => {
      const { registry, baseAuth, auth, id } = await scenario();
      const visibleUserId = "ix.booking.visibleUser";
      const visibleTenantId = "ix.booking.visibleTenant";
      const archivedId = "ix.booking.archived";
      const revokedId = "ix.booking.revoked";

      await publishActiveArtifact(registry, {
        auth: baseAuth,
        interactionId: visibleUserId,
        visibility: "user",
        source: "visible user source",
        sourceHash: sourceHash("0"),
      });
      await publishActiveArtifact(registry, {
        auth: baseAuth,
        interactionId: visibleTenantId,
        visibility: "tenant",
        source: "visible tenant source",
        sourceHash: sourceHash("1"),
      });
      await publishActiveArtifact(registry, {
        auth: auth({ userId: id("user_other"), subjectId: id("user_other") }),
        interactionId: "ix.booking.hiddenUser",
        visibility: "user",
        source: "hidden user source",
        sourceHash: sourceHash("2"),
      });
      await publishActiveArtifact(registry, {
        auth: auth({ tenantId: id("tenant_other") }),
        interactionId: "ix.booking.hiddenTenant",
        visibility: "tenant",
        source: "hidden tenant source",
        sourceHash: sourceHash("3"),
      });
      await publishActiveArtifact(registry, {
        auth: baseAuth,
        interactionId: archivedId,
        visibility: "user",
        source: "archived source",
        sourceHash: sourceHash("4"),
      });
      await publishActiveArtifact(registry, {
        auth: baseAuth,
        interactionId: revokedId,
        visibility: "user",
        source: "revoked source",
        sourceHash: sourceHash("5"),
      });

      await registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId: archivedId,
        visibility: "user",
        status: "archived",
      });
      await registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId: revokedId,
        visibility: "user",
        status: "revoked",
      });

      const visible = await registry.listVisibleActiveVersions({ auth: baseAuth });

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
        (
          await registry.resolveVisibleInteraction({
            auth: baseAuth,
            interactionId: archivedId,
          })
        )?.record.status,
      ).toBe("archived");
      expect(
        await registry.resolveVisibleInteraction({
          auth: baseAuth,
          interactionId: "ix.booking.hiddenTenant",
        }),
      ).toBeUndefined();
    });

    scenarioTest("rejects unsafe id reuse and source hash collisions within a scope", async () => {
      const { registry, baseAuth, auth, id } = await scenario();

      await registry.createInteractionRecord({
        auth: baseAuth,
        interactionId,
        visibility: "user",
      });
      await expectRegistryError(
        () =>
          registry.createInteractionRecord({
            auth: baseAuth,
            interactionId,
            visibility: "user",
          }),
        "unsafe_interaction_id_reuse",
      );

      await registry.createArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          source: "collision source one",
          sourceHash: sourceHash("e"),
        }),
      });

      const collisionInteractionId = "ix.booking.collision";
      await registry.createInteractionRecord({
        auth: baseAuth,
        interactionId: collisionInteractionId,
        visibility: "user",
      });
      await expectRegistryError(
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

      await registry.createInteractionRecord({
        auth: auth({ userId: id("user_other"), subjectId: id("user_other") }),
        interactionId,
        visibility: "user",
      });
    });

    scenarioTest("materializes artifact-backed branches from immutable published source", async () => {
      const { registry, baseAuth, id } = await scenario();
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

      await publishActiveArtifact(registry, {
        auth: baseAuth,
        visibility: "user",
        source: publishedSource,
        sourceHash: sourceHash("a"),
        artifact: {
          actionCatalogVersion: "2026-06-25",
          provenance: artifactProvenance,
        },
      });

      const firstBranch = await registry.createBranch({
        auth: baseAuth,
        interactionId,
      });
      await registry.updateDraftSource({
        auth: baseAuth,
        draftId: firstBranch.draft.draftId,
        source: `${cancelAppointmentGeneratedSource}\n// mutable branch draft`,
        provenance: {
          sourceHash: sourceHash("d"),
        },
      });

      const secondBranch = await registry.createBranch({
        auth: baseAuth,
        branchId: id("branch_from_artifact_snapshot"),
        draftId: id("draft_from_artifact_snapshot"),
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

    scenarioTest("resolves branches for owners and explicit reviewer access only", async () => {
      const { registry, baseAuth, auth, id } = await scenario();

      await publishActiveArtifact(registry, {
        auth: baseAuth,
        visibility: "user",
        source: "branch resolution source",
        sourceHash: sourceHash("a"),
      });

      const created = await registry.createBranch({
        auth: baseAuth,
        interactionId,
      });
      const branchId = created.branch.branchId;

      expect(
        (await registry.resolveBranch({ auth: baseAuth, branchId }))?.branch
          .branchId,
      ).toBe(branchId);
      expect(
        (
          await registry.resolveBranchForDraft({
            auth: baseAuth,
            draftId: created.draft.draftId,
          })
        )?.branch.branchId,
      ).toBe(branchId);

      const strangerAuth = auth({
        userId: id("user_other"),
        subjectId: id("user_other"),
      });

      expect(
        await registry.resolveBranch({ auth: strangerAuth, branchId }),
      ).toBeUndefined();
      expect(
        (
          await registry.resolveBranch({
            allowReviewerAccess: true,
            auth: strangerAuth,
            branchId,
          })
        )?.branch.branchId,
      ).toBe(branchId);
    });

    scenarioTest("stores draft source by owner scope and allows explicit reviewer lookup", async () => {
      const { registry, baseAuth, auth, id } = await scenario();
      const draft = await registry.createDraft({
        actionCatalogId: "booking-actions",
        actionCatalogVersion: "2026-06-25",
        auth: baseAuth,
        publishRequest: draftPublishRequest(),
        source: `${cancelAppointmentGeneratedSource}\n// draft owner source`,
      });

      expect(draft.draft.ownerUserId).toBe(baseAuth.userId);
      expect(Object.isFrozen(draft.draft)).toBe(true);
      expect(
        await registry.resolveDraft({
          auth: auth({ userId: id("user_other"), subjectId: id("user_other") }),
          draftId: draft.draft.draftId,
        }),
      ).toBeUndefined();

      await expectRegistryError(
        () =>
          registry.updateDraftSource({
            auth: auth({ userId: id("user_other"), subjectId: id("user_other") }),
            draftId: draft.draft.draftId,
            source: "export default async function run() { return {}; }",
          }),
        "interaction_draft_missing",
      );

      const reviewerDraft = await registry.resolveDraft({
        allowReviewerAccess: true,
        auth: auth({
          subjectId: id("reviewer"),
          userId: id("reviewer"),
        }),
        draftId: draft.draft.draftId,
      });

      expect(reviewerDraft?.draft.draftId).toBe(draft.draft.draftId);
    });

    scenarioTest("records draft provenance and clears stale source-coupled metadata", async () => {
      const { registry, baseAuth, id } = await scenario();
      const emptyDraft = await registry.createDraft({
        actionCatalogId: "booking-actions",
        actionCatalogVersion: "2026-06-25",
        auth: baseAuth,
        draftId: id("draft_empty_provenance"),
        publishRequest: draftPublishRequest({
          requestedInteractionId: "ix.booking.emptyProvenance",
        }),
        source: `${cancelAppointmentGeneratedSource}\n// empty provenance`,
      });
      const emptyProvenance = await registry.recordDraftProvenance({
        auth: baseAuth,
        draftId: emptyDraft.draft.draftId,
        provenance: {},
      });

      expect(emptyProvenance.draft.provenance).toBeUndefined();

      const source = `${cancelAppointmentGeneratedSource}\n// draft provenance`;
      const draft = await registry.createDraft({
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

      const previewed = await registry.recordDraftProvenance({
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

      const publishable = await registry.setDraftStatus({
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

      const staleCleared = await registry.updateDraftSource({
        auth: baseAuth,
        draftId: draft.draft.draftId,
        source: `${source}\n// source changed without synced hash`,
      });

      expect(staleCleared.draft.provenance).toBeUndefined();

      const synced = await registry.updateDraftSource({
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

    scenarioTest("publishes reviewer-approved drafts into the draft owner scope", async () => {
      const { registry, baseAuth, auth, id } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// reviewer approved`;
      const draft = await registry.createDraft({
        actionCatalogId: "booking-actions",
        actionCatalogVersion: "2026-06-25",
        auth: baseAuth,
        publishRequest: draftPublishRequest(),
        source,
      });
      const reviewerAuth = auth({
        subjectId: id("reviewer"),
        userId: id("reviewer"),
      });

      const published = await registry.publishDraftArtifactVersion({
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

      expect(published.artifact.createdBySubjectId).toBe(id("reviewer"));
      expect(
        (
          await registry.resolveActiveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
          })
        )?.artifact.source,
      ).toBe(source);
      expect(
        await registry.resolveActiveVersion({
          auth: reviewerAuth,
          interactionId,
          visibility: "user",
        }),
      ).toBeUndefined();
    });

    scenarioTest("copies draft validation provenance into published artifacts", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// provenance publish`;
      const draft = await registry.createDraft({
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

      const published = await registry.publishDraftArtifactVersion({
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
      await registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        status: "archived",
      });
      expect(
        (
          await registry.resolveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            version: "1",
          })
        )?.artifact.provenance,
      ).toEqual(artifactBeforeArchive.provenance);

      await registry.setInteractionAvailabilityStatus({
        auth: baseAuth,
        interactionId,
        visibility: "user",
        status: "revoked",
      });
      expect(
        (
          await registry.resolveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
            version: "1",
          })
        )?.artifact.provenance,
      ).toEqual(artifactBeforeArchive.provenance);
    });

    scenarioTest("rejects publishing draft artifacts with stale source provenance", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// stale provenance`;
      const draft = await registry.createDraft({
        actionCatalogId: "booking-actions",
        actionCatalogVersion: "2026-06-25",
        auth: baseAuth,
        publishRequest: draftPublishRequest(),
        source,
        provenance: {
          sourceHash: sourceHash("a"),
        },
      });

      await expectRegistryError(
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

    scenarioTest("rejects publishing draft result metadata without source provenance", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// missing source hash`;
      const draft = await registry.createDraft({
        actionCatalogId: "booking-actions",
        actionCatalogVersion: "2026-06-25",
        auth: baseAuth,
        publishRequest: draftPublishRequest(),
        source,
        provenance: {
          validationResultAt: "2026-06-25T00:01:00.000Z",
        },
      });

      await expectRegistryError(
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

    scenarioTest("rejects explicit artifact provenance that contradicts draft evidence", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// explicit mismatch`;
      const draft = await registry.createDraft({
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

      await expectRegistryError(
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

    scenarioTest("rejects explicit artifact provenance that invents draft evidence", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// explicit invented evidence`;
      const draft = await registry.createDraft({
        actionCatalogId: "booking-actions",
        actionCatalogVersion: "2026-06-25",
        auth: baseAuth,
        publishRequest: draftPublishRequest(),
        source,
        provenance: {
          sourceHash: sourceHash("a"),
        },
      });

      await expectRegistryError(
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

    scenarioTest("rejects explicit artifact provenance that mismatches the artifact snapshot", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// explicit snapshot mismatch`;
      const draft = await registry.createDraft({
        actionCatalogId: "booking-actions",
        actionCatalogVersion: "2026-06-25",
        auth: baseAuth,
        publishRequest: draftPublishRequest(),
        source,
      });

      await expectRegistryError(
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

    scenarioTest("omits undefined optional provenance keys from published artifacts", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// compact provenance`;
      const draft = await registry.createDraft({
        actionCatalogId: "booking-actions",
        actionCatalogVersion: "2026-06-25",
        auth: baseAuth,
        publishRequest: draftPublishRequest(),
        source,
        provenance: {
          sourceHash: sourceHash("a"),
        },
      });

      const published = await registry.publishDraftArtifactVersion({
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

    scenarioTest("publishes validated ordinary drafts and marks the draft publishable", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// validated publication`;
      const sourceHashValue = sourceHash("b");
      const draft = await registry.createDraft({
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

      const published = await registry.publishValidatedInteractionDraft({
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
      });

      expect(published.artifact).toMatchObject({
        id: "ix.booking.validatedDraftPublication",
        sourceHash: sourceHashValue,
        version: "1",
      });
      expect(
        (
          await registry.resolveDraft({
            auth: baseAuth,
            draftId: draft.draft.draftId,
          })
        )?.draft.status,
      ).toBe("publishable");
    });

    scenarioTest("publishes validated branch drafts and merges the branch", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// branch publication`;
      const sourceHashValue = sourceHash("c");

      await publishActiveArtifact(registry, {
        auth: baseAuth,
        visibility: "user",
        source: `${cancelAppointmentGeneratedSource}\n// branch publication base`,
        sourceHash: sourceHash("d"),
        artifact: { actionCatalogVersion: "2026-06-25" },
      });
      const branch = await registry.createBranch({
        auth: baseAuth,
        interactionId,
        publishTarget: "same-interaction",
      });
      await registry.updateDraftSource({
        auth: baseAuth,
        draftId: branch.draft.draftId,
        provenance: {
          sourceHash: sourceHashValue,
        },
        source,
      });
      const resolvedBranch = await registry.resolveBranchForDraft({
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

      const published = await registry.publishValidatedInteractionDraft({
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
        (
          await registry.resolveDraft({
            auth: baseAuth,
            draftId: branch.draft.draftId,
          })
        )?.draft.status,
      ).toBe("publishable");
      expect(
        (
          await registry.resolveActiveVersion({
            auth: baseAuth,
            interactionId,
            visibility: "user",
          })
        )?.artifact.version,
      ).toBe("2");

      // A merged branch never publishes twice.
      await expectRegistryError(
        () =>
          registry.publishBranchDraftArtifactVersion({
            artifact: artifactInput({
              actionCatalogVersion: "2026-06-25",
              id: interactionId,
              source,
              sourceHash: sourceHashValue,
              version: "3",
            }),
            auth: baseAuth,
            draftId: branch.draft.draftId,
          }),
        "interaction_version_conflict",
      );
    });

    scenarioTest("rejects a same-interaction branch publish after the base version moved", async () => {
      const { registry, baseAuth } = await scenario();
      const source = `${cancelAppointmentGeneratedSource}\n// stale branch base`;

      await publishActiveArtifact(registry, {
        auth: baseAuth,
        visibility: "user",
        source: `${cancelAppointmentGeneratedSource}\n// branch base v1`,
        sourceHash: sourceHash("a"),
        artifact: { actionCatalogVersion: "2026-06-25" },
      });
      const branch = await registry.createBranch({
        auth: baseAuth,
        interactionId,
        publishTarget: "same-interaction",
      });

      // Someone else advances the interaction while the branch is open.
      await registry.publishArtifactVersion({
        auth: baseAuth,
        artifact: artifactInput({
          actionCatalogVersion: "2026-06-25",
          source: `${cancelAppointmentGeneratedSource}\n// concurrent v2`,
          sourceHash: sourceHash("b"),
          version: "2",
        }),
        expectedActiveVersion: "1",
      });

      await registry.updateDraftSource({
        auth: baseAuth,
        draftId: branch.draft.draftId,
        provenance: {
          sourceHash: sourceHash("c"),
        },
        source,
      });

      await expectRegistryError(
        () =>
          registry.publishBranchDraftArtifactVersion({
            artifact: artifactInput({
              actionCatalogVersion: "2026-06-25",
              id: interactionId,
              source,
              sourceHash: sourceHash("c"),
              version: "3",
            }),
            auth: baseAuth,
            draftId: branch.draft.draftId,
          }),
        "branch_base_changed",
      );
    });
  });

  async function publishActiveArtifact(
    registry: ScopedInteractionRegistry,
    input: {
      auth: RuntimeAuthContext;
      interactionId?: string;
      visibility: PublishedInteractionArtifact["visibility"];
      source: string;
      sourceHash: string;
      artifact?: Partial<PublishedInteractionArtifact>;
    },
  ) {
    await registry.createInteractionRecord({
      auth: input.auth,
      interactionId: input.interactionId ?? interactionId,
      visibility: input.visibility,
    });
    await registry.createArtifactVersion({
      auth: input.auth,
      artifact: artifactInput({
        id: input.interactionId ?? interactionId,
        visibility: input.visibility,
        source: input.source,
        sourceHash: input.sourceHash,
        ...input.artifact,
      }),
    });
    await registry.moveActiveVersion({
      auth: input.auth,
      interactionId: input.interactionId ?? interactionId,
      visibility: input.visibility,
      nextVersion: "1",
    });
  }
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

  void ownerTenantId;
  void ownerOrganizationId;
  void ownerUserId;
  void createdAt;
  void createdBySubjectId;

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

async function expectRegistryError(
  action: () => unknown,
  code: InteractionRegistryError["code"],
) {
  let caught: unknown;

  try {
    await action();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(InteractionRegistryError);
  expect((caught as InteractionRegistryError).code).toBe(code);
}

function sourceHash(hexChar: string) {
  return `sha256:${hexChar.repeat(64)}`;
}
