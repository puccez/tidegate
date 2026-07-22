export type PublicApiAuthErrorCode =
  | "authentication_required"
  | "invalid_authorization_header"
  | "invalid_api_key"
  | "invalid_credential"
  | "missing_required_scope"
  | "unsupported_credential"
  | "auth_provider_unavailable";

/**
 * Safe, self-fixable reason sub-codes (RFC 6750 spirit, gate decision D13).
 * Deliberately limited to the cases a caller can act on; signature/issuer/
 * audience failures stay behind the generic code so the error surface never
 * leaks verifier configuration.
 */
export type PublicApiAuthErrorReason = "token_expired" | "scope_not_granted";

export class PublicApiAuthError extends Error {
  readonly code: PublicApiAuthErrorCode;
  readonly status: 401 | 403 | 503;
  readonly reason?: PublicApiAuthErrorReason;

  constructor({
    code,
    message,
    status,
    reason,
  }: {
    code: PublicApiAuthErrorCode;
    message: string;
    status: 401 | 403 | 503;
    reason?: PublicApiAuthErrorReason;
  }) {
    super(message);
    this.name = "PublicApiAuthError";
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

export function isPublicApiAuthError(error: unknown): error is PublicApiAuthError {
  return error instanceof PublicApiAuthError;
}
