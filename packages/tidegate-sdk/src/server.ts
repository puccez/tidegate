import {
  interactionPublicRoutePaths,
  InvokeInteractionRequestSchema,
  InvokeInteractionResponseSchema,
  type InvokeInteractionRequest,
  type InvokeInteractionResponse,
} from "@tidegate/contracts";
export {
  TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER,
  TIDEGATE_ACTION_AUTH_CONTEXT_HEADER,
  TIDEGATE_ACTION_INTERACTION_ID_HEADER,
  TIDEGATE_ACTION_BRIDGE_SECRET_HEADER,
  TidegateActionCatalogError,
  TidegateActionErrorCodeSchema,
  TidegateActionHandlerError,
  TidegateActionInvokeRequestSchema,
  TidegateActionInvokeResponseSchema,
  createTidegateActionCatalogManifest,
  createTidegateActionHandler,
  defineTidegateActions,
  tidegateAction,
  verifyTidegateActionRequest,
  type AnyTidegateActionDefinition,
  type CreateTidegateActionCatalogManifestOptions,
  type CreateTidegateActionHandlerOptions,
  type TidegateActionCatalog,
  type TidegateActionCatalogNode,
  type TidegateActionBuilderDefinition,
  type TidegateActionBuilderWithReturnsDefinition,
  type TidegateActionDefinition,
  type TidegateActionEffect,
  type TidegateActionErrorCode,
  type TidegateActionExecuteContext,
  type TidegateActionExecuteArgs,
  type TidegateActionLegacyShorthandDefinition,
  type TidegateActionNormalizedDefinition,
  type TidegateActionShorthandDefinition,
  type TidegateActionShorthandWithReturnsDefinition,
  type TidegateActionInvokeRequest,
  type TidegateActionInvokeResponse,
  type TidegateActionRequestVerifier,
  type TidegateVerifiedActionRequest,
} from "./action-bridge.ts";

export const DEFAULT_TIDEGATE_API_BASE_URL = "https://api.tidegate.ai/v1";

export type TidegateFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export type TidegateServerClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: TidegateFetch;
};

export type TidegateInteractionsClient = {
  invoke: (
    interactionId: string,
    request: InvokeInteractionRequest,
  ) => Promise<InvokeInteractionResponse>;
};

export type TidegateServerClient = {
  interactions: TidegateInteractionsClient;
};

export class TidegateSdkError extends Error {
  override name = "TidegateSdkError";
  readonly details?: unknown;

  constructor(
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.details = details;
  }
}

export function createTidegateServerClient({
  apiKey = process.env.TIDEGATE_API_KEY,
  baseUrl = DEFAULT_TIDEGATE_API_BASE_URL,
  fetchImpl = globalThis.fetch,
}: TidegateServerClientOptions = {}): TidegateServerClient {
  if (!apiKey) {
    throw new TidegateSdkError(
      "Missing TIDEGATE_API_KEY. Create an API key in the Tidegate dashboard and add it to your server environment.",
    );
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  return {
    interactions: {
      async invoke(interactionId, request) {
        const invokeRequest = InvokeInteractionRequestSchema.parse(request);
        const response = await fetchImpl(
          urlForInteractionInvoke(normalizedBaseUrl, interactionId),
          {
            method: "POST",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(invokeRequest),
          },
        );

        let body: unknown;

        try {
          body = await response.json();
        } catch (error) {
          throw new TidegateSdkError(
            `Tidegate returned HTTP ${response.status} without a valid JSON body.`,
            error,
          );
        }

        const parsed = InvokeInteractionResponseSchema.safeParse(body);

        if (!parsed.success) {
          throw new TidegateSdkError(
            `Tidegate returned HTTP ${response.status} with an invalid interaction response.`,
            parsed.error,
          );
        }

        return parsed.data;
      },
    },
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");

  if (normalized.length === 0) {
    throw new TidegateSdkError("Tidegate baseUrl cannot be empty.");
  }

  return normalized;
}

function urlForInteractionInvoke(baseUrl: string, interactionId: string): string {
  return `${baseUrl}/${interactionPublicRoutePaths.invokeInteraction({
    interactionId,
  })}`;
}
