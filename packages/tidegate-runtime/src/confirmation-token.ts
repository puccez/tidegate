import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  ConfirmationTokenClaimsSchema,
  type ConfirmationTokenClaims,
} from "@tidegate/contracts";

/**
 * Kernel-side mint/verify for confirmation tokens (issue #24, slice 1).
 *
 * Tokens are stateless HMAC-SHA256 signed payloads:
 * `base64url(JSON(claims)) + "." + base64url(hmac)`. The signing secret lives
 * in server env only (`TIDEGATE_CONFIRMATION_SECRET`) and never crosses the
 * sandbox boundary: mint/verify run in `runtime.ts` before `execute()` is
 * ever called, and the sandbox execution payload never includes it.
 */

export const CONFIRMATION_SECRET_ENV = "TIDEGATE_CONFIRMATION_SECRET";
export const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000;

export const MISSING_CONFIRMATION_SECRET_MESSAGE =
  "Missing TIDEGATE_CONFIRMATION_SECRET; confirmation tokens cannot be minted or verified.";

// Local-dev fallback secret: random per process, never a published constant.
// The env gate below cannot prove locality (a non-Vercel staging box or an
// accidentally exposed dev server also satisfies it), so the secret itself
// must be unforgeable from outside: mint and verify always run in the same
// process, so they share this value, while a remote caller can never learn
// it. Tradeoff: a dev-server restart or module reload rotates the secret and
// invalidates pending confirmations — the client simply re-confirms.
let localDevConfirmationSecret: string | undefined;

// Top-level `undefined` is not JSON: JSON.stringify(undefined) yields the
// value `undefined` (which would throw when hashed) and must stay distinct
// from `null`. Normalize it to a sentinel no JSON value can produce.
const UNDEFINED_INPUT_SENTINEL = "\u0000tidegate:undefined\u0000";

type EnvMap = Record<string, string | undefined>;

let warnedAboutLocalDevConfirmationSecret = false;

/**
 * Resolves the confirmation signing secret. Used by BOTH mint and verify so
 * they can never diverge.
 *
 * Fail-closed: without `TIDEGATE_CONFIRMATION_SECRET` this throws unless the
 * local-dev fallback is explicitly opted into via
 * `TIDEGATE_ALLOW_LOCAL_DEV_AUTH=1`. The fallback secret is generated
 * randomly per process (unlike the request-path local-dev auth, no request
 * is in scope here, so a loopback check is impossible — an unguessable
 * secret is the substitute for proof of locality). The fallback is still
 * refused on any deployment platform (any `VERCEL`/`VERCEL_ENV` value,
 * including previews) and on `NODE_ENV=production`, mirroring
 * `isProductionLikeRuntime()` in `@tidegate/auth-server`.
 */
export function resolveConfirmationSecret(env: EnvMap = process.env): string {
  const secret = env[CONFIRMATION_SECRET_ENV];

  if (secret !== undefined && secret !== "") {
    return secret;
  }

  if (
    env.VERCEL === undefined &&
    env.VERCEL_ENV === undefined &&
    env.NODE_ENV !== "production" &&
    env.TIDEGATE_ALLOW_LOCAL_DEV_AUTH === "1"
  ) {
    if (!warnedAboutLocalDevConfirmationSecret) {
      warnedAboutLocalDevConfirmationSecret = true;
      console.warn(
        "[tidegate] TIDEGATE_CONFIRMATION_SECRET is not set; using an ephemeral per-process dev confirmation secret because TIDEGATE_ALLOW_LOCAL_DEV_AUTH=1. Pending confirmations will not survive a restart. Generate a real secret with `openssl rand -hex 32` before deploying.",
      );
    }

    localDevConfirmationSecret ??= randomBytes(32).toString("hex");
    return localDevConfirmationSecret;
  }

  throw new Error(MISSING_CONFIRMATION_SECRET_MESSAGE);
}

/** Test-only helper so the one-time dev-secret warning can be asserted. */
export function resetConfirmationSecretWarningForTests(): void {
  warnedAboutLocalDevConfirmationSecret = false;
}

/**
 * Canonical JSON with sorted object keys, shared by the confirmation input
 * hash and the idempotency ledger input hash so both bind the same bytes.
 *
 * Mirrors `JSON.stringify` semantics for non-JSON values so a hash taken
 * in-process matches the same value after a JSON round-trip (e.g. a re-POSTed
 * request body): object properties whose values serialize to nothing
 * (`undefined`, functions, symbols) are omitted, such array elements become
 * `null`, and a top-level such value serializes as `"null"`.
 */
export function stableJson(value: unknown): string {
  return stableJsonOrOmitted(value) ?? "null";
}

/** `undefined` means "omit this value", exactly like `JSON.stringify`. */
function stableJsonOrOmitted(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => stableJsonOrOmitted(item) ?? "null")
      .join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries: string[] = [];

    for (const key of Object.keys(record).sort()) {
      const serialized = stableJsonOrOmitted(record[key]);

      if (serialized !== undefined) {
        entries.push(`${JSON.stringify(key)}:${serialized}`);
      }
    }

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

/** SHA-256 over the stable JSON serialization: `sha256:<hex>`. */
export function hashConfirmationInput(input: unknown): string {
  const serialized =
    input === undefined ? UNDEFINED_INPUT_SENTINEL : stableJson(input);

  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

export type ConfirmationTokenBinding = Omit<
  ConfirmationTokenClaims,
  "v" | "expiresAtMs"
>;

export type VerifyConfirmationTokenResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "mismatch" };

export function mintConfirmationToken({
  claims,
  secret,
}: {
  claims: ConfirmationTokenClaims;
  secret: string;
}): string {
  // Defense in depth: an empty HMAC key would make every token forgeable by
  // anyone who knows the key is empty. Never sign with one.
  if (secret === "") {
    throw new Error(MISSING_CONFIRMATION_SECRET_MESSAGE);
  }

  // Rejects malformed claims, including an empty subject (min length 1).
  const parsedClaims = ConfirmationTokenClaimsSchema.parse(claims);
  const payload = Buffer.from(JSON.stringify(parsedClaims), "utf8").toString(
    "base64url",
  );

  return `${payload}.${signConfirmationPayload(payload, secret)}`;
}

/**
 * Verify order: structural parse -> timing-safe HMAC compare -> expiry
 * (`nowMs >= expiresAtMs` means expired) -> field binding. Any parse or
 * compare failure (including `timingSafeEqual` throwing on byte-length
 * mismatch) maps to `invalid`.
 */
export function verifyConfirmationToken({
  expected,
  nowMs,
  secret,
  token,
}: {
  expected: ConfirmationTokenBinding;
  nowMs: number;
  secret: string;
  token: string;
}): VerifyConfirmationTokenResult {
  if (secret === "") {
    // Defense in depth: never accept a token signed with an empty HMAC key.
    return { ok: false, reason: "invalid" };
  }

  if (expected.subject === "") {
    // A token is never minted for an empty subject; refuse to verify one.
    return { ok: false, reason: "invalid" };
  }

  let claims: ConfirmationTokenClaims;

  try {
    const separatorIndex = token.indexOf(".");

    if (
      separatorIndex <= 0 ||
      separatorIndex === token.length - 1 ||
      token.indexOf(".", separatorIndex + 1) !== -1
    ) {
      return { ok: false, reason: "invalid" };
    }

    const payload = token.slice(0, separatorIndex);
    const signature = token.slice(separatorIndex + 1);
    const parsedClaims = ConfirmationTokenClaimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );

    if (!parsedClaims.success) {
      return { ok: false, reason: "invalid" };
    }

    const expectedSignature = Buffer.from(
      signConfirmationPayload(payload, secret),
      "utf8",
    );
    const providedSignature = Buffer.from(signature, "utf8");

    if (
      providedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(providedSignature, expectedSignature)
    ) {
      return { ok: false, reason: "invalid" };
    }

    claims = parsedClaims.data;
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (nowMs >= claims.expiresAtMs) {
    return { ok: false, reason: "expired" };
  }

  if (
    claims.interactionId !== expected.interactionId ||
    claims.interactionVersion !== expected.interactionVersion ||
    claims.inputHash !== expected.inputHash ||
    claims.subject !== expected.subject ||
    claims.tenant !== expected.tenant ||
    claims.sessionId !== expected.sessionId
  ) {
    return { ok: false, reason: "mismatch" };
  }

  return { ok: true };
}

function signConfirmationPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64url");
}
