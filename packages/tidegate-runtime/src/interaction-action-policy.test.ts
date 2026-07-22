import { describe, expect, test } from "bun:test";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import {
  collectInteractionAuthGrants,
  collectInteractionAuthPermissions,
  interactionActionEffectExceedsDeclared,
  interactionActionRequiresTenantScope,
  interactionTenantScopeAllowsAuth,
} from "./interaction-action-policy.ts";

const baseAuth: RuntimeAuthContext = {
  authMode: "api-key",
  credentialId: "api_key_policy",
  credentialType: "api_key",
  organizationId: "demo-salon",
  orgId: "demo-salon",
  tenantId: "demo-salon",
  salonId: "salon_123",
  subjectId: "api_key_policy",
  subjectType: "api_key",
  scopes: ["tidegate:interaction:invoke", "booking:read"],
  permissions: ["booking:write"],
  authorization: {
    permissions: ["booking:refund"],
    resourceGrants: [],
  },
};

describe("interaction action policy", () => {
  test("compares action effects against declared interaction effects", () => {
    expect(
      interactionActionEffectExceedsDeclared({
        actionEffect: "write",
        declaredEffect: "read",
      }),
    ).toBe(true);
    expect(
      interactionActionEffectExceedsDeclared({
        actionEffect: "write",
        declaredEffect: "destructive",
      }),
    ).toBe(false);
    expect(
      interactionActionEffectExceedsDeclared({
        actionEffect: "read",
        declaredEffect: "read",
      }),
    ).toBe(false);
  });

  test("requires tenant scope for non-read action effects", () => {
    expect(interactionActionRequiresTenantScope("read")).toBe(false);
    expect(interactionActionRequiresTenantScope("write")).toBe(true);
    expect(interactionActionRequiresTenantScope("external")).toBe(true);
    expect(interactionActionRequiresTenantScope("destructive")).toBe(true);
  });

  test("matches auth against explicit and derived tenant scopes", () => {
    expect(
      interactionTenantScopeAllowsAuth({
        auth: baseAuth,
        tenantScope: { tenantId: "demo-salon" },
      }),
    ).toBe(true);
    expect(
      interactionTenantScopeAllowsAuth({
        auth: baseAuth,
        tenantScope: { fromAuth: "organizationId" },
      }),
    ).toBe(true);
    expect(
      interactionTenantScopeAllowsAuth({
        auth: baseAuth,
        tenantScope: { salonId: "salon_123" },
      }),
    ).toBe(true);
    expect(
      interactionTenantScopeAllowsAuth({
        auth: baseAuth,
        tenantScope: { tenantId: "other-salon" },
      }),
    ).toBe(false);
    expect(
      interactionTenantScopeAllowsAuth({
        auth: {
          ...baseAuth,
          tenantId: undefined,
          organizationId: undefined,
        },
        tenantScope: { fromAuth: "organizationId" },
      }),
    ).toBe(false);
    expect(
      interactionTenantScopeAllowsAuth({
        auth: baseAuth,
        tenantScope: undefined,
      }),
    ).toBe(false);
  });

  test("collects auth permissions separately from broader publish grants", () => {
    expect(collectInteractionAuthPermissions(baseAuth)).toEqual([
      "booking:write",
      "booking:refund",
    ]);
    expect(collectInteractionAuthGrants(baseAuth)).toEqual([
      "tidegate:interaction:invoke",
      "booking:read",
      "booking:write",
      "booking:refund",
    ]);
  });
});
