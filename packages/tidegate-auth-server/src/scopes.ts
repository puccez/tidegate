export function hasRequiredScopes({
  grantedScopes,
  requiredScopes,
}: {
  grantedScopes: string[];
  requiredScopes: string[];
}): boolean {
  return requiredScopes.every((requiredScope) =>
    grantedScopes.some((grantedScope) =>
      scopeAllows({ grantedScope, requiredScope }),
    ),
  );
}

export function scopeAllows({
  grantedScope,
  requiredScope,
}: {
  grantedScope: string;
  requiredScope: string;
}): boolean {
  if (grantedScope === "*" || grantedScope === requiredScope) {
    return true;
  }

  if (!grantedScope.endsWith(":*")) {
    return false;
  }

  return requiredScope.startsWith(grantedScope.slice(0, -1));
}
