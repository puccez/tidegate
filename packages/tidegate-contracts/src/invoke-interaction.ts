import { z } from "zod";

export const InvokeInteractionErrorCodeSchema = z.enum([
  "interaction_not_found",
  "interaction_version_mismatch",
  "interaction_unavailable",
  "interaction_revoked",
  "budget_exhausted",
  "invalid_request",
  "auth_required",
  "tenant_mismatch",
  "permission_denied",
  "idempotency_key_required",
  "confirmation_required",
  "confirmation_invalid",
  "confirmation_expired",
  "confirmation_input_mismatch",
  "input_schema_invalid",
  "output_schema_invalid",
  "action_not_allowed",
  "action_not_registered",
  "action_input_invalid",
  "action_output_invalid",
  "interaction_timeout",
  "interaction_failed",
]);

export const InvokeInteractionErrorSchema = z.object({
  code: InvokeInteractionErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean().optional(),
});

export const InvokeInteractionRequestSchema = z
  .object({
    invocationId: z.string().min(1).optional(),
    interactionVersion: z.string().min(1),
    input: z.unknown(),
    surfaceId: z.string().min(1),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    idempotencyKey: z.string().min(1).optional(),
    confirmationToken: z.string().min(1).optional(),
  })
  .strict();

export const InvokeInteractionSuccessResponseSchema = z.object({
  status: z.literal("ok"),
  invocationId: z.string().min(1),
  auditId: z.string().min(1).optional(),
  output: z.unknown(),
});

export const InvokeInteractionConfirmationRequiredResponseSchema = z.object({
  status: z.literal("confirmation_required"),
  invocationId: z.string().min(1),
  auditId: z.string().min(1).optional(),
  confirmation: z
    .object({
      message: z.string().min(1),
      confirmationToken: z.string().min(1),
      inputHash: z.string().min(1),
      inputSummary: z.array(
        z.object({
          path: z.string().min(1),
          value: z.unknown(),
        }),
      ),
      expiresAt: z.string().min(1),
      confirmRoute: z.string().min(1),
    })
    .describe(
      "Round-trip contract: re-POST the identical invoke request body with `confirmationToken` added to execute; the input must be byte-identical to the request that was confirmed and must carry the same idempotencyKey.",
    ),
});

export const InvokeInteractionRejectedResponseSchema = z.object({
  status: z.literal("rejected"),
  invocationId: z.string().min(1),
  auditId: z.string().min(1).optional(),
  error: InvokeInteractionErrorSchema,
});

export const InvokeInteractionFailedResponseSchema = z.object({
  status: z.literal("failed"),
  invocationId: z.string().min(1),
  auditId: z.string().min(1).optional(),
  error: InvokeInteractionErrorSchema,
});

export const InvokeInteractionTimedOutResponseSchema = z.object({
  status: z.literal("timed_out"),
  invocationId: z.string().min(1),
  auditId: z.string().min(1).optional(),
  error: InvokeInteractionErrorSchema.extend({
    code: z.literal("interaction_timeout"),
    retryable: z.boolean().default(true),
  }),
});

export const InvokeInteractionResponseSchema = z.discriminatedUnion("status", [
  InvokeInteractionSuccessResponseSchema,
  InvokeInteractionConfirmationRequiredResponseSchema,
  InvokeInteractionRejectedResponseSchema,
  InvokeInteractionFailedResponseSchema,
  InvokeInteractionTimedOutResponseSchema,
]);

export type InvokeInteractionErrorCode = z.infer<
  typeof InvokeInteractionErrorCodeSchema
>;
export type InvokeInteractionRequest = z.infer<
  typeof InvokeInteractionRequestSchema
>;
export type InvokeInteractionResponse = z.infer<
  typeof InvokeInteractionResponseSchema
>;
