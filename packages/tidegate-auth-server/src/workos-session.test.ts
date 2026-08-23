import { beforeAll, describe, expect, test } from "bun:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import { TidegateAuthContextSchema } from "@tidegate/contracts";
import {
  createWorkOsM2mVerifier,
  createWorkOsSessionVerifier,
  governanceScopesFromWorkOsRoles,
  isWorkOsUserSessionShapedToken,
  verifyPublicApiRequest,
  WorkOsSessionProviderUnavailableError,
} from "./index";

// Same environment shape as the captured M2M staging tokens: one issuer and
// one JWKS for both credential classes — only the claims differ.
const ISSUER = "https://worthy-phantom-56-staging.authkit.app";
const CLIENT_ID = "client_01K3NHD5GT3KWSAB9ZV5M47B9D";
const ORG_ID = "org_01KX6ZFWZPN8MVC4PMWGHH4ZFD";
const USER_ID = "user_01KX7A2B3C4D5E6F7G8H9J0K1M";
const SESSION_ID = "session_01KX7A2B3C4D5E6F7G8H9J0K2N";
const M2M_CLIENT_ID = "client_01KX6ZJXT8RPBWGQAYYRDJDFFR";
const KID = "sso_oidc_key_pair_test";

let signingKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey as CryptoKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = createLocalJWKSet({
    keys: [{ ...jwk, kid: KID, alg: "RS256" }],
  });
});

async function sessionToken({
  claims = {},
  subject = USER_ID,
  issuer = ISSUER,
  expiresIn = 300,
}: {
  claims?: Record<string, unknown>;
  subject?: string;
  issuer?: string;
  expiresIn?: number;
} = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sid: SESSION_ID,
    org_id: ORG_ID,
    role: "member",
    client_id: CLIENT_ID,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt(nowSec)
    .setIssuer(issuer)
    .setSubject(subject)
    .setExpirationTime(nowSec + expiresIn)
    .sign(signingKey);
}

// Real M2M claim shape (docs/auth/m2m-token-capture.md): machine subject,
// STRING audience, space-delimited scope, no sid.
async function m2mToken({
  expiresIn = 3600,
}: { expiresIn?: number } = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);

  return new SignJWT({ org_id: ORG_ID, scope: "tidegate:interaction:invoke" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt(nowSec)
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(M2M_CLIENT_ID)
    .setExpirationTime(nowSec + expiresIn)
    .sign(signingKey);
}

function sessionVerifier(
  overrides: Parameters<typeof createWorkOsSessionVerifier>[0] = {},
) {
  return createWorkOsSessionVerifier({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    jwks,
    ...overrides,
  });
}

function request(authorization: string) {
  return new Request(
    "https://api.example.com/api/v1/interaction-drafts",
    { headers: { authorization } },
  );
}

describe("createWorkOsSessionVerifier", () => {
  test("verifies a signed session token into user, org, session id and roles", async () => {
    const result = await sessionVerifier().verify(await sessionToken());

    expect(result).toMatchObject({
      status: "verified",
      verification: {
        userId: USER_ID,
        organizationId: ORG_ID,
        sessionId: SESSION_ID,
        roles: ["member"],
      },
    });
  });

  test("merges the role and roles claims without duplicates", async () => {
    const result = await sessionVerifier().verify(
      await sessionToken({
        claims: { role: "admin", roles: ["admin", "approver"] },
      }),
    );

    expect(result).toMatchObject({
      status: "verified",
      verification: { roles: ["admin", "approver"] },
    });
  });

  test("never verifies an M2M token as a session (machine subject)", async () => {
    await expect(sessionVerifier().verify(await m2mToken())).resolves.toEqual({
      status: "invalid",
    });
  });

  test("rejects an expired session token with the token_expired reason", async () => {
    await expect(
      sessionVerifier().verify(await sessionToken({ expiresIn: -600 })),
    ).resolves.toEqual({ status: "invalid", reason: "token_expired" });
  });

  test("rejects tokens from another issuer", async () => {
    await expect(
      sessionVerifier().verify(
        await sessionToken({ issuer: "https://other.authkit.app" }),
      ),
    ).resolves.toEqual({ status: "invalid" });
  });

  test("rejects tokens minted for another AuthKit application", async () => {
    await expect(
      sessionVerifier().verify(
        await sessionToken({ claims: { client_id: "client_other" } }),
      ),
    ).resolves.toEqual({ status: "invalid" });
  });

  test("accepts tokens without a client_id claim (older token shapes)", async () => {
    await expect(
      sessionVerifier().verify(
        await sessionToken({ claims: { client_id: undefined } }),
      ),
    ).resolves.toMatchObject({ status: "verified" });
  });

  test("is unconfigured without issuer or client id and refuses to verify", async () => {
    const verifier = createWorkOsSessionVerifier({ issuer: "", clientId: "" });

    expect(verifier.configured).toBe(false);
    await expect(verifier.verify(await sessionToken())).rejects.toBeInstanceOf(
      WorkOsSessionProviderUnavailableError,
    );
  });
});

describe("isWorkOsUserSessionShapedToken", () => {
  test("routes user subjects to the session class and machine subjects to M2M", async () => {
    expect(isWorkOsUserSessionShapedToken(await sessionToken())).toBe(true);
    expect(isWorkOsUserSessionShapedToken(await m2mToken())).toBe(false);
    expect(isWorkOsUserSessionShapedToken("header.payload.signature")).toBe(
      false,
    );
  });
});

describe("governanceScopesFromWorkOsRoles", () => {
  test("maps only governance role slugs to governance scopes", () => {
    expect(
      governanceScopesFromWorkOsRoles(["member", "admin", "approver"]),
    ).toEqual(["tidegate:app:admin", "tidegate:app:approve"]);
    expect(governanceScopesFromWorkOsRoles(["member"])).toEqual([]);
  });
});

describe("verifyPublicApiRequest — workos-session", () => {
  const m2mVerifierNeverCalled = {
    configured: true,
    verify: async () => {
      throw new Error("The M2M verifier must not run for session tokens.");
    },
  };

  test("verifies a session token and maps it to a user TidegateAuthContext", async () => {
    const verified = await verifyPublicApiRequest({
      request: request(`Bearer ${await sessionToken()}`),
      requiredScopes: ["tidegate:interaction:publish"],
      sessionVerifier: sessionVerifier(),
      m2mVerifier: m2mVerifierNeverCalled,
      apiKeyValidator: async () => {
        throw new Error("API key validator must not run for session tokens.");
      },
    });

    expect(verified).toMatchObject({
      kind: "workos-session",
      subjectId: USER_ID,
      organizationId: ORG_ID,
      scopes: ["tidegate:interaction:*"],
      permissions: ["tidegate:interaction:*"],
      auth: {
        authMode: "user",
        organizationId: ORG_ID,
        orgId: ORG_ID,
        tenantId: ORG_ID,
        subjectId: USER_ID,
        subjectType: "user",
        credentialId: SESSION_ID,
        credentialType: "session",
        userId: USER_ID,
        workosUserId: USER_ID,
      },
      audit: {
        credentialId: SESSION_ID,
        ownerType: "user",
        ownerId: USER_ID,
      },
    });
    // A human session is never a machine caller.
    expect(verified.auth.clientId).toBeUndefined();
    expect(verified.auth.machineClientId).toBeUndefined();
    // The derived context must satisfy the canonical schema, like the
    // interaction routes re-validate it.
    expect(TidegateAuthContextSchema.safeParse(verified.auth).success).toBe(
      true,
    );
  });

  test("translates governance roles into scopes and NEVER into permissions", async () => {
    const verified = await verifyPublicApiRequest({
      request: request(
        `Bearer ${await sessionToken({
          claims: { role: "admin", roles: ["admin", "approver"] },
        })}`,
      ),
      requiredScopes: ["tidegate:interaction:publish"],
      sessionVerifier: sessionVerifier(),
    });

    expect(verified.scopes).toEqual([
      "tidegate:interaction:*",
      "tidegate:app:admin",
      "tidegate:app:approve",
    ]);
    expect(verified.auth.authorization?.permissions).toEqual([
      "tidegate:interaction:*",
    ]);
    expect(verified.auth.permissions).toEqual(["tidegate:interaction:*"]);
  });

  test("an M2M token is dispatched to the M2M path, never the session path", async () => {
    const verified = await verifyPublicApiRequest({
      request: request(`Bearer ${await m2mToken()}`),
      requiredScopes: ["tidegate:interaction:invoke"],
      sessionVerifier: {
        configured: true,
        verify: async () => {
          throw new Error(
            "The session verifier must not run for M2M tokens.",
          );
        },
      },
      m2mVerifier: createWorkOsM2mVerifier({
        issuer: ISSUER,
        jwksUrl: `${ISSUER}/oauth2/jwks`,
        audience: CLIENT_ID,
        allowedOrgIds: [ORG_ID],
        allowedClientIds: [M2M_CLIENT_ID],
        jwks,
      }),
    });

    expect(verified).toMatchObject({
      kind: "workos-m2m",
      auth: {
        authMode: "m2m",
        subjectType: "service_account",
        credentialType: "m2m_access_token",
      },
    });
    expect(verified.auth.userId).toBeUndefined();
    expect(verified.auth.workosUserId).toBeUndefined();
  });

  test("a session token never reaches the M2M verifier even when M2M is configured", async () => {
    // A session token is cryptographically valid against the shared JWKS: a
    // shape-agnostic M2M path could try (and reject) it for the wrong
    // reasons. The dispatch must hand it to the session verifier instead.
    const verified = await verifyPublicApiRequest({
      request: request(`Bearer ${await sessionToken()}`),
      requiredScopes: ["tidegate:interaction:discover"],
      sessionVerifier: sessionVerifier(),
      m2mVerifier: m2mVerifierNeverCalled,
    });

    expect(verified.kind).toBe("workos-session");
  });

  test("rejects an expired session token with the token_expired reason", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request(`Bearer ${await sessionToken({ expiresIn: -600 })}`),
        requiredScopes: ["tidegate:interaction:publish"],
        sessionVerifier: sessionVerifier(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_credential",
      status: 401,
      reason: "token_expired",
    });
  });

  test("rejects a session without an active organization", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request(
          `Bearer ${await sessionToken({ claims: { org_id: undefined } })}`,
        ),
        requiredScopes: ["tidegate:interaction:publish"],
        sessionVerifier: sessionVerifier(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_credential",
      status: 403,
    });
  });

  test("rejects a session missing a route scope, naming the scope", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request(`Bearer ${await sessionToken()}`),
        requiredScopes: ["tidegate:action-backend:register"],
        sessionVerifier: sessionVerifier(),
      }),
    ).rejects.toMatchObject({
      code: "missing_required_scope",
      message:
        "The session is missing required scope(s): tidegate:action-backend:register.",
      status: 403,
      reason: "scope_not_granted",
    });
  });

  test("governance scopes satisfy governance-scoped routes", async () => {
    const verified = await verifyPublicApiRequest({
      request: request(
        `Bearer ${await sessionToken({ claims: { role: "approver" } })}`,
      ),
      requiredScopes: ["tidegate:app:approve"],
      sessionVerifier: sessionVerifier(),
    });

    expect(verified.kind).toBe("workos-session");
  });

  test("fails closed when the session verifier is not configured", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request(`Bearer ${await sessionToken()}`),
        requiredScopes: ["tidegate:interaction:publish"],
        sessionVerifier: createWorkOsSessionVerifier({
          issuer: "",
          clientId: "",
        }),
      }),
    ).rejects.toMatchObject({
      code: "unsupported_credential",
      status: 503,
    });
  });

  test("maps an unreachable JWKS to auth_provider_unavailable", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request(`Bearer ${await sessionToken()}`),
        requiredScopes: ["tidegate:interaction:publish"],
        sessionVerifier: {
          configured: true,
          verify: async () => {
            throw new WorkOsSessionProviderUnavailableError(
              "WorkOS session JWKS verification is unavailable: fetch failed.",
            );
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "auth_provider_unavailable",
      status: 503,
    });
  });

  test("rejects a tampered session token with a generic invalid_credential", async () => {
    const [header, payload] = (await sessionToken()).split(".");

    await expect(
      verifyPublicApiRequest({
        request: request(`Bearer ${header}.${payload}.dGFtcGVyZWQ`),
        requiredScopes: ["tidegate:interaction:publish"],
        sessionVerifier: sessionVerifier(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_credential",
      status: 401,
    });
  });
});
