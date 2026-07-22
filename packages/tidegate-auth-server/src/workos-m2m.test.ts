import { beforeAll, describe, expect, test } from "bun:test";
import {
  SignJWT,
  createLocalJWKSet,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import {
  WorkOsM2mProviderUnavailableError,
  createWorkOsM2mVerifier,
  normalizeWorkOsM2mScopeClaim,
  parseWorkOsIdListEnv,
  translateWorkOsM2mScopes,
} from "./workos-m2m.ts";

// Values from the REAL staging token captured for issue #29 stage 1
// (docs/auth/m2m-token-capture.md). Only the signing key is local.
const ISSUER = "https://worthy-phantom-56-staging.authkit.app";
const JWKS_URL = `${ISSUER}/oauth2/jwks`;
const AUDIENCE = "client_01K3NHD5GT3KWSAB9ZV5M47B9D";
const ORG_ID = "org_01KX6ZFWZPN8MVC4PMWGHH4ZFD";
const CLIENT_ID = "client_01KX6ZJXT8RPBWGQAYYRDJDFFR";
const KID = "sso_oidc_key_pair_test";

let signingKey: CryptoKey;
let wrongKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const otherPair = await generateKeyPair("RS256");
  signingKey = pair.privateKey as CryptoKey;
  wrongKey = otherPair.privateKey as CryptoKey;

  const jwk = await exportJWK(pair.publicKey);
  jwks = createLocalJWKSet({
    keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }],
  });
});

async function signToken({
  key = signingKey,
  kid = KID,
  alg = "RS256",
  issuer = ISSUER,
  audience = AUDIENCE as string | string[] | undefined,
  subject = CLIENT_ID as string | undefined,
  expiresIn = 3600,
  notBefore,
  claims = {},
}: {
  key?: CryptoKey | Uint8Array;
  kid?: string;
  alg?: string;
  issuer?: string;
  audience?: string | string[] | undefined;
  subject?: string | undefined;
  expiresIn?: number;
  notBefore?: number;
  claims?: Record<string, unknown>;
} = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    org_id: ORG_ID,
    scope: "tidegate:interaction:invoke",
    ...claims,
  })
    .setProtectedHeader({ alg, kid })
    .setIssuedAt(nowSec)
    .setIssuer(issuer)
    .setExpirationTime(nowSec + expiresIn);

  if (audience !== undefined) {
    jwt.setAudience(audience);
  }

  if (subject) {
    jwt.setSubject(subject);
  }

  if (notBefore !== undefined) {
    jwt.setNotBefore(nowSec + notBefore);
  }

  return jwt.sign(key);
}

function verifier(
  overrides: Parameters<typeof createWorkOsM2mVerifier>[0] = {},
) {
  return createWorkOsM2mVerifier({
    issuer: ISSUER,
    jwksUrl: JWKS_URL,
    audience: AUDIENCE,
    allowedOrgIds: [ORG_ID],
    allowedClientIds: [CLIENT_ID],
    jwks,
    ...overrides,
  });
}

describe("createWorkOsM2mVerifier", () => {
  test("verifies the captured real-token claim shape (scope as string, client from sub)", async () => {
    const result = await verifier().verify(await signToken());

    expect(result).toEqual({
      status: "verified",
      verification: {
        claims: expect.objectContaining({
          sub: CLIENT_ID,
          org_id: ORG_ID,
          scope: "tidegate:interaction:invoke",
        }),
        organizationId: ORG_ID,
        clientId: CLIENT_ID,
        scopes: ["tidegate:interaction:invoke"],
      },
    });
  });

  test("normalizes an array-shaped scopes claim (robustness fallback)", async () => {
    const token = await signToken({
      claims: {
        scope: undefined,
        scopes: ["tidegate:interaction:invoke", "tidegate:interaction:discover"],
      },
    });
    const result = await verifier().verify(token);

    expect(result.status).toBe("verified");
    expect(
      result.status === "verified" ? result.verification.scopes : [],
    ).toEqual(["tidegate:interaction:invoke", "tidegate:interaction:discover"]);
  });

  test("strips non-tidegate scopes through the pass-through allowlist (D5)", async () => {
    const token = await signToken({
      claims: {
        scope:
          "tidegate:interaction:invoke widgets:manage_environment admin:* tidegate:interaction:*",
      },
    });
    const result = await verifier().verify(token);

    expect(
      result.status === "verified" ? result.verification.scopes : null,
    ).toEqual(["tidegate:interaction:invoke", "tidegate:interaction:*"]);
  });

  test("rejects a token signed with the wrong key", async () => {
    const result = await verifier().verify(await signToken({ key: wrongKey }));
    expect(result).toEqual({ status: "invalid" });
  });

  test("rejects an expired token with the token_expired reason (D13)", async () => {
    const token = await signToken({ expiresIn: -3600 });
    const result = await verifier().verify(token);
    expect(result).toEqual({ status: "invalid", reason: "token_expired" });
  });

  test("rejects a wrong issuer", async () => {
    const token = await signToken({ issuer: "https://evil.example.com" });
    expect(await verifier().verify(token)).toEqual({ status: "invalid" });
  });

  test("rejects a wrong audience", async () => {
    const token = await signToken({ audience: "client_someone_else" });
    expect(await verifier().verify(token)).toEqual({ status: "invalid" });
  });

  test("rejects a missing org_id claim", async () => {
    const token = await signToken({ claims: { org_id: undefined } });
    expect(await verifier().verify(token)).toEqual({ status: "invalid" });
  });

  test("rejects a missing sub claim", async () => {
    const token = await signToken({ subject: "" });
    expect(await verifier().verify(token)).toEqual({ status: "invalid" });
  });

  test("rejects a signed token WITHOUT exp (requiredClaims, never valid forever)", async () => {
    // Built inline without setExpirationTime: signToken's destructuring
    // default would re-add exp even when passing expiresIn: undefined.
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenWithoutExp = await new SignJWT({
      org_id: ORG_ID,
      scope: "tidegate:interaction:invoke",
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt(nowSec)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(CLIENT_ID)
      .sign(signingKey);

    const result = await verifier().verify(tokenWithoutExp);
    expect(result.status).toBe("invalid");
  });

  test("rejects alg none (D10)", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: CLIENT_ID,
        org_id: ORG_ID,
        scope: "tidegate:interaction:invoke",
        iat: nowSec,
        exp: nowSec + 3600,
      }),
    ).toString("base64url");

    expect(await verifier().verify(`${header}.${payload}.`)).toEqual({
      status: "invalid",
    });
    expect(await verifier().verify(`${header}.${payload}.forged`)).toEqual({
      status: "invalid",
    });
  });

  test("rejects HS256 tokens (alg allowlist, D10)", async () => {
    const secret = new Uint8Array(32).fill(7);
    const token = await signToken({ key: secret, alg: "HS256" });
    expect(await verifier().verify(token)).toEqual({ status: "invalid" });
  });

  test("rejects nbf in the future beyond clock tolerance", async () => {
    const token = await signToken({ notBefore: 3600 });
    expect(await verifier().verify(token)).toEqual({ status: "invalid" });
  });

  test("rejects a kid that matches no JWKS key", async () => {
    const token = await signToken({ kid: "sso_oidc_key_pair_other" });
    expect(await verifier().verify(token)).toEqual({ status: "invalid" });
  });

  test("denies an org that is not allowlisted (fail-closed, D2)", async () => {
    const token = await signToken({ claims: { org_id: "org_foreign" } });
    expect(await verifier().verify(token)).toEqual({
      status: "denied",
      subject: "organization",
    });
  });

  test("denies a client that is not allowlisted (fail-closed, D2)", async () => {
    const token = await signToken({ subject: "client_unknown" });
    const result = await verifier({
      allowedClientIds: [CLIENT_ID],
      allowedOrgIds: [ORG_ID],
    }).verify(token);

    expect(result).toEqual({ status: "denied", subject: "client" });
  });

  test("the denylist kill-switch wins over the allowlist (D3 seam)", async () => {
    const result = await verifier({
      deniedClientIds: [CLIENT_ID],
    }).verify(await signToken());

    expect(result).toEqual({ status: "denied", subject: "client" });
  });

  test("is unconfigured without an audience (mandatory aud, D6)", () => {
    expect(verifier({ audience: "" }).configured).toBe(false);
  });

  test("is unconfigured without allowlists (allowlist REQUIRED posture, D2)", () => {
    expect(verifier({ allowedOrgIds: [] }).configured).toBe(false);
    expect(verifier({ allowedClientIds: [] }).configured).toBe(false);
  });

  test("is unconfigured without issuer or JWKS URL, without URL construction (D8)", () => {
    expect(verifier({ issuer: "" }).configured).toBe(false);
    // No jwks injection + non-URL jwksUrl: must not throw a TypeError.
    expect(
      createWorkOsM2mVerifier({
        issuer: "",
        jwksUrl: "",
        audience: "",
        allowedOrgIds: [],
        allowedClientIds: [],
      }).configured,
    ).toBe(false);
  });

  test("verify on an unconfigured verifier throws provider-unavailable, never a token error", async () => {
    const unconfigured = verifier({ audience: "" });
    await expect(unconfigured.verify(await signToken())).rejects.toBeInstanceOf(
      WorkOsM2mProviderUnavailableError,
    );
  });

  test("maps JWKS fetch failures to provider-unavailable (D9)", async () => {
    const unreachableJwks: JWTVerifyGetKey = async () => {
      throw new joseErrors.JWKSTimeout();
    };

    await expect(
      verifier({ jwks: unreachableJwks }).verify(await signToken()),
    ).rejects.toBeInstanceOf(WorkOsM2mProviderUnavailableError);
  });

  test("a malformed JWKS URL never throws at construction: configured, provider-unavailable on verify", async () => {
    const malformed = verifier({ jwks: undefined, jwksUrl: "not a url at all" });
    expect(malformed.configured).toBe(true);
    await expect(malformed.verify(await signToken())).rejects.toBeInstanceOf(
      WorkOsM2mProviderUnavailableError,
    );
    await expect(malformed.verify(await signToken())).rejects.toThrow(
      /WORKOS_M2M_JWKS_URL/,
    );
  });
});

describe("translateWorkOsM2mScopes", () => {
  test("accepts only tidegate-vocabulary scopes including wildcards", () => {
    expect(
      translateWorkOsM2mScopes([
        "tidegate:interaction:invoke",
        "tidegate:interaction:*",
        "tidegate:*",
        "widgets:manage_environment",
        "openid",
        "tidegate:",
        "*",
      ]),
    ).toEqual([
      "tidegate:interaction:invoke",
      "tidegate:interaction:*",
      "tidegate:*",
    ]);
  });
});

describe("normalizeWorkOsM2mScopeClaim", () => {
  test("splits a space-delimited scope string", () => {
    expect(
      normalizeWorkOsM2mScopeClaim({ scope: " a  b\tc " }),
    ).toEqual(["a", "b", "c"]);
  });

  test("falls back to the scopes array and then to empty", () => {
    expect(normalizeWorkOsM2mScopeClaim({ scopes: ["a"] })).toEqual(["a"]);
    expect(normalizeWorkOsM2mScopeClaim({})).toEqual([]);
  });
});

describe("parseWorkOsIdListEnv", () => {
  test("parses comma-separated env allowlists", () => {
    expect(parseWorkOsIdListEnv(" org_a , org_b ,,")).toEqual([
      "org_a",
      "org_b",
    ]);
    expect(parseWorkOsIdListEnv(undefined)).toEqual([]);
    expect(parseWorkOsIdListEnv("")).toEqual([]);
  });
});
