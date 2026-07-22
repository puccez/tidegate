import { z } from "zod";

export const JsonSchemaSchema = z.record(z.string(), z.unknown());

export type JsonSchema = z.infer<typeof JsonSchemaSchema>;
