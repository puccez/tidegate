import { PublicApiAuthError } from "./errors.ts";

export function extractBearerToken(
  authorizationHeader: string | null,
): string {
  if (!authorizationHeader) {
    throw new PublicApiAuthError({
      code: "authentication_required",
      message: "Missing Authorization bearer token.",
      status: 401,
    });
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);

  if (!match?.[1]?.trim()) {
    throw new PublicApiAuthError({
      code: "invalid_authorization_header",
      message: "Authorization header must use the Bearer scheme.",
      status: 401,
    });
  }

  return match[1].trim();
}

export function isJwtShapedCredential(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}
