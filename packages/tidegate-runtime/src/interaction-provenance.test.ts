import { describe, expect, test } from "bun:test";
import type { InteractionDraft } from "@tidegate/contracts";
import { cancelAppointmentPublishRequest } from "@tidegate/contracts/fixtures";
import {
  createTestPublishEvidence,
  createValidationPublishEvidence,
  draftProvenanceFromPublishedProvenance,
  hashInteractionAuthoringPublishRequest,
  hashInteractionAuthoringTest,
  mergeDraftProvenance,
  publishGateDiagnostics,
  publishedProvenanceFromDraft,
  publishedProvenanceFromEvidence,
  withDraftPublishedProvenance,
  withPublishedArtifactProvenance,
} from "./index.ts";
import { InteractionRegistryError } from "./interaction-registry-errors.ts";

const actionCatalogMetadata = {
  id: "booking-actions",
  version: "2026-06-25",
};

const publishRequest = {
  ...structuredClone(cancelAppointmentPublishRequest),
  requestedInteractionId: "ix.booking.publishEvidence",
};
const sourceHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const testSource = "test('ok', () => expect(true).toBe(true));";

describe("interaction provenance", () => {
  test("creates validation and passing-test evidence with stable hashes", () => {
    const validation = createValidationPublishEvidence({
      now: () => new Date("2026-06-30T00:00:00.000Z"),
      publishRequest,
      sourceHash,
    });
    expect(validation).toEqual({
      sourceHash,
      publishRequestHash: hashInteractionAuthoringPublishRequest(publishRequest),
      validationResultAt: "2026-06-30T00:00:00.000Z",
    });

    const tests = createTestPublishEvidence({
      publishRequest,
      sourceHash,
      testMetadata: {
        exitCode: 0,
        runner: "vitest",
      },
      testSource,
      validationResultAt: validation.validationResultAt,
      vitestResultAt: "2026-06-30T00:01:00.000Z",
    });
    expect(tests).toEqual({
      sourceHash,
      testHash: hashInteractionAuthoringTest(testSource),
      testSource,
      testMetadata: {
        exitCode: 0,
        runner: "vitest",
      },
      publishRequestHash: hashInteractionAuthoringPublishRequest(publishRequest),
      validationResultAt: "2026-06-30T00:00:00.000Z",
      vitestResultAt: "2026-06-30T00:01:00.000Z",
    });
  });

  test("reports stale and incomplete evidence diagnostics", () => {
    const diagnostics = publishGateDiagnostics({
      actionCatalogMetadata,
      evidence: {
        sourceHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        testMetadata: {
          status: "failed",
        },
      },
      publishRequest,
      requireActionCatalogEvidence: true,
      requirePreview: true,
      sourceHash,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "publish_gate_source_stale" }),
        expect.objectContaining({ code: "publish_gate_tests_missing" }),
        expect.objectContaining({ code: "publish_gate_tests_failed" }),
        expect.objectContaining({ code: "publish_gate_request_hash_missing" }),
        expect.objectContaining({ code: "publish_gate_action_catalog_missing" }),
        expect.objectContaining({ code: "publish_gate_validation_missing" }),
        expect.objectContaining({ code: "publish_gate_preview_missing" }),
      ]),
    );
  });

  test("projects published provenance from evidence and current catalog metadata", () => {
    const evidence = createTestPublishEvidence({
      publishRequest,
      sourceHash,
      testMetadata: {
        status: "passed",
      },
      testSource,
      validationResultAt: "2026-06-30T00:00:00.000Z",
      vitestResultAt: "2026-06-30T00:01:00.000Z",
    });

    expect(
      publishedProvenanceFromEvidence({
        actionCatalogMetadata,
        evidence,
        sourceHash,
      }),
    ).toEqual({
      sourceHash,
      testHash: hashInteractionAuthoringTest(testSource),
      publishRequestHash: hashInteractionAuthoringPublishRequest(publishRequest),
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      validationResultAt: "2026-06-30T00:00:00.000Z",
      vitestResultAt: "2026-06-30T00:01:00.000Z",
    });
  });

  test("merges draft provenance patches and omits undefined-only results", () => {
    expect(mergeDraftProvenance(undefined, {})).toBeUndefined();
    expect(
      mergeDraftProvenance(
        {
          sourceHash,
          testHash: "sha256:test",
        },
        {
          testHash: undefined,
          validationResultAt: "2026-06-30T00:00:00.000Z",
        },
      ),
    ).toEqual({
      sourceHash,
      validationResultAt: "2026-06-30T00:00:00.000Z",
    });
  });

  test("round-trips published provenance into branch draft snapshots", () => {
    const published = withPublishedArtifactProvenance({
      sourceHash,
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
    }).provenance;
    const draft = draftWithProvenance(
      draftProvenanceFromPublishedProvenance({
        ...published,
        testHash: "sha256:test",
        publishRequestHash: "sha256:request",
        validationResultAt: "2026-06-30T00:00:00.000Z",
      }),
    );

    expect(publishedProvenanceFromDraft(published, draft)).toEqual({
      sourceHash,
      testHash: "sha256:test",
      publishRequestHash: "sha256:request",
      actionCatalogId: "booking-actions",
      actionCatalogVersion: "2026-06-25",
      validationResultAt: "2026-06-30T00:00:00.000Z",
    });
  });

  test("rejects explicit published evidence that was not recorded on the draft", () => {
    expect(() =>
      withDraftPublishedProvenance(
        {
          sourceHash,
          actionCatalogId: "booking-actions",
          actionCatalogVersion: "2026-06-25",
          provenance: {
            sourceHash,
            testHash: "sha256:invented",
            actionCatalogId: "booking-actions",
            actionCatalogVersion: "2026-06-25",
          },
        },
        draftWithProvenance(undefined),
      ),
    ).toThrow(InteractionRegistryError);
  });
});

function draftWithProvenance(
  provenance: InteractionDraft["provenance"],
): InteractionDraft {
  return {
    draftId: "draft_provenance",
    interactionId: "ix.booking.publishEvidence",
    branchId: "branch_provenance",
    ownerUserId: "user_author",
    actionCatalogId: "booking-actions",
    actionCatalogVersion: "2026-06-25",
    source: "export default {}",
    provenance,
    status: "draft",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}
