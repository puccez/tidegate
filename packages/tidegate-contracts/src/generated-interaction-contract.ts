import { z } from "zod";
import {
  EffectClassSchema,
  IdempotencyPolicySchema,
  RiskLevelSchema,
} from "./effects.ts";
import { JsonSchemaSchema } from "./json-schema.ts";

export const GeneratedInteractionContractV1Schema = z.object({
  schemaVersion: z.literal("tidegate.generatedInteraction.v1"),

  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),

  source: z.object({
    generatedBy: z.enum(["eve1", "developer-fixture"]),
    sessionId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    sourceHash: z.string().min(1).optional(),
    createdAt: z.string().min(1),
  }),

  input: z.object({
    schema: JsonSchemaSchema,
    examples: z.array(z.unknown()).optional(),
  }),

  output: z.object({
    schema: JsonSchemaSchema,
    examples: z.array(z.unknown()).optional(),
  }),

  allowedActions: z
    .array(
      z.object({
        id: z.string().min(1),
        reason: z.string().min(1),
        maxCalls: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .min(1),

  effects: z.object({
    declared: EffectClassSchema,
    riskLevel: RiskLevelSchema,
    idempotency: IdempotencyPolicySchema,
  }),

  timeout: z.object({
    executionMs: z.number().int().positive(),
    perActionMs: z.number().int().positive().optional(),
    maxActionCalls: z.number().int().positive(),
    maxLoopIterations: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  }),

  confirmation: z.object({
    required: z.boolean(),
    message: z.string().nullable(),
  }),

  audit: z.object({
    required: z.boolean(),
    redactPaths: z.array(z.string()).default([]),
  }),

  visibility: z.object({
    scope: z.enum(["message", "session", "user", "tenant"]),
    expiresAt: z.string().optional(),
    revocable: z.literal(true),
  }),
});

export type GeneratedInteractionContractV1 = z.infer<
  typeof GeneratedInteractionContractV1Schema
>;
