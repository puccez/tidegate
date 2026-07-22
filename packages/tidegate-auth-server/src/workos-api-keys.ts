import { z } from "zod";

export const WorkOsApiKeyOwnerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("organization"),
    id: z.string().min(1),
  }),
  z.object({
    type: z.literal("user"),
    id: z.string().min(1),
    organization_id: z.string().min(1),
  }),
]);

export const WorkOsApiKeySchema = z.object({
  object: z.literal("api_key"),
  id: z.string().min(1),
  owner: WorkOsApiKeyOwnerSchema,
  name: z.string().min(1).optional(),
  obfuscated_value: z.string().min(1).optional(),
  last_used_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  permissions: z.array(z.string().min(1)).default([]),
  created_at: z.string().min(1).optional(),
  updated_at: z.string().min(1).optional(),
});

const WorkOsValidateApiKeyResponseSchema = z.object({
  api_key: WorkOsApiKeySchema.nullish(),
});

const DEFAULT_WORKOS_API_KEY_TIMEOUT_MS = 5_000;

export type WorkOsApiKey = z.infer<typeof WorkOsApiKeySchema>;
export type WorkOsApiKeyValidator = (value: string) => Promise<WorkOsApiKey | null>;

export function createWorkOsApiKeyValidator({
  apiKey = process.env.WORKOS_API_KEY,
  baseUrl = "https://api.workos.com",
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_WORKOS_API_KEY_TIMEOUT_MS,
}: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): WorkOsApiKeyValidator {
  return async (value) => {
    if (!apiKey) {
      throw new Error("WORKOS_API_KEY is required to validate WorkOS API keys.");
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
    let response: Response;

    try {
      response = await fetchImpl(`${baseUrl}/api_keys/validations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value }),
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new Error(
          `WorkOS API key validation timed out after ${timeoutMs}ms.`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`WorkOS API key validation failed with HTTP ${response.status}.`);
    }

    const parsed = WorkOsValidateApiKeyResponseSchema.parse(await response.json());
    return parsed.api_key ?? null;
  };
}
