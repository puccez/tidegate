import { z } from "zod";
import { EffectClassSchema, RiskLevelSchema } from "./effects.ts";
import {
  type GeneratedInteractionContractV1,
  GeneratedInteractionContractV1Schema,
} from "./generated-interaction-contract.ts";
import { legacyPublicInteractionInvokeRoute } from "./interaction-public-routes.ts";
import { JsonSchemaSchema } from "./json-schema.ts";

export const InteractionManifestV1Schema = z.object({
  schemaVersion: z.literal("tidegate.interactionManifest.v1"),
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  inputSchema: JsonSchemaSchema,
  outputSchema: JsonSchemaSchema,
  effects: EffectClassSchema,
  riskLevel: RiskLevelSchema,
  timeoutMs: z.number().int().positive(),
  confirmation: z.object({
    required: z.boolean(),
    message: z.string().nullable(),
  }),
  invoke: z.object({
    method: z.literal("POST"),
    path: z.string().min(1),
  }),
});

export type InteractionManifestV1 = z.infer<typeof InteractionManifestV1Schema>;

export function toInteractionManifest(
  contract: GeneratedInteractionContractV1,
): InteractionManifestV1 {
  const parsed = GeneratedInteractionContractV1Schema.parse(contract);

  return InteractionManifestV1Schema.parse({
    schemaVersion: "tidegate.interactionManifest.v1",
    id: parsed.id,
    version: parsed.version,
    title: parsed.title,
    description: parsed.description,
    inputSchema: parsed.input.schema,
    outputSchema: parsed.output.schema,
    effects: parsed.effects.declared,
    riskLevel: parsed.effects.riskLevel,
    timeoutMs: parsed.timeout.executionMs,
    confirmation: parsed.confirmation,
    invoke: legacyPublicInteractionInvokeRoute({ interactionId: parsed.id }),
  });
}
