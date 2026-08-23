import {
  createRemoteJWKSet,
  decodeJwt,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

/**
 * WorkOS AuthKit session access-token verifier (spec
 * docs/specs/2026-08-workos-authkit-migration.md, decision 7).
 *
 * The session credential is the third public-API credential type next to API
 * keys and M2M tokens. It is distinguished from M2M by claims, never by
 * configuration: a session token's `sub` is a WorkOS **user** id (`user_…`),
 * an M2M token's `sub` is the machine client id (`client_…`). Real AuthKit
 * session claims:
 *
 * - `iss`: the AuthKit domain of the environment (same issuer as M2M);
 * - `sub`: the WorkOS user id (`user_…`) — REQUIRED shape, the dispatch key;
 * - `sid`: the AuthKit session id (used as credential id when present);
 * - `org_id`: the active organization of the session (absent when the session
 *   has no organization context — the public surface rejects that upstream);
 * - `role` / `roles`: role slug(s) of the user's membership in the active
 *   org. Governance slugs translate to governance SCOPES
 *   (`tidegate:app:admin`, `tidegate:app:approve`) and NEVER into
 *   `authorization.permissions` (decision 7);
 * - `client_id`: binds the token to one AuthKit application of the
 *   environment when present; older token shapes don't carry it.
 */

export const WORKOS_USER_SUBJECT_PREFIX = "user_";

export const WorkOsSessionClaimsSchema = z.looseObject({
  sub: z.string().startsWith(WORKOS_USER_SUBJECT_PREFIX),
  sid: z.string().min(1).optional(),
  org_id: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  roles: z.array(z.string().min(1)).optional(),
  client_id: z.string().min(1).optional(),
});

export type WorkOsSessionClaims = z.infer<typeof WorkOsSessionClaimsSchema>;

export type WorkOsSessionVerification = {
  claims: WorkOsSessionClaims;
  /** The WorkOS user id (`sub`). */
  userId: string;
  /** Active organization of the session (`org_id`), when it has one. */
  organizationId?: string;
  /** AuthKit session id (`sid`), when present. */
  sessionId?: string;
  /** Deduplicated role slugs from the `role`/`roles` claims. */
  roles: string[];
};

export type WorkOsSessionVerifyResult =
  | { status: "verified"; verification: WorkOsSessionVerification }
  | {
      /** Signature/claims/shape failure — map to 401 invalid_credential. */
      status: "invalid";
      reason?: "token_expired";
    };

/**
 * Thrown when the token could not be checked at all (JWKS unreachable or
 * timed out, or the verifier was invoked while unconfigured). Callers map
 * this to 503 auth_provider_unavailable — never to a 401.
 */
export class WorkOsSessionProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkOsSessionProviderUnavailableError";
  }
}

export type WorkOsSessionVerifier = {
  /**
   * True only when issuer AND AuthKit application client id are set. An
   * unconfigured deployment fails closed: session-shaped tokens answer 503
   * unsupported_credential, never a fallback to another credential path.
   */
  configured: boolean;
  verify: (token: string) => Promise<WorkOsSessionVerifyResult>;
};

export type CreateWorkOsSessionVerifierOptions = {
  /** Expected `iss`. Default: env WORKOS_AUTHKIT_ISSUER. */
  issuer?: string;
  /**
   * AuthKit application client id of this deployment (env WORKOS_CLIENT_ID).
   * WorkOS environments can host several applications behind the same
   * issuer/JWKS: a token whose `client_id` claim names another application is
   * rejected. Tokens without the claim are accepted (older token shapes
   * don't carry it).
   */
  clientId?: string;
  /** JWKS endpoint. Default: `${issuer}/oauth2/jwks`. */
  jwksUrl?: string;
  clockToleranceSec?: number;
  /** Test seam: inject a local JWKS instead of the remote singleton. */
  jwks?: JWTVerifyGetKey;
};

const SESSION_ALLOWED_ALGORITHMS = ["RS256", "ES256"];

/**
 * Claims-based dispatch key for JWT-shaped public-API credentials: a token
 * whose (unverified) `sub` names a WorkOS user is routed to the session
 * verifier, everything else to the M2M verifier. Each verifier then enforces
 * its own claim shape, so an M2M token can never be exchanged for a session
 * and vice versa even if this sniff were bypassed.
 */
export function isWorkOsUserSessionShapedToken(token: string): boolean {
  try {
    const { sub } = decodeJwt(token);
    return typeof sub === "string" && sub.startsWith(WORKOS_USER_SUBJECT_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Day-one grant of a session credential: membership suffices to create,
 * publish and use interactions (spec decision 9 — "permessi aperti"). These
 * are the ONLY entries the AUTH SERVER puts into
 * `authorization.permissions` for a session: the per-customer default
 * domain grants (decision 7) are resolved from the customer's action
 * backend registration by the app layer (`lib/session-action-grants.ts` in
 * the agent — this package never touches the database); per-user
 * granularity is future work.
 */
export const WORKOS_SESSION_DEFAULT_SCOPES = ["tidegate:interaction:*"];

/**
 * Governance role slugs of the WorkOS membership → governance scopes
 * (decision 7). Scopes only: the runtime consumes
 * `authorization.permissions` as the grant set for actions, and mixing the
 * governance roles in would give them the power to call actions.
 */
export const WORKOS_SESSION_GOVERNANCE_ROLE_SCOPES: Readonly<
  Record<string, string>
> = {
  admin: "tidegate:app:admin",
  approver: "tidegate:app:approve",
};

export function governanceScopesFromWorkOsRoles(
  roles: readonly string[],
): string[] {
  const scopes = new Set<string>();

  for (const role of roles) {
    const scope = WORKOS_SESSION_GOVERNANCE_ROLE_SCOPES[role];

    if (scope !== undefined) {
      scopes.add(scope);
    }
  }

  return [...scopes];
}

export function normalizeWorkOsSessionRoleClaims(claims: {
  role?: string;
  roles?: string[];
}): string[] {
  const roles = new Set<string>();

  if (claims.role !== undefined) {
    roles.add(claims.role);
  }

  for (const role of claims.roles ?? []) {
    roles.add(role);
  }

  return [...roles];
}

/**
 * Module singleton for the remote JWKS: one jose remote set per
 * issuer/jwksUrl pair, so per-request verifier construction never defeats
 * the jose key cache. Same posture as the M2M verifier.
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

export function createWorkOsSessionVerifier({
  issuer = process.env.WORKOS_AUTHKIT_ISSUER,
  clientId = process.env.WORKOS_CLIENT_ID,
  jwksUrl,
  clockToleranceSec = 60,
  jwks,
}: CreateWorkOsSessionVerifierOptions = {}): WorkOsSessionVerifier {
  const trimmedIssuer = (issuer ?? "").trim().replace(/\/+$/, "");
  const trimmedClientId = (clientId ?? "").trim();
  // WorkOS presenta lo stesso environment sotto DUE identità issuer, a seconda
  // dell'endpoint che ha avviato il flusso: il dominio AuthKit configurato
  // (es. https://<slug>.authkit.app) oppure la forma
  // https://api.workos.com/user_management/<client_id> (usata dai flussi
  // authorize di api.workos.com, cioè da @workos-inc/authkit-nextjs). I due
  // endpoint JWKS servono le stesse chiavi; il binding all'applicazione resta
  // garantito dal claim client_id e dalla shape user_ del sub.
  const acceptedIssuers =
    trimmedClientId.length > 0
      ? [
          trimmedIssuer,
          `https://api.workos.com/user_management/${trimmedClientId}`,
        ]
      : [trimmedIssuer];
  const trimmedJwksUrl =
    jwksUrl?.trim() ||
    (trimmedIssuer.length > 0 ? `${trimmedIssuer}/oauth2/jwks` : "");

  // Unconfigured guard BEFORE any URL/JWKS construction: a partially
  // configured deployment must surface as "not configured", never as a
  // TypeError from `new URL(undefined)`.
  const configured = trimmedIssuer.length > 0 && trimmedClientId.length > 0;

  if (!configured) {
    return {
      configured: false,
      verify: async () => {
        throw new WorkOsSessionProviderUnavailableError(
          "WorkOS session verification is not configured for this deployment.",
        );
      },
    };
  }

  // A malformed JWKS URL is a MISconfigured deployment, not an unconfigured
  // one: no synchronous throw at construction, no downgrade to unconfigured.
  // Every verify answers provider-unavailable naming the problem (503).
  let keySource: JWTVerifyGetKey;
  try {
    keySource =
      jwks ?? getRemoteJwks({ issuer: trimmedIssuer, jwksUrl: trimmedJwksUrl });
  } catch {
    return {
      configured: true,
      verify: async () => {
        throw new WorkOsSessionProviderUnavailableError(
          "WorkOS session JWKS URL is misconfigured for this deployment.",
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
          issuer: acceptedIssuers,
          algorithms: SESSION_ALLOWED_ALGORITHMS,
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

        // JWKS unreachable/timeout: the token could not be checked at all.
        // Propagate as provider-unavailable (503 at the callers), never 401.
        throw new WorkOsSessionProviderUnavailableError(
          error instanceof Error
            ? `WorkOS session JWKS verification is unavailable: ${error.message}`
            : "WorkOS session JWKS verification is unavailable.",
        );
      }

      const parsed = WorkOsSessionClaimsSchema.safeParse(payload);

      // Shape enforcement doubles as the anti-confusion barrier: a
      // cryptographically valid M2M token (machine `sub`) can never verify
      // as a session.
      if (!parsed.success) {
        return { status: "invalid" };
      }

      const claims = parsed.data;

      if (
        claims.client_id !== undefined &&
        claims.client_id !== trimmedClientId
      ) {
        return { status: "invalid" };
      }

      return {
        status: "verified",
        verification: {
          claims,
          userId: claims.sub,
          organizationId: claims.org_id,
          sessionId: claims.sid,
          roles: normalizeWorkOsSessionRoleClaims(claims),
        },
      };
    },
  };
}

/**
 * Explicit jose error-class → outcome map (mirrors the M2M verifier): these
 * mean "the token itself is bad" → 401. Anything else (JWKS timeout, fetch
 * errors) is a provider problem and must not look like a sign-in failure.
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
