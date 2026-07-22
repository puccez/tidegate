import { beforeAll, describe, expect, test } from "bun:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import {
  PublicApiAuthError,
  WorkOsM2mProviderUnavailableError,
  createLocalDevAuthContext,
  createWorkOsApiKeyValidator,
  createWorkOsM2mVerifier,
  verifyPublicApiRequest,
  type WorkOsApiKey,
} from "./index";

const originalAllowLocalDevAuth = process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH;

const organizationApiKey: WorkOsApiKey = {
  object: "api_key",
  id: "api_key_demo",
  owner: {
    type: "organization",
    id: "demo-salon",
  },
  permissions: ["tidegate:interaction:invoke", "booking:write"],
};

function request({
  authorization,
  url = "https://api.example.com/api/tidegate/v1/interactions/ix.booking.cancelAppointment/invoke",
}: {
  authorization?: string;
  url?: string;
} = {}) {
  return new Request(url, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe("verifyPublicApiRequest", () => {
  test("validates an opaque WorkOS API key and maps it to TidegateAuthContext", async () => {
    const verified = await verifyPublicApiRequest({
      request: request({ authorization: "Bearer evk_test_valid" }),
      requiredScopes: ["tidegate:interaction:invoke"],
      apiKeyValidator: async (value) => {
        expect(value).toBe("evk_test_valid");
        return organizationApiKey;
      },
    });

    expect(verified).toMatchObject({
      kind: "workos-api-key",
      organizationId: "demo-salon",
      subjectId: "api_key_demo",
      scopes: ["tidegate:interaction:invoke", "booking:write"],
      auth: {
        authMode: "api-key",
        organizationId: "demo-salon",
        tenantId: "demo-salon",
        credentialId: "api_key_demo",
        credentialType: "api_key",
        permissions: ["tidegate:interaction:invoke", "booking:write"],
      },
    });
  });

  test("maps user-owned API keys without treating them as delegated sessions", async () => {
    const verified = await verifyPublicApiRequest({
      request: request({ authorization: "Bearer evk_user_owned" }),
      requiredScopes: ["tidegate:interaction:invoke"],
      apiKeyValidator: async () => ({
        ...organizationApiKey,
        id: "api_key_user_demo",
        owner: {
          type: "user",
          id: "user_demo",
          organization_id: "demo-salon",
        },
      }),
    });

    expect(verified.auth).toMatchObject({
      authMode: "api-key",
      organizationId: "demo-salon",
      subjectId: "user_demo",
      subjectType: "user",
      credentialId: "api_key_user_demo",
      userId: "user_demo",
    });
  });

  test("rejects missing bearer tokens outside local development", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request(),
        requiredScopes: ["tidegate:interaction:invoke"],
        allowLocalDev: false,
        apiKeyValidator: async () => organizationApiKey,
      }),
    ).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
  });

  test("rejects API keys missing a route scope", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({ authorization: "Bearer evk_without_scope" }),
        requiredScopes: ["tidegate:interaction:invoke"],
        apiKeyValidator: async () => ({
          ...organizationApiKey,
          permissions: ["booking:write"],
        }),
      }),
    ).rejects.toMatchObject({
      code: "missing_required_scope",
      status: 403,
    });
  });

  test("accepts missing bearer only for local development loopback requests", async () => {
    const verified = await verifyPublicApiRequest({
      request: request({
        url: "http://localhost/api/tidegate/interactions/ix.booking.cancelAppointment/invoke",
      }),
      requiredScopes: ["tidegate:interaction:invoke"],
      allowLocalDev: true,
      apiKeyValidator: async () => {
        throw new Error("API key validator should not run for local-dev.");
      },
    });

    expect(verified).toMatchObject({
      kind: "local-dev",
      organizationId: "demo-salon",
      auth: {
        authMode: "local-dev",
        credentialType: "local_dev",
      },
    });
  });

  test("accepts local-dev bearer only for local development loopback requests", async () => {
    const verified = await verifyPublicApiRequest({
      request: request({
        authorization: "Bearer local-dev",
        url: "http://127.0.0.1:3000/api/tidegate/v1/interactions",
      }),
      requiredScopes: ["tidegate:interaction:invoke"],
      apiKeyValidator: async () => {
        throw new Error("API key validator should not run for local-dev.");
      },
    });

    expect(verified).toMatchObject({
      kind: "local-dev",
      auth: {
        authMode: "local-dev",
        credentialType: "local_dev",
      },
    });
  });

  test("rejects local-dev bearer when local development auth is disabled", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: "Bearer local-dev",
          url: "http://127.0.0.1:3000/api/tidegate/v1/interactions",
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        allowLocalDev: false,
        apiKeyValidator: async () => null,
      }),
    ).rejects.toMatchObject({
      code: "invalid_api_key",
      status: 401,
    });
  });

  test("accepts local-dev bearer on loopback when explicitly enabled by env", async () => {
    process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = "1";

    try {
      const verified = await verifyPublicApiRequest({
        request: request({
          authorization: "Bearer local-dev",
          url: "http://127.0.0.1:3000/api/tidegate/v1/interaction-drafts",
        }),
        requiredScopes: ["tidegate:interaction:publish"],
        apiKeyValidator: async () => {
          throw new Error("API key validator should not run for local-dev.");
        },
      });

      expect(verified).toMatchObject({
        kind: "local-dev",
        scopes: ["tidegate:interaction:*"],
      });
    } finally {
      if (originalAllowLocalDevAuth === undefined) {
        delete process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH;
      } else {
        process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = originalAllowLocalDevAuth;
      }
    }
  });

  test("rejects local-dev bearer on the dev server bind host", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: "Bearer local-dev",
          url: "http://0.0.0.0:3000/api/tidegate/v1/interactions",
        }),
        requiredScopes: ["tidegate:interaction:discover"],
        apiKeyValidator: async () => null,
      }),
    ).rejects.toMatchObject({
      code: "invalid_api_key",
      status: 401,
    });
  });

  test("accepts local-dev bearer on non-loopback only when explicitly enabled by env", async () => {
    process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = "1";

    try {
      const verified = await verifyPublicApiRequest({
        request: request({
          authorization: "Bearer local-dev",
          url: "http://100.90.84.33:3000/api/tidegate/v1/interactions",
        }),
        requiredScopes: ["tidegate:interaction:discover"],
        apiKeyValidator: async () => {
          throw new Error("API key validator should not run for local-dev.");
        },
      });

      expect(verified).toMatchObject({
        kind: "local-dev",
        auth: {
          authMode: "local-dev",
          credentialType: "local_dev",
        },
      });
    } finally {
      if (originalAllowLocalDevAuth === undefined) {
        delete process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH;
      } else {
        process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = originalAllowLocalDevAuth;
      }
    }
  });

  test("accepts local-dev bearer on non-loopback hosts when explicitly enabled by env", async () => {
    // The dev stack binds 0.0.0.0 and is legitimately browsed over the LAN
    // (e.g. http://omarchy:3000): the EXPLICIT bearer plus the operator's
    // explicit env opt-in is the designed trust pair there — unlike the
    // missing-bearer path below, which stays loopback-only.
    process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = "1";

    try {
      const verified = await verifyPublicApiRequest({
        request: request({
          authorization: "Bearer local-dev",
          url: "http://omarchy:3000/api/world-demo/trusted-interactions",
        }),
        requiredScopes: ["tidegate:interaction:discover"],
        apiKeyValidator: async () => {
          throw new Error("API key validator should not run for local-dev.");
        },
      });

      expect(verified).toMatchObject({ kind: "local-dev" });
    } finally {
      if (originalAllowLocalDevAuth === undefined) {
        delete process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH;
      } else {
        process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = originalAllowLocalDevAuth;
      }
    }
  });

  test("the env opt-in is inert on production-like runtimes", async () => {
    // A TIDEGATE_ALLOW_LOCAL_DEV_AUTH leak into a production deployment must
    // not let arbitrary callers mint the local-dev credential.
    const originalNodeEnv = process.env.NODE_ENV;
    const originalVercelEnv = process.env.VERCEL_ENV;
    process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = "1";

    const attempt = () =>
      verifyPublicApiRequest({
        request: request({
          authorization: "Bearer local-dev",
          url: "https://tidegate.example.com/api/tidegate/v1/interactions",
        }),
        requiredScopes: ["tidegate:interaction:discover"],
        apiKeyValidator: async () => null,
      });

    try {
      process.env.NODE_ENV = "production";
      delete process.env.VERCEL_ENV;
      await expect(attempt()).rejects.toMatchObject({
        code: "invalid_api_key",
        status: 401,
      });

      process.env.NODE_ENV = originalNodeEnv ?? "test";
      process.env.VERCEL_ENV = "preview";
      await expect(attempt()).rejects.toMatchObject({
        code: "invalid_api_key",
        status: 401,
      });
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalVercelEnv === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = originalVercelEnv;
      }
      if (originalAllowLocalDevAuth === undefined) {
        delete process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH;
      } else {
        process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = originalAllowLocalDevAuth;
      }
    }
  });

  test("does not accept missing bearer on non-loopback even when local-dev auth is explicitly enabled", async () => {
    process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = "1";

    try {
      await expect(
        verifyPublicApiRequest({
          request: request({
            url: "http://100.90.84.33:3000/api/tidegate/v1/interactions",
          }),
          requiredScopes: ["tidegate:interaction:discover"],
          apiKeyValidator: async () => {
            throw new Error("API key validator should not run without a bearer.");
          },
        }),
      ).rejects.toMatchObject({
        code: "authentication_required",
        status: 401,
      });
    } finally {
      if (originalAllowLocalDevAuth === undefined) {
        delete process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH;
      } else {
        process.env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH = originalAllowLocalDevAuth;
      }
    }
  });

  test("rejects local-dev bearer outside loopback requests", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({ authorization: "Bearer local-dev" }),
        requiredScopes: ["tidegate:interaction:invoke"],
        allowLocalDev: true,
        apiKeyValidator: async () => null,
      }),
    ).rejects.toMatchObject({
      code: "invalid_api_key",
      status: 401,
    });
  });

  test("fails closed when M2M verifier is not configured", async () => {
    // A well-formed M2M token against an unconfigured deployment is an
    // operator problem, not a caller problem → 503, not 401 (D14). The
    // explicit empty config mirrors a deployment with no WORKOS_M2M_* env.
    await expect(
      verifyPublicApiRequest({
        request: request({ authorization: "Bearer header.payload.signature" }),
        requiredScopes: ["tidegate:interaction:invoke"],
        apiKeyValidator: async () => organizationApiKey,
        m2mVerifier: createWorkOsM2mVerifier({
          issuer: "",
          jwksUrl: "",
          audience: "",
          allowedOrgIds: [],
          allowedClientIds: [],
        }),
      }),
    ).rejects.toMatchObject({
      code: "unsupported_credential",
      status: 503,
    });
  });

  test("maps timed out WorkOS validation requests to auth provider unavailable", async () => {
    const slowFetch = Object.assign(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          const failIfAbortDoesNotFire = setTimeout(() => {
            reject(new Error("Test fetch was not aborted."));
          }, 100);

          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(failIfAbortDoesNotFire);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
      { preconnect: globalThis.fetch.preconnect },
    );

    const apiKeyValidator = createWorkOsApiKeyValidator({
      apiKey: "sk_test",
      timeoutMs: 1,
      fetchImpl: slowFetch,
    });

    await expect(
      verifyPublicApiRequest({
        request: request({ authorization: "Bearer evk_slow" }),
        requiredScopes: ["tidegate:interaction:invoke"],
        apiKeyValidator,
      }),
    ).rejects.toMatchObject({
      code: "auth_provider_unavailable",
      message: "WorkOS API key validation timed out after 1ms.",
      status: 503,
    });
  });
});

describe("verifyPublicApiRequest — WorkOS M2M", () => {
  // Real staging claim values from docs/auth/m2m-token-capture.md; only the
  // signing key is local (no network in tests).
  const M2M_ISSUER = "https://worthy-phantom-56-staging.authkit.app";
  const M2M_JWKS_URL = `${M2M_ISSUER}/oauth2/jwks`;
  const M2M_AUDIENCE = "client_01K3NHD5GT3KWSAB9ZV5M47B9D";
  const M2M_ORG_ID = "org_01KX6ZFWZPN8MVC4PMWGHH4ZFD";
  const M2M_CLIENT_ID = "client_01KX6ZJXT8RPBWGQAYYRDJDFFR";

  let m2mSigningKey: CryptoKey;
  let m2mJwks: JWTVerifyGetKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    m2mSigningKey = pair.privateKey as CryptoKey;
    const jwk = await exportJWK(pair.publicKey);
    m2mJwks = createLocalJWKSet({
      keys: [{ ...jwk, kid: "sso_oidc_key_pair_test", alg: "RS256" }],
    });
  });

  function m2mVerifier(
    overrides: Parameters<typeof createWorkOsM2mVerifier>[0] = {},
  ) {
    return createWorkOsM2mVerifier({
      issuer: M2M_ISSUER,
      jwksUrl: M2M_JWKS_URL,
      audience: M2M_AUDIENCE,
      allowedOrgIds: [M2M_ORG_ID],
      allowedClientIds: [M2M_CLIENT_ID],
      jwks: m2mJwks,
      ...overrides,
    });
  }

  async function m2mToken({
    scope = "tidegate:interaction:invoke",
    orgId = M2M_ORG_ID,
    expiresIn = 3600,
  }: {
    scope?: string;
    orgId?: string;
    expiresIn?: number;
  } = {}): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    return new SignJWT({ org_id: orgId, scope })
      .setProtectedHeader({ alg: "RS256", kid: "sso_oidc_key_pair_test" })
      .setIssuedAt(nowSec)
      .setIssuer(M2M_ISSUER)
      .setAudience(M2M_AUDIENCE)
      .setSubject(M2M_CLIENT_ID)
      .setExpirationTime(nowSec + expiresIn)
      .sign(m2mSigningKey);
  }

  test("verifies an allowlisted M2M token and maps it to TidegateAuthContext", async () => {
    const verified = await verifyPublicApiRequest({
      request: request({
        authorization: `Bearer ${await m2mToken()}`,
      }),
      requiredScopes: ["tidegate:interaction:invoke"],
      m2mVerifier: m2mVerifier(),
      apiKeyValidator: async () => {
        throw new Error("API key validator should not run for M2M tokens.");
      },
    });

    expect(verified).toMatchObject({
      kind: "workos-m2m",
      subjectId: M2M_CLIENT_ID,
      organizationId: M2M_ORG_ID,
      scopes: ["tidegate:interaction:invoke"],
      permissions: ["tidegate:interaction:invoke"],
      auth: {
        authMode: "m2m",
        organizationId: M2M_ORG_ID,
        orgId: M2M_ORG_ID,
        tenantId: M2M_ORG_ID,
        subjectId: M2M_CLIENT_ID,
        subjectType: "service_account",
        credentialId: M2M_CLIENT_ID,
        credentialType: "m2m_access_token",
        clientId: M2M_CLIENT_ID,
        machineClientId: M2M_CLIENT_ID,
      },
      audit: {
        credentialId: M2M_CLIENT_ID,
        ownerType: "m2m-client",
        ownerId: M2M_CLIENT_ID,
      },
    });
    // An M2M caller is not a human: it must never carry a user identity.
    expect(verified.auth.userId).toBeUndefined();
    expect(verified.auth.workosUserId).toBeUndefined();
  });

  test("rejects an M2M token missing the route scope, naming the scope (D12)", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: `Bearer ${await m2mToken({
            scope: "tidegate:interaction:discover",
          })}`,
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        m2mVerifier: m2mVerifier(),
      }),
    ).rejects.toMatchObject({
      code: "missing_required_scope",
      message:
        "The M2M token is missing required scope(s): tidegate:interaction:invoke.",
      status: 403,
      reason: "scope_not_granted",
    });
  });

  test("stripped non-tidegate scopes cannot satisfy a route scope (D5)", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: `Bearer ${await m2mToken({ scope: "*" })}`,
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        m2mVerifier: m2mVerifier(),
      }),
    ).rejects.toMatchObject({
      code: "missing_required_scope",
      status: 403,
    });
  });

  test("rejects an expired M2M token with the token_expired reason (D13)", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: `Bearer ${await m2mToken({ expiresIn: -3600 })}`,
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        m2mVerifier: m2mVerifier(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_credential",
      status: 401,
      reason: "token_expired",
    });
  });

  test("denies a token for an org outside the allowlist (fail-closed, D2)", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: `Bearer ${await m2mToken({ orgId: "org_foreign" })}`,
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        m2mVerifier: m2mVerifier(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_credential",
      status: 403,
    });
  });

  test("denies a client outside the allowlist (fail-closed, D2)", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: `Bearer ${await m2mToken()}`,
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        m2mVerifier: m2mVerifier({ allowedClientIds: ["client_other"] }),
      }),
    ).rejects.toMatchObject({
      code: "invalid_credential",
      status: 403,
    });
  });

  test("treats an unconfigured audience as verifier-not-configured (D6)", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: `Bearer ${await m2mToken()}`,
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        m2mVerifier: m2mVerifier({ audience: "" }),
      }),
    ).rejects.toMatchObject({
      code: "unsupported_credential",
      status: 503,
    });
  });

  test("treats empty allowlists as verifier-not-configured (allowlist REQUIRED posture)", async () => {
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: `Bearer ${await m2mToken()}`,
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        m2mVerifier: m2mVerifier({ allowedOrgIds: [] }),
      }),
    ).rejects.toMatchObject({
      code: "unsupported_credential",
      status: 503,
    });
  });

  test("maps an unreachable JWKS to auth_provider_unavailable (D9)", async () => {
    const unreachableVerifier = {
      configured: true,
      verify: async () => {
        throw new WorkOsM2mProviderUnavailableError(
          "WorkOS M2M JWKS verification is unavailable: fetch failed.",
        );
      },
    };

    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: `Bearer ${await m2mToken()}`,
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        m2mVerifier: unreachableVerifier,
      }),
    ).rejects.toMatchObject({
      code: "auth_provider_unavailable",
      status: 503,
    });
  });

  test("rejects a tampered M2M token with a generic invalid_credential", async () => {
    const [header, payload] = (await m2mToken()).split(".");
    await expect(
      verifyPublicApiRequest({
        request: request({
          authorization: `Bearer ${header}.${payload}.dGFtcGVyZWQ`,
        }),
        requiredScopes: ["tidegate:interaction:invoke"],
        m2mVerifier: m2mVerifier(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_credential",
      status: 401,
    });
  });
});

describe("createLocalDevAuthContext", () => {
  test("creates a scoped local development context", () => {
    expect(createLocalDevAuthContext()).toMatchObject({
      organizationId: "demo-salon",
      tenantId: "demo-salon",
      scopes: ["tidegate:interaction:*"],
      permissions: [
        "tidegate:interaction:*",
        "booking:write",
        "todo:read",
        "todo:write",
        "web:search",
      ],
      authMode: "local-dev",
    });
  });

  test("exports a typed auth error for route adapters", () => {
    const error = new PublicApiAuthError({
      code: "invalid_api_key",
      message: "Invalid API key.",
      status: 401,
    });

    expect(error).toMatchObject({
      name: "PublicApiAuthError",
      code: "invalid_api_key",
      status: 401,
    });
  });
});
