import {
  TidegateActionCatalogManifestV1Schema,
  type TidegateActionCatalogManifestV1,
} from "@tidegate/contracts";
import {
  createTidegateActionBridgeAction,
  type TidegateActionBridgeFetch,
} from "./action-bridge.ts";
import { defineActionsCatalog, type AnyRuntimeAction } from "./action-catalog.ts";
import { createJsonSchemaRuntimeSchema } from "./json-schema-runtime.ts";

export type TidegateRemoteActionCatalogConfig = {
  actionCatalogUrl: string | URL;
  actionEndpointUrl: string | URL;
  actionBridgeSecret: string;
};

export type FetchTidegateActionCatalogManifestOptions = {
  actionCatalogUrl: string | URL;
  fetchImpl?: TidegateActionBridgeFetch;
  signal?: AbortSignal;
};

export type CreateTidegateRemoteActionCatalogOptions = {
  manifest: TidegateActionCatalogManifestV1;
  actionEndpointUrl: string | URL;
  actionBridgeSecret: string;
  fetchImpl?: TidegateActionBridgeFetch;
};

export type CreateTidegateRemoteActionCatalogFromUrlOptions =
  TidegateRemoteActionCatalogConfig & {
    fetchImpl?: TidegateActionBridgeFetch;
    signal?: AbortSignal;
  };

export class TidegateRemoteActionCatalogError extends Error {
  override name = "TidegateRemoteActionCatalogError";
  readonly code:
    | "invalid_config"
    | "catalog_fetch_failed"
    | "catalog_response_invalid";
  readonly details?: unknown;

  constructor(
    code:
      | "invalid_config"
      | "catalog_fetch_failed"
      | "catalog_response_invalid",
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export async function fetchTidegateActionCatalogManifest({
  actionCatalogUrl,
  fetchImpl = globalThis.fetch,
  signal,
}: FetchTidegateActionCatalogManifestOptions): Promise<TidegateActionCatalogManifestV1> {
  const response = await fetchImpl(normalizeTrustedUrl(actionCatalogUrl), {
    method: "GET",
    headers: {
      accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new TidegateRemoteActionCatalogError(
      "catalog_fetch_failed",
      `Tidegate action catalog fetch failed with HTTP ${response.status}.`,
    );
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    throw new TidegateRemoteActionCatalogError(
      "catalog_response_invalid",
      "Tidegate action catalog response must be valid JSON.",
      error,
    );
  }

  return TidegateActionCatalogManifestV1Schema.parse(body);
}

export function createTidegateRemoteActionCatalog({
  actionBridgeSecret,
  actionEndpointUrl,
  fetchImpl = globalThis.fetch,
  manifest,
}: CreateTidegateRemoteActionCatalogOptions): Map<string, AnyRuntimeAction> {
  const parsedManifest = TidegateActionCatalogManifestV1Schema.parse(manifest);
  const normalizedEndpoint = normalizeTrustedUrl(actionEndpointUrl);
  const normalizedSecret = normalizeBridgeSecret(actionBridgeSecret);
  const actions = defineActionsCatalog(
    Object.fromEntries(
      Object.entries(parsedManifest.actions).map(([actionId, action]) => [
        actionId,
        createTidegateActionBridgeAction({
          id: actionId,
          description: action.description,
          inputSchema: createJsonSchemaRuntimeSchema(action.input),
          outputSchema: createJsonSchemaRuntimeSchema(action.output),
          effects: action.effects,
          requiredPermissions: action.requiredPermissions,
          tenantScope: action.tenantScope,
          audit: action.audit,
          endpoint: normalizedEndpoint,
          actionBridgeSecret: normalizedSecret,
          fetchImpl,
        }),
      ]),
    ),
  );

  return new Map(Object.entries(actions));
}

export async function createTidegateRemoteActionCatalogFromUrl({
  actionBridgeSecret,
  actionCatalogUrl,
  actionEndpointUrl,
  fetchImpl = globalThis.fetch,
  signal,
}: CreateTidegateRemoteActionCatalogFromUrlOptions): Promise<
  Map<string, AnyRuntimeAction>
> {
  const manifest = await fetchTidegateActionCatalogManifest({
    actionCatalogUrl,
    fetchImpl,
    signal,
  });

  return createTidegateRemoteActionCatalog({
    actionBridgeSecret,
    actionEndpointUrl,
    fetchImpl,
    manifest,
  });
}

function normalizeTrustedUrl(url: string | URL): string {
  const normalized = String(url).trim();

  if (normalized.length === 0) {
    throw new TidegateRemoteActionCatalogError(
      "invalid_config",
      "Tidegate remote action URLs cannot be empty.",
    );
  }

  return normalized;
}

function normalizeBridgeSecret(actionBridgeSecret: string): string {
  const normalized = actionBridgeSecret.trim();

  if (normalized.length === 0) {
    throw new TidegateRemoteActionCatalogError(
      "invalid_config",
      "Tidegate action bridge secret must come from trusted server configuration.",
    );
  }

  return normalized;
}
