import type { EffectClass } from "@tidegate/contracts";
import type { RuntimeAuthContext, RuntimeTenantScope } from "./action-catalog.ts";

const INTERACTION_ACTION_EFFECT_RANK: Record<EffectClass, number> = {
  read: 0,
  write: 1,
  external: 2,
  destructive: 3,
};

export function interactionActionEffectExceedsDeclared({
  actionEffect,
  declaredEffect,
}: {
  actionEffect: EffectClass;
  declaredEffect: EffectClass;
}): boolean {
  return (
    INTERACTION_ACTION_EFFECT_RANK[actionEffect] >
    INTERACTION_ACTION_EFFECT_RANK[declaredEffect]
  );
}

export function interactionActionRequiresTenantScope(
  effect: EffectClass,
): boolean {
  return effect !== "read";
}

export function interactionTenantScopeAllowsAuth({
  auth,
  tenantScope,
}: {
  auth: RuntimeAuthContext;
  tenantScope: RuntimeTenantScope | undefined;
}): boolean {
  if (!tenantScope) {
    return false;
  }

  let hasTenantConstraint = false;

  if (tenantScope.fromAuth !== undefined) {
    hasTenantConstraint = true;

    if (authTenantScopeValue(auth, tenantScope.fromAuth) === undefined) {
      return false;
    }
  }

  if (tenantScope.tenantId !== undefined) {
    hasTenantConstraint = true;

    const authTenantIds = new Set(
      [auth.tenantId, auth.organizationId, auth.orgId].filter(
        (value): value is string => value !== undefined,
      ),
    );

    if (!authTenantIds.has(tenantScope.tenantId)) {
      return false;
    }
  }

  if (tenantScope.salonId !== undefined) {
    hasTenantConstraint = true;

    if (auth.salonId !== tenantScope.salonId) {
      return false;
    }
  }

  return hasTenantConstraint;
}

/**
 * Subject fallback chain shared by the idempotency scope, the
 * confirmation-token binding, and the policy engine's confirmation rules so
 * all of them identify the same actor.
 */
export function resolveAuthSubject(auth: RuntimeAuthContext): string {
  return (
    auth.subjectId ??
    auth.userId ??
    auth.workosUserId ??
    auth.machineClientId ??
    auth.clientId ??
    auth.credentialId ??
    ""
  );
}

/**
 * Tenant fallback chain shared by the idempotency scope and the
 * confirmation-token binding. Includes `salonId` because the runtime treats
 * it as a tenant identifier elsewhere (`interactionTenantScopeAllowsAuth()`,
 * registry ownership); omitting it would bind `tenant: ""` for salon-only
 * auth contexts and let a token minted in one salon verify in another.
 */
export function resolveAuthTenant(auth: RuntimeAuthContext): string {
  return (
    auth.tenantId ?? auth.organizationId ?? auth.orgId ?? auth.salonId ?? ""
  );
}

export function collectInteractionAuthPermissions(
  auth: RuntimeAuthContext,
): string[] {
  return uniqueStrings([
    ...(auth.permissions ?? []),
    ...(auth.authorization?.permissions ?? []),
  ]);
}

export function collectInteractionAuthGrants(auth: RuntimeAuthContext): string[] {
  return uniqueStrings([
    ...(auth.scopes ?? []),
    ...collectInteractionAuthPermissions(auth),
  ]);
}

function authTenantScopeValue(
  auth: RuntimeAuthContext,
  source: NonNullable<RuntimeTenantScope["fromAuth"]>,
): string | undefined {
  switch (source) {
    case "tenantId":
      return auth.tenantId;
    case "organizationId":
      return auth.organizationId;
    case "orgId":
      return auth.orgId;
    case "salonId":
      return auth.salonId;
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
