import { z } from "zod";
import { EffectClassSchema } from "./effects.ts";
import { JsonSchemaSchema } from "./json-schema.ts";

const RESERVED_ACTION_ID_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const TidegateActionIdSchema = z
  .string()
  .min(1)
  .refine(
    (actionId) => actionId.split(".").every((segment) => segment.length > 0),
    {
      message: "Action ids must use non-empty dot-separated segments.",
    },
  )
  .refine(
    (actionId) =>
      actionId
        .split(".")
        .every((segment) => !RESERVED_ACTION_ID_SEGMENTS.has(segment)),
    {
      message:
        "Action ids cannot use reserved JavaScript object segments.",
    },
  );

export const TidegateActionTenantScopeSchema = z
  .object({
    fromAuth: z.enum(["tenantId", "organizationId", "orgId", "salonId"]),
  })
  .strict();

export const TidegateActionAuditPolicySchema = z
  .object({
    required: z.boolean(),
    redactPaths: z.array(z.string().min(1)),
  })
  .strict();

const TidegateActionAuditPolicyInputSchema = z
  .object({
    required: z.boolean().optional(),
    redactPaths: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const TidegateActionManifestV1Schema = z
  .object({
    description: z.string().min(1),
    input: JsonSchemaSchema,
    output: JsonSchemaSchema,
    effects: EffectClassSchema,
    requiredPermissions: z.array(z.string().min(1)).default([]),
    tenantScope: TidegateActionTenantScopeSchema.optional(),
    audit: TidegateActionAuditPolicyInputSchema.optional(),
  })
  .strict()
  .transform((action) => ({
    ...action,
    audit: {
      required: action.audit?.required ?? action.effects !== "read",
      redactPaths: action.audit?.redactPaths ?? [],
    },
  }));

const TidegateActionManifestRecordSchema = z
  .unknown()
  .transform((value, ctx): Record<string, TidegateActionManifestV1> => {
    if (!isRecord(value)) {
      ctx.addIssue({
        code: "custom",
        message: "Action catalog actions must be an object.",
      });

      return {};
    }

    const actions: Record<string, TidegateActionManifestV1> = {};

    for (const [rawActionId, rawAction] of Object.entries(value)) {
      const actionIdResult = TidegateActionIdSchema.safeParse(rawActionId);

      if (!actionIdResult.success) {
        for (const issue of actionIdResult.error.issues) {
          ctx.addIssue({
            ...issue,
            path: [rawActionId, ...issue.path],
          });
        }

        continue;
      }

      const actionResult = TidegateActionManifestV1Schema.safeParse(rawAction);

      if (!actionResult.success) {
        for (const issue of actionResult.error.issues) {
          ctx.addIssue({
            ...issue,
            path: [rawActionId, ...issue.path],
          });
        }

        continue;
      }

      actions[actionIdResult.data] = actionResult.data;
    }

    addNamespaceCollisionIssues(Object.keys(actions), ctx);

    return actions;
  });

export const TidegateActionCatalogManifestV1Schema = z
  .object({
    schemaVersion: z.literal("tidegate.actionCatalog.v1"),
    catalogId: z.string().min(1),
    version: z.string().min(1),
    actions: TidegateActionManifestRecordSchema,
  })
  .strict();

export type TidegateActionId = z.infer<typeof TidegateActionIdSchema>;
export type TidegateActionTenantScope = z.infer<
  typeof TidegateActionTenantScopeSchema
>;
export type TidegateActionAuditPolicy = z.infer<
  typeof TidegateActionAuditPolicySchema
>;
export type TidegateActionManifestV1 = z.infer<typeof TidegateActionManifestV1Schema>;
export type TidegateActionCatalogManifestV1 = z.infer<
  typeof TidegateActionCatalogManifestV1Schema
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addNamespaceCollisionIssues(
  actionIds: string[],
  ctx: z.RefinementCtx,
) {
  const knownActionIds = new Set(actionIds);

  for (const actionId of actionIds) {
    const segments = actionId.split(".");
    let prefix = "";

    for (const segment of segments.slice(0, -1)) {
      prefix = prefix.length === 0 ? segment : `${prefix}.${segment}`;

      if (knownActionIds.has(prefix)) {
        ctx.addIssue({
          code: "custom",
          message: `Action id "${actionId}" conflicts with "${prefix}".`,
          path: [actionId],
        });
      }
    }
  }
}
