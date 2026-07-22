import { describe, expect, test } from "bun:test";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import { InteractionRegistryError } from "./interaction-registry-errors.ts";
import {
  assertNoCallerSuppliedOwnerFields,
  createdBySubjectIdFromAuth,
  deriveInteractionDraftRegistryScope,
  deriveInteractionRegistryScope,
  interactionRecordKey,
  ownerFieldsForScope,
} from "./interaction-registry-scope.ts";

const auth: RuntimeAuthContext = {
  authMode: "user",
  credentialId: "cred_scope",
  credentialType: "session",
  organizationId: "org_scope",
  orgId: "org_scope",
  permissions: [],
  scopes: [],
  subjectId: "user_scope",
  subjectType: "user",
  tenantId: "tenant_scope",
  userId: "user_scope",
  workosUserId: "user_scope",
  authorization: {
    permissions: [],
    resourceGrants: [],
  },
};

describe("interaction registry scope", () => {
  test("derives scoped owners for public interaction visibility", () => {
    const userScope = deriveInteractionRegistryScope(auth, "user");
    const tenantScope = deriveInteractionRegistryScope(auth, "tenant");
    const organizationScope = deriveInteractionRegistryScope(
      auth,
      "organization",
    );

    expect(userScope).toEqual({
      visibility: "user",
      ownerTenantId: "tenant_scope",
      ownerOrganizationId: "org_scope",
      ownerUserId: "user_scope",
    });
    expect(tenantScope).toEqual({
      visibility: "tenant",
      ownerTenantId: "tenant_scope",
      ownerOrganizationId: "org_scope",
    });
    expect(organizationScope).toEqual({
      visibility: "organization",
      ownerOrganizationId: "org_scope",
    });
    expect(ownerFieldsForScope(userScope)).toEqual({
      ownerTenantId: "tenant_scope",
      ownerOrganizationId: "org_scope",
      ownerUserId: "user_scope",
    });
    expect(interactionRecordKey(userScope, "ix.scope")).toContain("ix.scope");
  });

  test("derives draft scope and artifact creator identity from auth", () => {
    expect(deriveInteractionDraftRegistryScope(auth)).toEqual({
      appId: undefined,
      ownerTenantId: "tenant_scope",
      ownerOrganizationId: "org_scope",
      ownerUserId: "user_scope",
    });
    expect(createdBySubjectIdFromAuth(auth)).toBe("user_scope");
  });

  test("rejects missing required scope values and caller-supplied owner fields", () => {
    expect(() =>
      deriveInteractionRegistryScope(
        {
          ...auth,
          userId: undefined,
          workosUserId: undefined,
          subjectType: "api_key",
        },
        "user",
      ),
    ).toThrow(InteractionRegistryError);
    expect(() =>
      assertNoCallerSuppliedOwnerFields(
        { ownerTenantId: "tenant_scope" },
        "published artifact",
      ),
    ).toThrow(
      'Do not pass ownerTenantId on published artifact; owner scope is derived from auth.',
    );
  });
});
