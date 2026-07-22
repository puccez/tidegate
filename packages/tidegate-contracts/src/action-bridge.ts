import { z } from "zod";

export const TIDEGATE_ACTION_BRIDGE_SECRET_HEADER =
  "x-tidegate-action-bridge-secret";
export const TIDEGATE_ACTION_AUTH_CONTEXT_HEADER = "x-tidegate-auth-context";
export const TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER = "x-tidegate-allowed-actions";
export const TIDEGATE_ACTION_INTERACTION_ID_HEADER = "x-tidegate-interaction-id";

export const TidegateActionInvokeRequestSchema = z
  .object({
    actionId: z.string().min(1),
    input: z.unknown(),
    invocationId: z.string().min(1).optional(),
  })
  .strict();

export const TidegateActionErrorCodeSchema = z.enum([
  "invalid_request",
  "auth_required",
  "permission_denied",
  "action_not_found",
  "action_not_allowed",
  "action_input_invalid",
  "action_output_invalid",
  "action_failed",
]);

export const TidegateActionInvokeResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    invocationId: z.string().min(1).optional(),
    output: z.unknown(),
  }),
  z.object({
    status: z.enum(["rejected", "failed"]),
    invocationId: z.string().min(1).optional(),
    error: z.object({
      code: TidegateActionErrorCodeSchema,
      message: z.string().min(1),
    }),
  }),
]);

export type TidegateActionEffect = "read" | "write" | "external" | "destructive";
export type TidegateActionInvokeRequest = z.infer<
  typeof TidegateActionInvokeRequestSchema
>;
export type TidegateActionErrorCode = z.infer<typeof TidegateActionErrorCodeSchema>;
export type TidegateActionInvokeResponse = z.infer<
  typeof TidegateActionInvokeResponseSchema
>;
