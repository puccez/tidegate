import type { TidegateAuthContext } from "@tidegate/contracts";
import { extractBearerToken, isJwtShapedCredential } from "./bearer.ts";
import { PublicApiAuthError } from "./errors.ts";
import { hasRequiredScopes } from "./scopes.ts";
import {
  createWorkOsApiKeyValidator,
  type WorkOsApiKey,
  type WorkOsApiKeyValidator,
} from "./workos-api-keys.ts";
import {
  createWorkOsM2mVerifier,
  type WorkOsM2mVerifier,
  type WorkOsM2mVerifyResult,
} from "./workos-m2m.ts";

export type PublicApiCredentialKind =
  | "workos-api-key"
  | "workos-m2m"
  | "local-dev";

export type VerifiedPublicApiCredential = {
  kind: PublicApiCredentialKind;
  subjectId: string;
  organizationId: string;
  scopes: string[];
  permissions: string[];
  auth: TidegateAuthContext;
  audit: {
    credentialId: string;
    ownerType: "organization" | "user" | "m2m-client" | "local-dev";
    ownerId: string;
  };
};

export type VerifyPublicApiRequestOptions = {
  request: Request;
  requiredScopes: string[];
  apiKeyValidator?: WorkOsApiKeyValidator;
  m2mVerifier?: WorkOsM2mVerifier;
  allowLocalDev?: boolean;
  localDevAuth?: TidegateAuthContext;
};

const LOCAL_DEV_BEARER_TOKEN = "local-dev";

export async function verifyPublicApiRequest({
  request,
  requiredScopes,
  apiKeyValidator = createWorkOsApiKeyValidator(),
  // Safe as a per-call default: the underlying remote JWKS is a module
  // singleton keyed by issuer/jwksUrl (D7), so this never re-fetches keys.
  m2mVerifier = createWorkOsM2mVerifier(),
  allowLocalDev = isLocalDevAllowed(request),
  localDevAuth = createLocalDevAuthContext(),
}: VerifyPublicApiRequestOptions): Promise<VerifiedPublicApiCredential> {
  let token: string;

  try {
    token = extractBearerToken(request.headers.get("authorization"));
  } catch (error) {
    if (allowLocalDev && isLoopbackRequest(request)) {
      return verifyLocalDevCredential({ auth: localDevAuth, requiredScopes });
    }

    throw error;
  }

  if (
    allowLocalDev &&
    shouldAcceptLocalDevBearer(request) &&
    token === LOCAL_DEV_BEARER_TOKEN
  ) {
    return verifyLocalDevCredential({ auth: localDevAuth, requiredScopes });
  }

  if (isJwtShapedCredential(token)) {
    return verifyWorkOsM2mCredential({ token, requiredScopes, m2mVerifier });
  }

  let apiKey: WorkOsApiKey | null;

  try {
    apiKey = await apiKeyValidator(token);
  } catch (error) {
    throw new PublicApiAuthError({
      code: "auth_provider_unavailable",
      message:
        error instanceof Error
          ? error.message
          : "The auth provider is unavailable.",
      status: 503,
    });
  }

  if (!apiKey) {
    throw new PublicApiAuthError({
      code: "invalid_api_key",
      message: "The API key is invalid or revoked.",
      status: 401,
    });
  }

  return verifyWorkOsApiKeyCredential({ apiKey, requiredScopes });
}

export function createLocalDevAuthContext(): TidegateAuthContext {
  const permissions = [
    "tidegate:interaction:*",
    "booking:write",
    "todo:read",
    "todo:write",
    // Event Scout proposal-only lane.
    "web:search",
  ];

  return {
    organizationId: "demo-salon",
    orgId: "demo-salon",
    tenantId: "demo-salon",
    subjectId: "local-dev",
    subjectType: "user",
    credentialId: "local-dev",
    credentialType: "local_dev",
    scopes: ["tidegate:interaction:*"],
    authorization: {
      permissions,
      resourceGrants: [],
    },
    userId: "local-dev",
    permissions,
    authMode: "local-dev",
  };
}

function verifyLocalDevCredential({
  auth,
  requiredScopes,
}: {
  auth: TidegateAuthContext;
  requiredScopes: string[];
}): VerifiedPublicApiCredential {
  const scopes = auth.scopes ?? [];

  if (!hasRequiredScopes({ grantedScopes: scopes, requiredScopes })) {
    throw new PublicApiAuthError({
      code: "missing_required_scope",
      message: "The local development credential is missing a required scope.",
      status: 403,
    });
  }

  return {
    kind: "local-dev",
    subjectId: auth.subjectId ?? auth.userId ?? "local-dev",
    organizationId: auth.organizationId ?? auth.tenantId ?? "local-dev",
    scopes,
    permissions: auth.permissions ?? [],
    auth,
    audit: {
      credentialId: auth.credentialId ?? "local-dev",
      ownerType: "local-dev",
      ownerId: auth.subjectId ?? auth.userId ?? "local-dev",
    },
  };
}

async function verifyWorkOsM2mCredential({
  token,
  requiredScopes,
  m2mVerifier,
}: {
  token: string;
  requiredScopes: string[];
  m2mVerifier: WorkOsM2mVerifier;
}): Promise<VerifiedPublicApiCredential> {
  // Fail-closed guard: with no (or partial) WORKOS_M2M_* configuration the
  // M2M path is not enabled. A well-formed M2M token against an unconfigured
  // deployment is an operator problem, not a caller problem → 503 (D14).
  if (!m2mVerifier.configured) {
    throw new PublicApiAuthError({
      code: "unsupported_credential",
      message:
        "WorkOS M2M token verification is not configured for this deployment.",
      status: 503,
    });
  }

  let result: WorkOsM2mVerifyResult;

  try {
    result = await m2mVerifier.verify(token);
  } catch (error) {
    throw new PublicApiAuthError({
      code: "auth_provider_unavailable",
      message:
        error instanceof Error
          ? error.message
          : "The auth provider is unavailable.",
      status: 503,
    });
  }

  if (result.status === "invalid") {
    throw new PublicApiAuthError({
      code: "invalid_credential",
      message:
        result.reason === "token_expired"
          ? "The M2M access token is expired."
          : "The M2M access token is invalid.",
      status: 401,
      reason: result.reason,
    });
  }

  if (result.status === "denied") {
    // Coarse on purpose: not distinguishing org vs client denial keeps the
    // public error surface from enumerating the allowlist configuration.
    throw new PublicApiAuthError({
      code: "invalid_credential",
      message: "The M2M credential is not authorized for this deployment.",
      status: 403,
    });
  }

  const { claims, organizationId, clientId, scopes } = result.verification;

  if (!hasRequiredScopes({ grantedScopes: scopes, requiredScopes })) {
    const missingScopes = requiredScopes.filter(
      (requiredScope) =>
        !hasRequiredScopes({
          grantedScopes: scopes,
          requiredScopes: [requiredScope],
        }),
    );

    // D12: name the missing scope(s) so the 403 is actionable.
    throw new PublicApiAuthError({
      code: "missing_required_scope",
      message: `The M2M token is missing required scope(s): ${missingScopes.join(", ")}.`,
      status: 403,
      reason: "scope_not_granted",
    });
  }

  const auth: TidegateAuthContext = {
    organizationId,
    orgId: organizationId,
    tenantId: organizationId,
    subjectId: clientId,
    subjectType: "service_account",
    credentialId: clientId,
    credentialType: "m2m_access_token",
    scopes,
    authorization: {
      permissions: scopes,
      resourceGrants: [],
    },
    // The real captured tokens carry no `client_id` claim: clientId and
    // machineClientId are mapped from `sub`.
    clientId,
    machineClientId: clientId,
    permissions: scopes,
    authMode: "m2m",
    // NB: no userId/workosUserId — an M2M caller is not a human and must
    // never write global user memory.
  };

  return {
    kind: "workos-m2m",
    subjectId: claims.sub,
    organizationId,
    scopes,
    permissions: scopes,
    auth,
    audit: {
      credentialId: claims.sub,
      ownerType: "m2m-client",
      ownerId: claims.sub,
    },
  };
}

function verifyWorkOsApiKeyCredential({
  apiKey,
  requiredScopes,
}: {
  apiKey: WorkOsApiKey;
  requiredScopes: string[];
}): VerifiedPublicApiCredential {
  const scopes = apiKey.permissions;

  if (!hasRequiredScopes({ grantedScopes: scopes, requiredScopes })) {
    throw new PublicApiAuthError({
      code: "missing_required_scope",
      message: "The API key is missing a required scope.",
      status: 403,
    });
  }

  const organizationId =
    apiKey.owner.type === "organization"
      ? apiKey.owner.id
      : apiKey.owner.organization_id;
  const subjectId =
    apiKey.owner.type === "organization" ? apiKey.id : apiKey.owner.id;
  const subjectType = apiKey.owner.type === "organization" ? "api_key" : "user";

  const auth: TidegateAuthContext = {
    organizationId,
    orgId: organizationId,
    tenantId: organizationId,
    subjectId,
    subjectType,
    credentialId: apiKey.id,
    credentialType: "api_key",
    scopes,
    authorization: {
      permissions: apiKey.permissions,
      resourceGrants: [],
    },
    userId: apiKey.owner.type === "user" ? apiKey.owner.id : undefined,
    workosUserId: apiKey.owner.type === "user" ? apiKey.owner.id : undefined,
    clientId: `api-key:${apiKey.id}`,
    machineClientId: `api-key:${apiKey.id}`,
    permissions: apiKey.permissions,
    authMode: "api-key",
  };

  return {
    kind: "workos-api-key",
    subjectId,
    organizationId,
    scopes,
    permissions: apiKey.permissions,
    auth,
    audit: {
      credentialId: apiKey.id,
      ownerType: apiKey.owner.type,
      ownerId: apiKey.owner.id,
    },
  };
}

function isLocalDevAllowed(request: Request): boolean {
  if (isLocalDevAuthExplicitlyAllowed()) {
    return true;
  }

  if (
    process.env.NODE_ENV !== "development" &&
    process.env.NODE_ENV !== "test"
  ) {
    return false;
  }

  return isLoopbackRequest(request);
}

function shouldAcceptLocalDevBearer(request: Request): boolean {
  return isLoopbackRequest(request) || isLocalDevAuthExplicitlyAllowed();
}

/**
 * The env flag is an operator opt-in for non-loopback dev hosts (the dev
 * stack binds 0.0.0.0 and is browsed over the LAN). It must be inert on
 * production-like runtimes: a leaked env var would otherwise mint the
 * local-dev credential for any caller that sends `Bearer local-dev`.
 */
function isLocalDevAuthExplicitlyAllowed(): boolean {
  return (
    process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH === "1" &&
    !isProductionLikeRuntime()
  );
}

function isProductionLikeRuntime(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production" ||
    process.env.VERCEL_ENV === "preview"
  );
}

function isLoopbackRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();

  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.")
  );
}
