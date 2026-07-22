import type {
  InteractionDraft,
  InteractionRecord,
  InteractionVisibility,
} from "@tidegate/contracts";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import { InteractionRegistryError } from "./interaction-registry-errors.ts";

export type InteractionRegistryScope = {
  visibility: InteractionVisibility;
  ownerTenantId?: string;
  ownerOrganizationId?: string;
  ownerUserId?: string;
  appId?: string;
};

export type InteractionDraftRegistryScope = {
  ownerTenantId?: string;
  ownerOrganizationId?: string;
  ownerUserId?: string;
  appId?: string;
};

export type InteractionOwnerField =
  | "ownerTenantId"
  | "ownerOrganizationId"
  | "ownerUserId";

export const INTERACTION_VISIBILITIES: InteractionVisibility[] = [
  "user",
  "tenant",
  "organization",
  "app",
];

export const OWNER_FIELD_NAMES: InteractionOwnerField[] = [
  "ownerTenantId",
  "ownerOrganizationId",
  "ownerUserId",
];

export function deriveInteractionRegistryScope(
  auth: RuntimeAuthContext,
  visibility: InteractionVisibility,
): InteractionRegistryScope {
  const ownerTenantId = firstPresent(auth.tenantId, auth.salonId);
  const ownerOrganizationId = firstPresent(auth.organizationId, auth.orgId);
  const ownerUserId = firstPresent(
    auth.userId,
    auth.workosUserId,
    auth.subjectType === "user" ? auth.subjectId : undefined,
  );
  const appId = firstPresent(
    auth.clientId,
    auth.machineClientId,
    auth.subjectType === "api_key" ? auth.credentialId : undefined,
    auth.subjectType === "service_account" ? auth.subjectId : undefined,
  );

  switch (visibility) {
    case "user":
      requireScopeValue("user", "userId", ownerUserId);
      return {
        visibility,
        ownerTenantId,
        ownerOrganizationId,
        ownerUserId,
      };
    case "tenant":
      requireScopeValue("tenant", "tenantId", ownerTenantId);
      return {
        visibility,
        ownerTenantId,
        ownerOrganizationId,
      };
    case "organization":
      requireScopeValue("organization", "organizationId", ownerOrganizationId);
      return {
        visibility,
        ownerOrganizationId,
      };
    case "app":
      requireScopeValue("app", "clientId or machineClientId", appId);
      return {
        visibility,
        ownerTenantId,
        ownerOrganizationId,
        appId,
      };
  }
}

export function deriveInteractionDraftRegistryScope(
  auth: RuntimeAuthContext,
): InteractionDraftRegistryScope {
  const scope = {
    ownerTenantId: firstPresent(auth.tenantId, auth.salonId),
    ownerOrganizationId: firstPresent(auth.organizationId, auth.orgId),
    ownerUserId: firstPresent(
      auth.userId,
      auth.workosUserId,
      auth.subjectType === "user" ? auth.subjectId : undefined,
    ),
    appId: firstPresent(
      auth.clientId,
      auth.machineClientId,
      auth.subjectType === "api_key" ? auth.credentialId : undefined,
      auth.subjectType === "service_account" ? auth.subjectId : undefined,
    ),
  };

  if (
    scope.ownerTenantId === undefined &&
    scope.ownerOrganizationId === undefined &&
    scope.ownerUserId === undefined
  ) {
    throw new InteractionRegistryError(
      "scope_unavailable",
      "Cannot create or resolve an interaction draft without tenantId, organizationId, or userId in auth.",
    );
  }

  return scope;
}

export function interactionRegistryScopeFromDraftScope(
  scope: InteractionDraftRegistryScope,
  visibility: InteractionVisibility,
): InteractionRegistryScope {
  switch (visibility) {
    case "user":
      requireScopeValue("user", "userId", scope.ownerUserId);
      return {
        visibility,
        ownerTenantId: scope.ownerTenantId,
        ownerOrganizationId: scope.ownerOrganizationId,
        ownerUserId: scope.ownerUserId,
      };
    case "tenant":
      requireScopeValue("tenant", "tenantId", scope.ownerTenantId);
      return {
        visibility,
        ownerTenantId: scope.ownerTenantId,
        ownerOrganizationId: scope.ownerOrganizationId,
      };
    case "organization":
      requireScopeValue("organization", "organizationId", scope.ownerOrganizationId);
      return {
        visibility,
        ownerOrganizationId: scope.ownerOrganizationId,
      };
    case "app":
      requireScopeValue("app", "clientId or machineClientId", scope.appId);
      return {
        visibility,
        ownerTenantId: scope.ownerTenantId,
        ownerOrganizationId: scope.ownerOrganizationId,
        appId: scope.appId,
      };
  }
}

export function interactionScopeKey(scope: InteractionRegistryScope) {
  return JSON.stringify([
    scope.visibility,
    scope.ownerTenantId ?? null,
    scope.ownerOrganizationId ?? null,
    scope.ownerUserId ?? null,
    scope.appId ?? null,
  ]);
}

export function interactionRecordKey(
  scope: InteractionRegistryScope,
  interactionId: string,
) {
  return JSON.stringify([interactionScopeKey(scope), interactionId]);
}

export function interactionDraftKey(
  scope: InteractionDraftRegistryScope,
  draftId: string,
) {
  return JSON.stringify([
    scope.ownerTenantId ?? null,
    scope.ownerOrganizationId ?? null,
    scope.ownerUserId ?? null,
    scope.appId ?? null,
    draftId,
  ]);
}

export function interactionBranchKey(
  scope: InteractionDraftRegistryScope,
  branchId: string,
) {
  return JSON.stringify([
    scope.ownerTenantId ?? null,
    scope.ownerOrganizationId ?? null,
    scope.ownerUserId ?? null,
    scope.appId ?? null,
    branchId,
  ]);
}

export function ownerFieldsForScope(scope: InteractionRegistryScope) {
  const fields: Partial<Pick<InteractionRecord, InteractionOwnerField>> = {};

  if (scope.ownerTenantId !== undefined) {
    fields.ownerTenantId = scope.ownerTenantId;
  }

  if (scope.ownerOrganizationId !== undefined) {
    fields.ownerOrganizationId = scope.ownerOrganizationId;
  }

  if (scope.ownerUserId !== undefined) {
    fields.ownerUserId = scope.ownerUserId;
  }

  return fields;
}

export function draftOwnerFieldsForScope(
  scope: InteractionDraftRegistryScope,
) {
  const fields: Partial<Pick<InteractionDraft, InteractionOwnerField>> = {};

  if (scope.ownerTenantId !== undefined) {
    fields.ownerTenantId = scope.ownerTenantId;
  }

  if (scope.ownerOrganizationId !== undefined) {
    fields.ownerOrganizationId = scope.ownerOrganizationId;
  }

  if (scope.ownerUserId !== undefined) {
    fields.ownerUserId = scope.ownerUserId;
  }

  return fields;
}

export function assertNoCallerSuppliedOwnerFields(
  value: object,
  label: string,
) {
  const record = value as Record<string, unknown>;

  for (const ownerField of OWNER_FIELD_NAMES) {
    if (ownerField in record) {
      throw new InteractionRegistryError(
        "owner_scope_from_body",
        `Do not pass ${ownerField} on ${label}; owner scope is derived from auth.`,
      );
    }
  }
}

export function createdBySubjectIdFromAuth(auth: RuntimeAuthContext) {
  const subjectId = firstPresent(
    auth.subjectId,
    auth.userId,
    auth.workosUserId,
    auth.clientId,
    auth.machineClientId,
    auth.credentialId,
  );

  if (subjectId === undefined) {
    throw new InteractionRegistryError(
      "scope_unavailable",
      "Cannot create an artifact without a subjectId, userId, clientId, machineClientId, or credentialId in auth.",
    );
  }

  return subjectId;
}

function requireScopeValue(
  visibility: InteractionVisibility,
  label: string,
  value: string | undefined,
) {
  if (value === undefined) {
    throw new InteractionRegistryError(
      "scope_unavailable",
      `Cannot use ${visibility} interaction visibility without ${label} in auth.`,
    );
  }
}

function firstPresent(...values: Array<string | undefined>) {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
