import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { ConfirmationTokenClaims } from "@tidegate/contracts";
import {
  CONFIRMATION_TOKEN_TTL_MS,
  hashConfirmationInput,
  mintConfirmationToken,
  resetConfirmationSecretWarningForTests,
  resolveConfirmationSecret,
  stableJson,
  verifyConfirmationToken,
  type ConfirmationTokenBinding,
} from "./confirmation-token";

const SECRET = "confirmation-token-test-secret";
const NOW_MS = 1_750_000_000_000;

const binding: ConfirmationTokenBinding = {
  interactionId: "ix.booking.cancelAppointment",
  interactionVersion: "1",
  inputHash: hashConfirmationInput({ appointmentId: "apt_123" }),
  subject: "demo-user",
  tenant: "demo-salon",
  sessionId: "sess_demo",
};

function claims(
  overrides: Partial<ConfirmationTokenClaims> = {},
): ConfirmationTokenClaims {
  return {
    v: 1,
    ...binding,
    expiresAtMs: NOW_MS + CONFIRMATION_TOKEN_TTL_MS,
    ...overrides,
  };
}

function mint(overrides: Partial<ConfirmationTokenClaims> = {}): string {
  return mintConfirmationToken({ claims: claims(overrides), secret: SECRET });
}

describe("mintConfirmationToken / verifyConfirmationToken", () => {
  test("round-trips with a matching binding and a fixed clock", () => {
    const token = mint();

    expect(
      verifyConfirmationToken({
        expected: binding,
        nowMs: NOW_MS,
        secret: SECRET,
        token,
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a tampered signature as invalid", () => {
    const token = mint();
    const [payload, signature] = token.split(".");
    const flipped = signature!.startsWith("A") ? "B" : "A";
    const tampered = `${payload}.${flipped}${signature!.slice(1)}`;

    expect(
      verifyConfirmationToken({
        expected: binding,
        nowMs: NOW_MS,
        secret: SECRET,
        token: tampered,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("rejects a signature segment of a different byte length as invalid, not a throw", () => {
    const token = mint();
    const [payload] = token.split(".");
    const shortSignature = `${payload}.abc`;

    expect(() =>
      verifyConfirmationToken({
        expected: binding,
        nowMs: NOW_MS,
        secret: SECRET,
        token: shortSignature,
      }),
    ).not.toThrow();
    expect(
      verifyConfirmationToken({
        expected: binding,
        nowMs: NOW_MS,
        secret: SECRET,
        token: shortSignature,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("rejects a token signed with a different secret as invalid", () => {
    const token = mintConfirmationToken({
      claims: claims(),
      secret: "another-secret",
    });

    expect(
      verifyConfirmationToken({
        expected: binding,
        nowMs: NOW_MS,
        secret: SECRET,
        token,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("rejects structural garbage as invalid", () => {
    for (const token of ["", "no-separator", ".", "a.", ".b", "a.b.c"]) {
      expect(
        verifyConfirmationToken({
          expected: binding,
          nowMs: NOW_MS,
          secret: SECRET,
          token,
        }),
      ).toEqual({ ok: false, reason: "invalid" });
    }
  });

  test("treats nowMs === expiresAtMs as expired and nowMs < expiresAtMs as live", () => {
    const expiresAtMs = NOW_MS + CONFIRMATION_TOKEN_TTL_MS;
    const token = mint({ expiresAtMs });

    expect(
      verifyConfirmationToken({
        expected: binding,
        nowMs: expiresAtMs,
        secret: SECRET,
        token,
      }),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      verifyConfirmationToken({
        expected: binding,
        nowMs: expiresAtMs - 1,
        secret: SECRET,
        token,
      }),
    ).toEqual({ ok: true });
  });

  test("rejects each wrong binding field as mismatch", () => {
    const token = mint();
    const wrongBindings: ConfirmationTokenBinding[] = [
      { ...binding, interactionId: "ix.booking.other" },
      { ...binding, interactionVersion: "2" },
      { ...binding, inputHash: hashConfirmationInput({ other: true }) },
      { ...binding, subject: "another-user" },
      { ...binding, tenant: "another-salon" },
      { ...binding, sessionId: "sess_other" },
    ];

    for (const expected of wrongBindings) {
      expect(
        verifyConfirmationToken({
          expected,
          nowMs: NOW_MS,
          secret: SECRET,
          token,
        }),
      ).toEqual({ ok: false, reason: "mismatch" });
    }
  });

  test("refuses to mint claims with an empty subject", () => {
    expect(() => mint({ subject: "" })).toThrow();
  });

  test("refuses to verify against an empty expected subject", () => {
    const token = mint();

    expect(
      verifyConfirmationToken({
        expected: { ...binding, subject: "" },
        nowMs: NOW_MS,
        secret: SECRET,
        token,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("refuses to mint with an empty secret", () => {
    expect(() =>
      mintConfirmationToken({ claims: claims(), secret: "" }),
    ).toThrow(
      "Missing TIDEGATE_CONFIRMATION_SECRET; confirmation tokens cannot be minted or verified.",
    );
  });

  test("refuses to verify with an empty secret, even a token HMAC'd with an empty key", () => {
    // Forge what a broken mint-with-empty-key would have produced.
    const payload = Buffer.from(JSON.stringify(claims()), "utf8").toString(
      "base64url",
    );
    const emptyKeySignature = createHmac("sha256", "")
      .update(payload, "utf8")
      .digest("base64url");
    const forged = `${payload}.${emptyKeySignature}`;

    for (const token of [forged, mint()]) {
      expect(
        verifyConfirmationToken({
          expected: binding,
          nowMs: NOW_MS,
          secret: "",
          token,
        }),
      ).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("hashConfirmationInput", () => {
  test("is deterministic and distinct for undefined, null, {}, [], and a populated object", () => {
    const inputs = [undefined, null, {}, [], { appointmentId: "apt_123" }];
    const hashes = inputs.map((input) => hashConfirmationInput(input));

    for (const [index, input] of inputs.entries()) {
      expect(hashConfirmationInput(input)).toBe(hashes[index]!);
      expect(hashes[index]).toStartWith("sha256:");
    }
    expect(new Set(hashes).size).toBe(inputs.length);
  });

  test("never throws on undefined input", () => {
    expect(() => hashConfirmationInput(undefined)).not.toThrow();
  });

  test("is stable across object key ordering", () => {
    expect(hashConfirmationInput({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashConfirmationInput({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  test("mirrors JSON.stringify for nested undefined: omitted in objects, null in arrays", () => {
    expect(hashConfirmationInput({ x: undefined })).toBe(
      hashConfirmationInput({}),
    );
    expect(hashConfirmationInput({ a: 1, x: undefined })).toBe(
      hashConfirmationInput({ a: 1 }),
    );
    expect(hashConfirmationInput([undefined])).toBe(
      hashConfirmationInput([null]),
    );
    expect(hashConfirmationInput({ items: [1, undefined, 3] })).toBe(
      hashConfirmationInput({ items: [1, null, 3] }),
    );
  });

  test("is stable across a JSON round-trip", () => {
    const inputs: unknown[] = [
      { a: 1, x: undefined, nested: { y: undefined, z: [undefined, 2] } },
      [undefined, { q: undefined }],
      { appointmentId: "apt_123" },
    ];

    for (const input of inputs) {
      expect(hashConfirmationInput(input)).toBe(
        hashConfirmationInput(JSON.parse(JSON.stringify(input))),
      );
    }
  });

  test("stableJson serializes a top-level undefined as null, but hashConfirmationInput keeps the distinct sentinel", () => {
    expect(stableJson(undefined)).toBe("null");
    expect(hashConfirmationInput(undefined)).not.toBe(
      hashConfirmationInput(null),
    );
  });
});

describe("resolveConfirmationSecret", () => {
  afterEach(() => {
    resetConfirmationSecretWarningForTests();
  });

  test("returns the configured secret", () => {
    expect(
      resolveConfirmationSecret({ TIDEGATE_CONFIRMATION_SECRET: "configured" }),
    ).toBe("configured");
  });

  test("throws without a secret and without the explicit local-dev opt-in", () => {
    expect(() => resolveConfirmationSecret({})).toThrow(
      "Missing TIDEGATE_CONFIRMATION_SECRET; confirmation tokens cannot be minted or verified.",
    );
  });

  test("throws on any deployment platform even when the local-dev flag is set", () => {
    const deployedEnvs = [
      { VERCEL_ENV: "production" },
      { VERCEL_ENV: "preview" },
      { VERCEL_ENV: "development" },
      { VERCEL: "1" },
      { NODE_ENV: "production" },
    ];

    for (const deployedEnv of deployedEnvs) {
      expect(() =>
        resolveConfirmationSecret({
          TIDEGATE_ALLOW_LOCAL_DEV_AUTH: "1",
          ...deployedEnv,
        }),
      ).toThrow(
        "Missing TIDEGATE_CONFIRMATION_SECRET; confirmation tokens cannot be minted or verified.",
      );
    }
  });

  test("a configured secret still wins on deployment platforms", () => {
    expect(
      resolveConfirmationSecret({
        TIDEGATE_CONFIRMATION_SECRET: "configured",
        VERCEL_ENV: "preview",
      }),
    ).toBe("configured");
  });

  test("local-dev fallback requires TIDEGATE_ALLOW_LOCAL_DEV_AUTH=1, warns once, and round-trips mint/verify", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    resetConfirmationSecretWarningForTests();

    try {
      const env = { TIDEGATE_ALLOW_LOCAL_DEV_AUTH: "1" };
      const mintSecret = resolveConfirmationSecret(env);
      const verifySecret = resolveConfirmationSecret(env);

      expect(mintSecret).toBe(verifySecret);
      expect(warn).toHaveBeenCalledTimes(1);

      // The env gate cannot prove locality, so the fallback must never be a
      // published constant a remote caller could sign with: it is a random
      // per-process value (stable within the process so mint/verify agree).
      expect(mintSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(mintSecret).not.toBe(
        "tidegate-insecure-local-dev-confirmation-secret",
      );

      const token = mintConfirmationToken({
        claims: claims(),
        secret: mintSecret,
      });
      expect(
        verifyConfirmationToken({
          expected: binding,
          nowMs: NOW_MS,
          secret: verifySecret,
          token,
        }),
      ).toEqual({ ok: true });
    } finally {
      warn.mockRestore();
    }
  });
});
