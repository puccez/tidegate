import { z } from "zod";
import {
  TidegateActionIdSchema,
  TidegateActionTenantScopeSchema,
} from "./action-catalog-manifest.ts";
import {
  EffectClassSchema,
  IdempotencyPolicySchema,
  RiskLevelSchema,
} from "./effects.ts";
import { publicInteractionInvokeRoute } from "./interaction-public-routes.ts";
import { JsonSchemaSchema } from "./json-schema.ts";

const NonEmptyStringSchema = z.string().min(1);
const IsoTimestampSchema = z.string().datetime({ offset: true });

export const InteractionSnapshotHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/i, {
    message: "Interaction snapshot hashes must be sha256-prefixed hex digests.",
  });

export const InteractionSourceHashSchema = InteractionSnapshotHashSchema;

export const InteractionVisibilitySchema = z.enum([
  "user",
  "tenant",
  "organization",
  "app",
]);

export const InteractionAvailabilityStatusSchema = z.enum([
  "active",
  "archived",
  "revoked",
]);

export const InteractionDraftStatusSchema = z.enum([
  "draft",
  "validating",
  "publishable",
  "discarded",
]);

export const InteractionBranchStatusSchema = z.enum([
  "active",
  "merged",
  "discarded",
]);

export const InteractionBranchPublishTargetSchema = z.enum([
  "same-interaction",
  "new-interaction",
]);

export const InteractionOwnerSchema = z
  .object({
    tenantId: NonEmptyStringSchema.optional(),
    organizationId: NonEmptyStringSchema.optional(),
    userId: NonEmptyStringSchema.optional(),
  })
  .strict();

export const InteractionEffectsSchema = z
  .object({
    declared: EffectClassSchema,
    riskLevel: RiskLevelSchema,
    idempotency: IdempotencyPolicySchema,
  })
  .strict();

export const InteractionTimeoutSchema = z
  .object({
    executionMs: z.number().int().positive(),
    perActionMs: z.number().int().positive().optional(),
    maxActionCalls: z.number().int().positive(),
    maxLoopIterations: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  })
  .strict();

export const InteractionConfirmationSchema = z
  .object({
    required: z.boolean(),
    message: z.string().min(1).nullable(),
  })
  .strict();

export const InteractionAuditPolicySchema = z
  .object({
    required: z.boolean(),
    redactPaths: z.array(z.string().min(1)),
  })
  .strict();

export const PublishedInteractionAllowedActionSchema = z
  .object({
    id: TidegateActionIdSchema,
    reason: NonEmptyStringSchema.optional(),
    maxCalls: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const PublishInteractionRequestedActionSchema = z
  .object({
    id: TidegateActionIdSchema,
    maxCalls: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const InteractionPolicySnapshotSchema = z
  .object({
    requiredPermissions: z.array(NonEmptyStringSchema),
    tenantScope: TidegateActionTenantScopeSchema.optional(),
  })
  .strict();

export const PublishedInteractionRuntimeSnapshotSchema = z
  .object({
    sandboxId: NonEmptyStringSchema.optional(),
    actionBridge: z
      .object({
        endpointUrl: z.string().url(),
        secretRef: NonEmptyStringSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const InteractionDraftTestMetadataSchema = z.record(
  z.string(),
  z.unknown(),
);

export const InteractionDraftProvenanceSchema = z
  .object({
    sourceHash: InteractionSnapshotHashSchema.optional(),
    testHash: InteractionSnapshotHashSchema.optional(),
    testSource: NonEmptyStringSchema.optional(),
    testMetadata: InteractionDraftTestMetadataSchema.optional(),
    publishRequestHash: InteractionSnapshotHashSchema.optional(),
    validationResultAt: IsoTimestampSchema.optional(),
    vitestResultAt: IsoTimestampSchema.optional(),
    previewResultAt: IsoTimestampSchema.optional(),
  })
  .strict();

export const PublishInteractionProvenanceEvidenceSchema =
  InteractionDraftProvenanceSchema.extend({
    actionCatalogId: NonEmptyStringSchema.optional(),
    actionCatalogVersion: NonEmptyStringSchema.optional(),
  }).strict();

export const PublishedInteractionProvenanceSchema = z
  .object({
    sourceHash: InteractionSnapshotHashSchema,
    testHash: InteractionSnapshotHashSchema.optional(),
    publishRequestHash: InteractionSnapshotHashSchema.optional(),
    actionCatalogId: NonEmptyStringSchema,
    actionCatalogVersion: NonEmptyStringSchema,
    validationResultAt: IsoTimestampSchema.optional(),
    vitestResultAt: IsoTimestampSchema.optional(),
    previewResultAt: IsoTimestampSchema.optional(),
  })
  .strict();

const InteractionOwnerFieldsSchema = {
  ownerTenantId: NonEmptyStringSchema.optional(),
  ownerOrganizationId: NonEmptyStringSchema.optional(),
  ownerUserId: NonEmptyStringSchema.optional(),
};

export const PublishInteractionRequestSchema = z
  .object({
    requestedInteractionId: NonEmptyStringSchema,
    title: NonEmptyStringSchema.optional(),
    description: NonEmptyStringSchema.optional(),
    source: NonEmptyStringSchema,
    visibility: InteractionVisibilitySchema,
    input: JsonSchemaSchema,
    output: JsonSchemaSchema,
    requestedAllowedActions: z.array(PublishInteractionRequestedActionSchema).min(1),
    effects: InteractionEffectsSchema,
    timeout: InteractionTimeoutSchema.optional(),
    confirmation: InteractionConfirmationSchema.optional(),
    audit: InteractionAuditPolicySchema.optional(),
    requireGreenTests: z.boolean().optional(),
    provenance: PublishInteractionProvenanceEvidenceSchema.optional(),
  })
  .strict();

export const InteractionInvokeRouteSchema = z
  .object({
    method: z.literal("POST"),
    path: NonEmptyStringSchema,
  })
  .strict();

export const PublishInteractionResponseSchema = z
  .object({
    interactionId: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    sourceHash: InteractionSourceHashSchema,
    visibility: InteractionVisibilitySchema,
    owner: InteractionOwnerSchema,
    invoke: InteractionInvokeRouteSchema,
  })
  .strict()
  .superRefine(requireResponseOwnerScopeForVisibility);

export const PublishedInteractionArtifactSchema = z
  .object({
    id: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    ...InteractionOwnerFieldsSchema,
    visibility: InteractionVisibilitySchema,
    status: InteractionAvailabilityStatusSchema,
    sourceHash: InteractionSourceHashSchema,
    source: NonEmptyStringSchema,
    parentVersion: NonEmptyStringSchema.optional(),
    publishedFromBranchId: NonEmptyStringSchema.optional(),
    actionCatalogId: NonEmptyStringSchema,
    actionCatalogVersion: NonEmptyStringSchema,
    allowedActions: z.array(PublishedInteractionAllowedActionSchema).min(1),
    inputSchema: JsonSchemaSchema,
    outputSchema: JsonSchemaSchema,
    effects: InteractionEffectsSchema,
    timeout: InteractionTimeoutSchema,
    confirmation: InteractionConfirmationSchema,
    audit: InteractionAuditPolicySchema,
    policy: InteractionPolicySnapshotSchema.optional(),
    runtime: PublishedInteractionRuntimeSnapshotSchema.optional(),
    provenance: PublishedInteractionProvenanceSchema.optional(),
    createdAt: IsoTimestampSchema,
    createdBySubjectId: NonEmptyStringSchema,
  })
  .strict()
  .superRefine(requireOwnerScopeForVisibility)
  .superRefine(requirePublishedArtifactProvenanceMatchesArtifact);

export const InteractionRecordSchema = z
  .object({
    id: NonEmptyStringSchema,
    ...InteractionOwnerFieldsSchema,
    visibility: InteractionVisibilitySchema,
    activeVersion: NonEmptyStringSchema.optional(),
    status: InteractionAvailabilityStatusSchema,
    title: NonEmptyStringSchema.optional(),
    description: NonEmptyStringSchema.optional(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine(requireOwnerScopeForVisibility);

export const InteractionDraftSchema = z
  .object({
    draftId: NonEmptyStringSchema,
    interactionId: NonEmptyStringSchema.optional(),
    branchId: NonEmptyStringSchema,
    ...InteractionOwnerFieldsSchema,
    baseVersion: NonEmptyStringSchema.optional(),
    baseSourceHash: InteractionSourceHashSchema.optional(),
    actionCatalogId: NonEmptyStringSchema,
    actionCatalogVersion: NonEmptyStringSchema,
    source: NonEmptyStringSchema,
    provenance: InteractionDraftProvenanceSchema.optional(),
    status: InteractionDraftStatusSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine(requireAtLeastOneOwnerScope);

export const InteractionBranchSchema = z
  .object({
    branchId: NonEmptyStringSchema,
    interactionId: NonEmptyStringSchema.optional(),
    parentBranchId: NonEmptyStringSchema.optional(),
    parentVersion: NonEmptyStringSchema.optional(),
    baseVersion: NonEmptyStringSchema.optional(),
    ...InteractionOwnerFieldsSchema,
    baseSourceHash: InteractionSourceHashSchema.optional(),
    publishTarget: InteractionBranchPublishTargetSchema.optional(),
    targetInteractionId: NonEmptyStringSchema.optional(),
    name: NonEmptyStringSchema.optional(),
    status: InteractionBranchStatusSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine(requireAtLeastOneOwnerScope);

export const PublicInteractionDiscoveryEffectSchema = z
  .object({
    declared: EffectClassSchema,
    riskLevel: RiskLevelSchema,
  })
  .strict();

export const PublicInteractionDiscoveryItemSchema = z
  .object({
    interactionId: NonEmptyStringSchema,
    activeVersion: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    inputSchema: JsonSchemaSchema,
    outputSchema: JsonSchemaSchema,
    effects: PublicInteractionDiscoveryEffectSchema,
    confirmation: InteractionConfirmationSchema,
    invoke: InteractionInvokeRouteSchema,
    visibility: InteractionVisibilitySchema,
    availabilityStatus: InteractionAvailabilityStatusSchema,
  })
  .strict();

export const PublicInteractionDiscoveryListResponseSchema = z
  .object({
    interactions: z.array(PublicInteractionDiscoveryItemSchema),
  })
  .strict();

export const PublicInteractionDiscoveryDetailResponseSchema = z
  .object({
    interaction: PublicInteractionDiscoveryItemSchema,
  })
  .strict();

export type InteractionSourceHash = z.infer<typeof InteractionSourceHashSchema>;
export type InteractionVisibility = z.infer<typeof InteractionVisibilitySchema>;
export type InteractionAvailabilityStatus = z.infer<
  typeof InteractionAvailabilityStatusSchema
>;
export type InteractionDraftStatus = z.infer<typeof InteractionDraftStatusSchema>;
export type InteractionBranchStatus = z.infer<
  typeof InteractionBranchStatusSchema
>;
export type InteractionBranchPublishTarget = z.infer<
  typeof InteractionBranchPublishTargetSchema
>;
export type InteractionOwner = z.infer<typeof InteractionOwnerSchema>;
export type InteractionEffects = z.infer<typeof InteractionEffectsSchema>;
export type InteractionTimeout = z.infer<typeof InteractionTimeoutSchema>;
export type InteractionConfirmation = z.infer<
  typeof InteractionConfirmationSchema
>;
export type InteractionAuditPolicy = z.infer<
  typeof InteractionAuditPolicySchema
>;
export type PublishedInteractionAllowedAction = z.infer<
  typeof PublishedInteractionAllowedActionSchema
>;
export type PublishInteractionRequestedAction = z.infer<
  typeof PublishInteractionRequestedActionSchema
>;
export type InteractionPolicySnapshot = z.infer<
  typeof InteractionPolicySnapshotSchema
>;
export type PublishedInteractionRuntimeSnapshot = z.infer<
  typeof PublishedInteractionRuntimeSnapshotSchema
>;
export type InteractionDraftTestMetadata = z.infer<
  typeof InteractionDraftTestMetadataSchema
>;
export type InteractionDraftProvenance = z.infer<
  typeof InteractionDraftProvenanceSchema
>;
export type PublishInteractionProvenanceEvidence = z.infer<
  typeof PublishInteractionProvenanceEvidenceSchema
>;
export type PublishedInteractionProvenance = z.infer<
  typeof PublishedInteractionProvenanceSchema
>;
export type PublishInteractionRequest = z.infer<
  typeof PublishInteractionRequestSchema
>;
export type InteractionInvokeRoute = z.infer<
  typeof InteractionInvokeRouteSchema
>;
export type PublishInteractionResponse = z.infer<
  typeof PublishInteractionResponseSchema
>;
export type PublishedInteractionArtifact = z.infer<
  typeof PublishedInteractionArtifactSchema
>;
export type InteractionRecord = z.infer<typeof InteractionRecordSchema>;
export type InteractionDraft = z.infer<typeof InteractionDraftSchema>;
export type InteractionBranch = z.infer<typeof InteractionBranchSchema>;
export type PublicInteractionDiscoveryEffect = z.infer<
  typeof PublicInteractionDiscoveryEffectSchema
>;
export type PublicInteractionDiscoveryItem = z.infer<
  typeof PublicInteractionDiscoveryItemSchema
>;
export type PublicInteractionDiscoveryListResponse = z.infer<
  typeof PublicInteractionDiscoveryListResponseSchema
>;
export type PublicInteractionDiscoveryDetailResponse = z.infer<
  typeof PublicInteractionDiscoveryDetailResponseSchema
>;

export function toPublicInteractionDiscoveryItem(
  record: InteractionRecord,
  artifact: PublishedInteractionArtifact,
): PublicInteractionDiscoveryItem {
  const parsedRecord = InteractionRecordSchema.parse(record);
  const parsedArtifact = PublishedInteractionArtifactSchema.parse(artifact);

  if (parsedRecord.id !== parsedArtifact.id) {
    throw new Error("Interaction discovery record and artifact ids must match.");
  }

  if (parsedRecord.activeVersion === undefined) {
    throw new Error("Interaction discovery requires a record active version.");
  }

  if (parsedRecord.activeVersion !== parsedArtifact.version) {
    throw new Error(
      "Interaction discovery artifact must match the record active version.",
    );
  }

  if (parsedRecord.visibility !== parsedArtifact.visibility) {
    throw new Error("Interaction discovery visibility must match the artifact.");
  }

  if (parsedRecord.status !== parsedArtifact.status) {
    throw new Error("Interaction discovery status must match the artifact.");
  }

  for (const ownerField of INTERACTION_OWNER_FIELD_NAMES) {
    if (parsedRecord[ownerField] !== parsedArtifact[ownerField]) {
      throw new Error("Interaction discovery owner scope must match the artifact.");
    }
  }

  if (parsedRecord.title === undefined || parsedRecord.description === undefined) {
    throw new Error("Public interaction discovery requires title and description.");
  }

  return PublicInteractionDiscoveryItemSchema.parse({
    interactionId: parsedRecord.id,
    activeVersion: parsedArtifact.version,
    title: parsedRecord.title,
    description: parsedRecord.description,
    inputSchema: parsedArtifact.inputSchema,
    outputSchema: parsedArtifact.outputSchema,
    effects: {
      declared: parsedArtifact.effects.declared,
      riskLevel: parsedArtifact.effects.riskLevel,
    },
    confirmation: parsedArtifact.confirmation,
    invoke: publicInteractionInvokeRoute({ interactionId: parsedRecord.id }),
    visibility: parsedRecord.visibility,
    availabilityStatus: parsedRecord.status,
  });
}

const INTERACTION_OWNER_FIELD_NAMES = [
  "ownerTenantId",
  "ownerOrganizationId",
  "ownerUserId",
] as const;

function requireOwnerScopeForVisibility(
  value: {
    visibility: InteractionVisibility;
    ownerTenantId?: string;
    ownerOrganizationId?: string;
    ownerUserId?: string;
  },
  ctx: z.RefinementCtx,
) {
  const requiredOwnerFieldByVisibility: Partial<
    Record<InteractionVisibility, keyof typeof InteractionOwnerFieldsSchema>
  > = {
    user: "ownerUserId",
    tenant: "ownerTenantId",
    organization: "ownerOrganizationId",
  };
  const requiredOwnerField = requiredOwnerFieldByVisibility[value.visibility];

  if (requiredOwnerField !== undefined && value[requiredOwnerField] === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `${requiredOwnerField} is required for ${value.visibility} visibility.`,
      path: [requiredOwnerField],
    });
  }
}

function requireResponseOwnerScopeForVisibility(
  value: {
    visibility: InteractionVisibility;
    owner: {
      tenantId?: string;
      organizationId?: string;
      userId?: string;
    };
  },
  ctx: z.RefinementCtx,
) {
  const requiredOwnerFieldByVisibility: Partial<
    Record<InteractionVisibility, keyof typeof value.owner>
  > = {
    user: "userId",
    tenant: "tenantId",
    organization: "organizationId",
  };
  const requiredOwnerField = requiredOwnerFieldByVisibility[value.visibility];

  if (requiredOwnerField !== undefined && value.owner[requiredOwnerField] === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `${requiredOwnerField} is required for ${value.visibility} visibility.`,
      path: ["owner", requiredOwnerField],
    });
  }
}

function requirePublishedArtifactProvenanceMatchesArtifact(
  value: {
    sourceHash: string;
    actionCatalogId: string;
    actionCatalogVersion: string;
    provenance?: {
      sourceHash: string;
      actionCatalogId: string;
      actionCatalogVersion: string;
    };
  },
  ctx: z.RefinementCtx,
) {
  if (value.provenance === undefined) {
    return;
  }

  if (value.provenance.sourceHash !== value.sourceHash) {
    ctx.addIssue({
      code: "custom",
      message: "Published provenance sourceHash must match artifact sourceHash.",
      path: ["provenance", "sourceHash"],
    });
  }

  if (value.provenance.actionCatalogId !== value.actionCatalogId) {
    ctx.addIssue({
      code: "custom",
      message:
        "Published provenance actionCatalogId must match artifact actionCatalogId.",
      path: ["provenance", "actionCatalogId"],
    });
  }

  if (value.provenance.actionCatalogVersion !== value.actionCatalogVersion) {
    ctx.addIssue({
      code: "custom",
      message:
        "Published provenance actionCatalogVersion must match artifact actionCatalogVersion.",
      path: ["provenance", "actionCatalogVersion"],
    });
  }
}

function requireAtLeastOneOwnerScope(
  value: {
    ownerTenantId?: string;
    ownerOrganizationId?: string;
    ownerUserId?: string;
  },
  ctx: z.RefinementCtx,
) {
  if (
    value.ownerTenantId !== undefined ||
    value.ownerOrganizationId !== undefined ||
    value.ownerUserId !== undefined
  ) {
    return;
  }

  ctx.addIssue({
    code: "custom",
    message: "At least one owner scope field is required.",
    path: ["ownerTenantId"],
  });
}
