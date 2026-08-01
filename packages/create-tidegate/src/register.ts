import type { DoctorFetch } from "./doctor.ts";

/**
 * Registrazione self-service dell'action backend presso Tidegate:
 * PUT {apiBaseUrl}/action-backend con la ORG API key. L'integratore ha già
 * in mano catalog URL, actions URL e bridge secret (gli stessi flag del
 * doctor), quindi può auto-registrarsi con una chiamata — come si registra
 * un webhook. Il secret viaggia solo in richiesta: la risposta di Tidegate
 * non lo riespone mai.
 */
export type RegisterActionBackendConfig = {
  apiBaseUrl: string;
  token: string;
  catalogUrl: string;
  actionsUrl: string;
  /** Omesso: Tidegate mantiene il secret già registrato (solo update URL). */
  bridgeSecret?: string;
};

export type RegisterActionBackendReport = {
  ok: boolean;
  url: string;
  status?: number;
  registration?: Record<string, unknown>;
  error?: { code: string; message: string };
};

export async function registerTidegateActionBackend(
  {
    actionsUrl,
    apiBaseUrl,
    bridgeSecret,
    catalogUrl,
    token,
  }: RegisterActionBackendConfig,
  { fetchImpl = globalThis.fetch as DoctorFetch }: { fetchImpl?: DoctorFetch } = {},
): Promise<RegisterActionBackendReport> {
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/action-backend`;

  let response: Response;

  try {
    response = await fetchImpl(url, {
      method: "PUT",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actionCatalogUrl: catalogUrl,
        actionEndpointUrl: actionsUrl,
        ...(bridgeSecret === undefined ? {} : { actionBridgeSecret: bridgeSecret }),
      }),
    });
  } catch (error) {
    return {
      ok: false,
      url,
      error: {
        code: "request_failed",
        message: `PUT ${url} failed: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      },
    };
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const error =
      isRecord(body) && isRecord(body.error) ? body.error : undefined;

    return {
      ok: false,
      url,
      status: response.status,
      error: {
        code: error === undefined ? "http_error" : String(error.code),
        message:
          error === undefined
            ? `PUT ${url} returned HTTP ${response.status}.`
            : String(error.message),
      },
    };
  }

  return {
    ok: true,
    url,
    status: response.status,
    registration:
      isRecord(body) && isRecord(body.registration) ? body.registration : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
