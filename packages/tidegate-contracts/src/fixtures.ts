import {
  type GeneratedInteractionContractV1,
  GeneratedInteractionContractV1Schema,
} from "./generated-interaction-contract.ts";
import { toInteractionManifest } from "./interaction-manifest.ts";
import { publicInteractionInvokeRoute } from "./interaction-public-routes.ts";
import {
  type InteractionBranch,
  InteractionBranchSchema,
  type InteractionDraft,
  InteractionDraftSchema,
  type InteractionRecord,
  InteractionRecordSchema,
  type PublicInteractionDiscoveryDetailResponse,
  PublicInteractionDiscoveryDetailResponseSchema,
  type PublicInteractionDiscoveryListResponse,
  PublicInteractionDiscoveryListResponseSchema,
  type PublishInteractionRequest,
  PublishInteractionRequestSchema,
  type PublishInteractionResponse,
  PublishInteractionResponseSchema,
  type PublishedInteractionArtifact,
  PublishedInteractionArtifactSchema,
  toPublicInteractionDiscoveryItem,
} from "./published-interaction.ts";

export const cancelAppointmentGeneratedSource = `
export default async function run(input, ctx) {
  const result = await ctx.capabilities.booking.cancel({
    appointmentId: input.appointmentId,
    reason: input.reason ?? "Requested by user",
  });

  return {
    ok: result.ok,
    appointmentId: result.appointmentId,
  };
}
`.trim();

export const cancelAppointmentSourceHash =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export const cancelAppointmentContract: GeneratedInteractionContractV1 =
  GeneratedInteractionContractV1Schema.parse({
    schemaVersion: "tidegate.generatedInteraction.v1",
    id: "ix.booking.cancelAppointment",
    version: "1",
    title: "Cancel appointment",
    description: "Cancel an appointment for the current salon.",
    source: {
      generatedBy: "developer-fixture",
      createdAt: "2026-06-21T00:00:00.000Z",
    },
    input: {
      schema: {
        type: "object",
        required: ["appointmentId"],
        properties: {
          appointmentId: { type: "string" },
          reason: { type: "string" },
        },
        additionalProperties: false,
      },
      examples: [
        {
          appointmentId: "apt_123",
          reason: "Client requested cancellation",
        },
      ],
    },
    output: {
      schema: {
        type: "object",
        required: ["ok", "appointmentId"],
        properties: {
          ok: { type: "boolean" },
          appointmentId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    allowedActions: [
      {
        id: "booking.cancel",
        reason: "The interaction cancels one selected appointment.",
        maxCalls: 1,
      },
    ],
    effects: {
      declared: "write",
      riskLevel: "medium",
      idempotency: "required",
    },
    timeout: {
      executionMs: 5000,
      perActionMs: 3000,
      maxActionCalls: 1,
    },
    confirmation: {
      required: false,
      message: null,
    },
    audit: {
      required: true,
      redactPaths: [],
    },
    visibility: {
      scope: "session",
      revocable: true,
    },
  });

export const cancelAppointmentManifest = toInteractionManifest(
  cancelAppointmentContract,
);

export const cancelAppointmentPublishRequest: PublishInteractionRequest =
  PublishInteractionRequestSchema.parse({
    requestedInteractionId: "ix.booking.cancelAppointment",
    title: "Cancel appointment",
    description: "Cancel an appointment for the current salon.",
    source: cancelAppointmentGeneratedSource,
    visibility: "user",
    input: cancelAppointmentContract.input.schema,
    output: {
      type: "object",
      required: ["ok", "appointmentId"],
      properties: {
        ok: { type: "boolean" },
        appointmentId: { type: "string" },
        alreadyCancelled: { type: "boolean" },
      },
      additionalProperties: false,
    },
    requestedAllowedActions: [
      {
        id: "booking.cancel",
        maxCalls: 1,
        timeoutMs: 3000,
      },
    ],
    effects: cancelAppointmentContract.effects,
    timeout: cancelAppointmentContract.timeout,
    confirmation: cancelAppointmentContract.confirmation,
    audit: {
      required: true,
      redactPaths: ["/input/reason", "/output/internalNote"],
    },
  });

export const cancelAppointmentPublishedArtifact: PublishedInteractionArtifact =
  PublishedInteractionArtifactSchema.parse({
    id: "ix.booking.cancelAppointment",
    version: "1",
    ownerTenantId: "tenant_123",
    ownerOrganizationId: "org_123",
    ownerUserId: "user_123",
    visibility: "user",
    status: "active",
    sourceHash: cancelAppointmentSourceHash,
    source: cancelAppointmentGeneratedSource,
    publishedFromBranchId: "branch_cancel_appointment_v1",
    actionCatalogId: "booking-actions",
    actionCatalogVersion: "2026-06-21",
    allowedActions: [
      {
        id: "booking.cancel",
        reason: "The interaction cancels one selected appointment.",
        maxCalls: 1,
        timeoutMs: 3000,
      },
    ],
    inputSchema: cancelAppointmentContract.input.schema,
    outputSchema: cancelAppointmentPublishRequest.output,
    effects: cancelAppointmentContract.effects,
    timeout: cancelAppointmentContract.timeout,
    confirmation: cancelAppointmentContract.confirmation,
    audit: {
      required: true,
      redactPaths: ["/input/reason", "/output/internalNote"],
    },
    policy: {
      requiredPermissions: ["appointments:write"],
      tenantScope: { fromAuth: "tenantId" },
    },
    runtime: {
      sandboxId: "sbx_cancel_appointment_runtime",
      actionBridge: {
        endpointUrl: "https://customer.example.test/tidegate/actions",
        secretRef: "bridge-secret-ref:cancel-appointment",
      },
    },
    createdAt: "2026-06-21T00:00:00.000Z",
    createdBySubjectId: "user_123",
  });

export const cancelAppointmentInteractionRecord: InteractionRecord =
  InteractionRecordSchema.parse({
    id: "ix.booking.cancelAppointment",
    ownerTenantId: "tenant_123",
    ownerOrganizationId: "org_123",
    ownerUserId: "user_123",
    visibility: "user",
    activeVersion: "1",
    status: "active",
    title: "Cancel appointment",
    description: "Cancel an appointment for the current salon.",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  });

export const cancelAppointmentInteractionBranch: InteractionBranch =
  InteractionBranchSchema.parse({
    branchId: "branch_cancel_appointment_v1",
    interactionId: "ix.booking.cancelAppointment",
    ownerTenantId: "tenant_123",
    ownerOrganizationId: "org_123",
    ownerUserId: "user_123",
    name: "Initial cancel appointment interaction",
    status: "active",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  });

export const cancelAppointmentInteractionDraft: InteractionDraft =
  InteractionDraftSchema.parse({
    draftId: "draft_cancel_appointment_v1",
    interactionId: "ix.booking.cancelAppointment",
    branchId: cancelAppointmentInteractionBranch.branchId,
    ownerTenantId: "tenant_123",
    ownerOrganizationId: "org_123",
    ownerUserId: "user_123",
    actionCatalogId: "booking-actions",
    actionCatalogVersion: "2026-06-21",
    source: cancelAppointmentGeneratedSource,
    status: "publishable",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  });

export const cancelAppointmentPublishResponse: PublishInteractionResponse =
  PublishInteractionResponseSchema.parse({
    interactionId: "ix.booking.cancelAppointment",
    version: "1",
    sourceHash: cancelAppointmentSourceHash,
    visibility: "user",
    owner: {
      tenantId: "tenant_123",
      organizationId: "org_123",
      userId: "user_123",
    },
    invoke: publicInteractionInvokeRoute({
      interactionId: "ix.booking.cancelAppointment",
    }),
  });

export const cancelAppointmentPublicDiscoveryItem =
  toPublicInteractionDiscoveryItem(
    cancelAppointmentInteractionRecord,
    cancelAppointmentPublishedArtifact,
  );

export const cancelAppointmentPublicDiscoveryListResponse: PublicInteractionDiscoveryListResponse =
  PublicInteractionDiscoveryListResponseSchema.parse({
    interactions: [cancelAppointmentPublicDiscoveryItem],
  });

export const cancelAppointmentPublicDiscoveryDetailResponse: PublicInteractionDiscoveryDetailResponse =
  PublicInteractionDiscoveryDetailResponseSchema.parse({
    interaction: cancelAppointmentPublicDiscoveryItem,
  });
