import { z } from "zod";

export const JsonRenderStateRefSchema = z.object({
  $state: z.string().min(1),
});

export const JsonRenderActionParamValueSchema = z.union([
  JsonRenderStateRefSchema,
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const JsonRenderActionBindingSchema = z.object({
  action: z.string().min(1),
  params: z
    .record(z.string(), JsonRenderActionParamValueSchema)
    .default({}),
});

export const JsonRenderPressEventSchema = z.object({
  press: JsonRenderActionBindingSchema,
});

export type JsonRenderStateRef = z.infer<typeof JsonRenderStateRefSchema>;
export type JsonRenderActionBinding = z.infer<
  typeof JsonRenderActionBindingSchema
>;
export type JsonRenderPressEvent = z.infer<typeof JsonRenderPressEventSchema>;
