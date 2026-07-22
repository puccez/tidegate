import { z } from "zod";

/**
 * Claims signed into a kernel-minted confirmation token.
 *
 * Pure data contract: this package stays isomorphic/edge-safe, so no crypto
 * lives here. Minting and verification (HMAC-SHA256 over these claims) are
 * implemented in `@tidegate/runtime`.
 *
 * The binding is (interactionId, interactionVersion, inputHash, subject,
 * tenant, sessionId, expiry): a minted token authorizes exactly the request
 * the user saw, for the same actor, tenant, and session.
 */
export const ConfirmationTokenClaimsSchema = z
  .object({
    v: z.literal(1),
    interactionId: z.string().min(1),
    interactionVersion: z.string().min(1),
    inputHash: z.string().min(1),
    subject: z.string().min(1),
    tenant: z.string(),
    sessionId: z.string().min(1),
    expiresAtMs: z.number().int().nonnegative(),
  })
  .strict();

export type ConfirmationTokenClaims = z.infer<
  typeof ConfirmationTokenClaimsSchema
>;
