import { z } from "zod";

export const EffectClassSchema = z.enum([
  "read",
  "write",
  "external",
  "destructive",
]);

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);

export const IdempotencyPolicySchema = z.enum([
  "not_required",
  "recommended",
  "required",
]);

export type EffectClass = z.infer<typeof EffectClassSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type IdempotencyPolicy = z.infer<typeof IdempotencyPolicySchema>;
