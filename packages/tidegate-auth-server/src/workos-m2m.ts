import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

/**
 * WorkOS Connect M2M access-token verifier (issue #29, Approach B).
 *
 * Claim shape is locked to the REAL token captured from WorkOS staging on
 * 2026-07-10 (see apps/tidegate-agent/docs/auth/m2m-token-capture.md):
 *
 * - `iss`: the AuthKit domain (e.g. https://<subdomain>.authkit.app);
 * - `aud`: a STRING — the client_id of the associated AuthKit application,
 *   NOT an invented Tidegate resource audience. Per the runbook rule we
 *   validate the value WorkOS actually emits, configured via
 *   WORKOS_M2M_AUDIENCE;
 * - `org_id`: the customer/partner organization (required, non-empty);
 * - `sub`: the M2M client id. The `client_id` claim is ABSENT on real
 *   tokens, so clientId/machineClientId map from `sub`;
 * - `scope`: a space-delimited STRING (already tidegate-vocabulary, e.g.
 *   "tidegate:interaction:invoke"). An array-shaped `scopes` claim is kept
 *   as a robustness fallback;
 * - header `alg` RS256 (allowlist RS256/ES256 — gate decision D10);
 * - lifetime 3600s.
 */

export const WorkOsM2mClaimsSchema = z.looseObject({
  sub: z.string().min(1),
  org_id: z.string().min(1),
  scope: z.string().optional(),
  scopes: z.array(z.string().min(1)).optional(),
});

export type WorkOsM2mClaims = z.infer<typeof WorkOsM2mClaimsSchema>;

export type WorkOsM2mVerification = {
  claims: WorkOsM2mClaims;
  organizationId: string;
  /** The M2M client id. Mapped from `sub`: real tokens carry no `client_id`. */
  clientId: string;
  /** Granted scopes after the tidegate-vocabulary allowlist (D5). */
  scopes: string[];
};

export type WorkOsM2mVerifyResult =
  | { status: "verified"; verification: WorkOsM2mVerification }
  | {
      /** Signature/claims/shape failure — map to 401 invalid_credential. */
      status: "invalid";
      /** Safe self-fix reason (D13). Generic for sig/iss/aud failures. */
      reason?: "token_expired";
    }
  | {
      /**
       * Token is cryptographically valid but the org/client is not
       * authorized for this deployment (fail-closed allowlists, D2/D3).
       */
      status: "denied";
      subject: "organization" | "client";
    };

/**
 * Thrown when the token could not be checked at all (JWKS unreachable or
 * timed out, or the verifier was invoked while unconfigured). Callers map
 * this to 503 auth_provider_unavailable — never to a 401.
 */
export class WorkOsM2mProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkOsM2mProviderUnavailableError";
  }
}

export type WorkOsM2mVerifier = {
  /**
   * True only when issuer + JWKS URL + audience are set AND both the org
   * and client allowlists are non-empty. The allowlists are REQUIRED for
   * the M2M path: an absent allowlist means M2M is not enabled in this
   * deployment (fail-closed posture, D2).
   */
  configured: boolean;
  verify: (token: string) => Promise<WorkOsM2mVerifyResult>;
};

export type CreateWorkOsM2mVerifierOptions = {
  /** Expected `iss`. Default: env WORKOS_AUTHKIT_ISSUER. */
  issuer?: string;
  /** JWKS endpoint. Default: env WORKOS_M2M_JWKS_URL. */
  jwksUrl?: string;
  /**
   * Expected `aud` (MANDATORY for the verifier to be configured — D6).
   * Default: env WORKOS_M2M_AUDIENCE.
   */
  audience?: string;
  /** Org allowlist. Default: env WORKOS_ALLOWED_ORG_IDS (comma-separated). */
  allowedOrgIds?: string[];
  /**
   * Client allowlist. Default: env WORKOS_ALLOWED_M2M_CLIENT_IDS
   * (comma-separated). Removing a client id here is the operational
   * kill-switch before token expiry.
   */
  allowedClientIds?: string[];
  /**
   * Emergency denylist seam (D3): checked BEFORE the allowlists so an
   * incident responder can cut off a client without touching the
   * allowlist config. Full live revocation/introspection is issue #25.
   */
  deniedClientIds?: string[];
  clockToleranceSec?: number;
  /** Test seam: inject a local JWKS instead of the remote singleton. */
  jwks?: JWTVerifyGetKey;
};

const M2M_ALLOWED_ALGORITHMS = ["RS256", "ES256"];

/**
 * Tidegate scope vocabulary allowlist (D5). The captured real token already
 * emits tidegate-vocabulary scopes ("tidegate:interaction:invoke"), so the
 * translator is a pass-through allowlist: only `tidegate:`-shaped scopes
 * (including `:*` wildcards) survive; anything else (e.g. WorkOS management
 * scopes) is stripped and can never become a Tidegate permission/grant.
 */
const TIDEGATE_SCOPE_PATTERN = /^tidegate:(?:[a-z0-9_-]+:)*(?:[a-z0-9_-]+|\*)$/i;

export function translateWorkOsM2mScopes(rawScopes: string[]): string[] {
  return rawScopes.filter((scope) => TIDEGATE_SCOPE_PATTERN.test(scope));
}

export function normalizeWorkOsM2mScopeClaim(claims: {
  scope?: string;
  scopes?: string[];
}): string[] {
  if (typeof claims.scope === "string") {
    return claims.scope.split(/\s+/).filter(Boolean);
  }

  if (Array.isArray(claims.scopes)) {
    return claims.scopes;
  }

  return [];
}

export function parseWorkOsIdListEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Module singleton for remote JWKS (D7): one jose remote set per
 * issuer/jwksUrl pair, so per-request verifier construction never defeats
 * the jose key cache. Explicit timeout/cooldown/cacheMaxAge.
 */
const remoteJwksCache = new Map<string, JWTVerifyGetKey>();

function getRemoteJwks({
  issuer,
  jwksUrl,
}: {
  issuer: string;
  jwksUrl: string;
}): JWTVerifyGetKey {
  const cacheKey = `${issuer}\n${jwksUrl}`;
  const cached = remoteJwksCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
  remoteJwksCache.set(cacheKey, jwks);
  return jwks;
}

export function createWorkOsM2mVerifier({
  issuer = process.env.WORKOS_AUTHKIT_ISSUER,
  jwksUrl = process.env.WORKOS_M2M_JWKS_URL,
  audience = process.env.WORKOS_M2M_AUDIENCE,
  allowedOrgIds = parseWorkOsIdListEnv(process.env.WORKOS_ALLOWED_ORG_IDS),
  allowedClientIds = parseWorkOsIdListEnv(
    process.env.WORKOS_ALLOWED_M2M_CLIENT_IDS,
  ),
  deniedClientIds = [],
  clockToleranceSec = 60,
  jwks,
}: CreateWorkOsM2mVerifierOptions = {}): WorkOsM2mVerifier {
  const trimmedIssuer = issuer?.trim() ?? "";
  const trimmedJwksUrl = jwksUrl?.trim() ?? "";
  const trimmedAudience = audience?.trim() ?? "";

  // Unconfigured guard BEFORE any URL/JWKS construction (D8): a partially
  // configured deployment must surface as "not configured", never as a
  // TypeError from `new URL(undefined)`.
  const configured =
    trimmedIssuer.length > 0 &&
    trimmedJwksUrl.length > 0 &&
    trimmedAudience.length > 0 &&
    allowedOrgIds.length > 0 &&
    allowedClientIds.length > 0;

  if (!configured) {
    return {
      configured: false,
      verify: async () => {
        throw new WorkOsM2mProviderUnavailableError(
          "WorkOS M2M verification is not configured for this deployment.",
        );
      },
    };
  }

  // A malformed JWKS URL is a MISconfigured deployment, not an unconfigured
  // one: no synchronous throw at construction (request crash), no downgrade
  // to unconfigured (misleading message for the operator). The verifier
  // stays configured and every verify answers provider-unavailable naming
  // the problem (503).
  let keySource: NonNullable<CreateWorkOsM2mVerifierOptions["jwks"]>;
  try {
    keySource =
      jwks ?? getRemoteJwks({ issuer: trimmedIssuer, jwksUrl: trimmedJwksUrl });
  } catch {
    return {
      configured: true,
      verify: async () => {
        throw new WorkOsM2mProviderUnavailableError(
          `WorkOS M2M JWKS URL is misconfigured for this deployment (invalid URL in WORKOS_M2M_JWKS_URL).`,
        );
      },
    };
  }

  return {
    configured: true,
    verify: async (token) => {
      let payload: unknown;

      try {
        ({ payload } = await jwtVerify(token, keySource, {
          issuer: trimmedIssuer,
          audience: trimmedAudience,
          algorithms: M2M_ALLOWED_ALGORITHMS,
          clockTolerance: clockToleranceSec,
          // jose only validates exp when present: without requiredClaims a
          // signed token missing exp would stay valid forever.
          requiredClaims: ["exp", "iat"],
        }));
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) {
          return { status: "invalid", reason: "token_expired" };
        }

        if (isInvalidTokenJoseError(error)) {
          return { status: "invalid" };
        }

        // Everything else (JWKS fetch failure/timeout, unexpected runtime
        // errors) means the token could not be checked → 503, never 401.
        throw new WorkOsM2mProviderUnavailableError(
          error instanceof Error
            ? `WorkOS M2M JWKS verification is unavailable: ${error.message}`
            : "WorkOS M2M JWKS verification is unavailable.",
        );
      }

      const parsed = WorkOsM2mClaimsSchema.safeParse(payload);

      if (!parsed.success) {
        return { status: "invalid" };
      }

      const claims = parsed.data;

      // Fail-closed authorization BEFORE any context creation (D2/D3):
      // signature validity answers "did WorkOS issue this?", not "may this
      // caller act on this Tidegate deployment?".
      if (deniedClientIds.includes(claims.sub)) {
        return { status: "denied", subject: "client" };
      }

      if (!allowedOrgIds.includes(claims.org_id)) {
        return { status: "denied", subject: "organization" };
      }

      if (!allowedClientIds.includes(claims.sub)) {
        return { status: "denied", subject: "client" };
      }

      return {
        status: "verified",
        verification: {
          claims,
          organizationId: claims.org_id,
          clientId: claims.sub,
          scopes: translateWorkOsM2mScopes(
            normalizeWorkOsM2mScopeClaim(claims),
          ),
        },
      };
    },
  };
}

/**
 * Explicit jose error-class → outcome map (D9). These classes mean "the
 * token itself is bad" → 401 invalid_credential:
 * - JWTExpired handled separately (safe reason `token_expired`);
 * - JWTClaimValidationFailed: iss/aud mismatch, nbf in the future, ...;
 * - JWSSignatureVerificationFailed: wrong key/tampered token;
 * - JWKSNoMatchingKey / JWKSMultipleMatchingKeys: kid mismatch;
 * - JOSEAlgNotAllowed / JOSENotSupported: alg none / HS* / anything
 *   outside the RS256/ES256 allowlist (D10);
 * - JWSInvalid / JWTInvalid: malformed token.
 * Anything NOT listed here (JWKSTimeout, fetch errors) is a provider
 * problem → WorkOsM2mProviderUnavailableError → 503.
 */
function isInvalidTokenJoseError(error: unknown): boolean {
  return (
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys ||
    error instanceof joseErrors.JOSEAlgNotAllowed ||
    error instanceof joseErrors.JOSENotSupported ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWTInvalid
  );
}
