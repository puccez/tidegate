import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  defineAction,
  defineActionsCatalog,
  type AnyRuntimeAction,
  type RuntimeAuthContext,
} from "./action-catalog";
import {
  computeEffectiveCapabilitySet,
  type EffectiveCapabilityPolicyDecider,
} from "./effective-capabilities";
import type { PolicyInteractionHeader } from "./policy-engine";

const auth: RuntimeAuthContext = {
  authMode: "api-key",
  organizationId: "demo-salon",
  tenantId: "demo-salon",
  subjectId: "api_key_demo",
  subjectType: "api_key",
  credentialId: "api_key_demo",
  credentialType: "api_key",
  scopes: ["tidegate:interaction:invoke"],
  permissions: ["booking:write"],
  authorization: {
    permissions: ["booking:write"],
    resourceGrants: [],
  },
};

function createActions(): Map<string, AnyRuntimeAction> {
  const catalog = defineActionsCatalog({
    "booking.cancel": defineAction({
      id: "booking.cancel",
      description: "Cancel one appointment in the current salon.",
      effects: "write",
      requiredPermissions: ["booking:write"],
      tenantScope: { fromAuth: "tenantId" },
      inputSchema: z.object({ appointmentId: z.string().min(1) }),
      outputSchema: z.object({ ok: z.boolean() }),
      async execute() {
        return { ok: true };
      },
    }),
    "booking.list": defineAction({
      id: "booking.list",
      description: "List appointments.",
      effects: "read",
      inputSchema: z.object({}),
      outputSchema: z.object({ items: z.array(z.string()) }),
      async execute() {
        return { items: [] };
      },
    }),
    "booking.purge": defineAction({
      id: "booking.purge",
      description: "Destructively purge appointments.",
      effects: "destructive",
      requiredPermissions: ["booking:admin"],
      tenantScope: { fromAuth: "tenantId" },
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      async execute() {
        return { ok: true };
      },
    }),
  });

  return new Map(Object.entries(catalog));
}

function interactionHeader(
  overrides: Partial<PolicyInteractionHeader> = {},
): PolicyInteractionHeader {
  return {
    id: "ix.booking.cancelAppointment",
    version: "1",
    declaredEffect: "write",
    riskLevel: "medium",
    idempotency: "required",
    confirmation: {
      required: false,
      message: null,
      token: { presented: false, verified: false },
    },
    status: "active",
    ...overrides,
  };
}

function compute({
  actions = createActions(),
  allowedActions = [{ id: "booking.cancel", maxCalls: 1 }],
  authContext = auth,
  decide,
  header = interactionHeader(),
}: {
  actions?: Map<string, AnyRuntimeAction>;
  allowedActions?: readonly { id: string; maxCalls?: number; timeoutMs?: number }[];
  authContext?: RuntimeAuthContext;
  decide?: EffectiveCapabilityPolicyDecider;
  header?: PolicyInteractionHeader;
} = {}) {
  return computeEffectiveCapabilitySet({
    actions,
    allowedActions,
    auth: authContext,
    ...(decide === undefined ? {} : { decide }),
    interaction: header,
    now: 1_000,
  });
}

describe("computeEffectiveCapabilitySet", () => {
  test("grants a declared, registered, permitted, tenant-scoped action", () => {
    const actions = createActions();
    const set = compute({ actions });

    expect(set.interactionId).toBe("ix.booking.cancelAppointment");
    expect(set.interactionVersion).toBe("1");
    expect(set.declaredActionIds).toEqual(["booking.cancel"]);
    expect(set.grantedActionIds).toEqual(["booking.cancel"]);
    expect(set.withheld).toEqual([]);

    const entry = set.capabilities.get("booking.cancel");
    expect(entry?.status).toBe("granted");

    if (entry?.status !== "granted") {
      throw new Error("Expected a granted capability.");
    }

    // The action object is snapshotted by reference at computation time.
    expect(entry.action).toBe(actions.get("booking.cancel")!);
    expect(entry.allowedAction).toEqual({ id: "booking.cancel", maxCalls: 1 });
  });

  test("withholds unregistered actions with the live action_not_registered error", () => {
    const set = compute({
      allowedActions: [{ id: "booking.unknown" }],
    });

    expect(set.grantedActionIds).toEqual([]);
    expect(set.declaredActionIds).toEqual(["booking.unknown"]);
    expect(set.withheld).toEqual([
      {
        status: "withheld",
        allowedAction: { id: "booking.unknown" },
        reason: "action_not_registered",
        code: "action_not_registered",
        message: "This action is not registered.",
      },
    ]);
  });

  test("withholds actions the caller lacks permission for (user dimension)", () => {
    const set = compute({
      authContext: {
        ...auth,
        permissions: [],
        authorization: { permissions: [], resourceGrants: [] },
      },
    });

    expect(set.grantedActionIds).toEqual([]);
    expect(set.withheld).toEqual([
      {
        status: "withheld",
        allowedAction: { id: "booking.cancel", maxCalls: 1 },
        reason: "permission_denied",
        code: "permission_denied",
        message: "The current auth context cannot call this action.",
      },
    ]);
  });

  test("withholds actions outside the caller's tenant scope (tenant dimension)", () => {
    const set = compute({
      authContext: { ...auth, tenantId: undefined, organizationId: undefined },
    });

    expect(set.grantedActionIds).toEqual([]);
    expect(set.withheld[0]).toMatchObject({
      reason: "tenant_mismatch",
      code: "tenant_mismatch",
      message: "The current auth context cannot access this tenant.",
    });
  });

  test("withholds actions whose effect exceeds the declared interaction effect", () => {
    const set = compute({
      header: interactionHeader({ declaredEffect: "read" }),
      allowedActions: [{ id: "booking.cancel", maxCalls: 1 }],
    });

    expect(set.grantedActionIds).toEqual([]);
    expect(set.withheld[0]).toMatchObject({
      reason: "effect_exceeds_declared",
      code: "action_not_allowed",
      message: "This action exceeds the interaction effect declaration.",
    });
  });

  test("registration is checked before engine rules, matching live call precedence", () => {
    // Unregistered AND the caller lacks every permission: the live path
    // reports action_not_registered (actions.get precedes decidePolicy).
    const set = compute({
      actions: new Map(),
      authContext: {
        ...auth,
        permissions: [],
        authorization: { permissions: [], resourceGrants: [] },
      },
    });

    expect(set.withheld[0]?.reason).toBe("action_not_registered");
  });

  test("can only restrict the published allowlist, never widen it", () => {
    const actions = createActions();
    const authMatrix: RuntimeAuthContext[] = [
      auth,
      { ...auth, permissions: [], authorization: { permissions: [], resourceGrants: [] } },
      { ...auth, tenantId: undefined, organizationId: undefined },
      { ...auth, permissions: ["booking:admin", "booking:write"] },
    ];
    const allowedActions = [
      { id: "booking.cancel", maxCalls: 1 },
      { id: "booking.purge" },
      { id: "booking.unknown" },
    ];

    for (const authContext of authMatrix) {
      const set = compute({ actions, allowedActions, authContext });
      const declared = new Set(set.declaredActionIds);

      // Declared surface is exactly the allowlist — registered actions that
      // were never published ("booking.list") can never appear anywhere.
      expect(set.declaredActionIds).toEqual([
        "booking.cancel",
        "booking.purge",
        "booking.unknown",
      ]);
      expect(set.grantedActionIds.every((id) => declared.has(id))).toBe(true);
      expect(set.capabilities.has("booking.list")).toBe(false);

      // granted ∪ withheld === declared, disjoint.
      const withheldIds = set.withheld.map((entry) => entry.allowedAction.id);
      expect(
        [...set.grantedActionIds, ...withheldIds].sort(),
      ).toEqual([...set.declaredActionIds].sort());
      expect(
        set.grantedActionIds.filter((id) => withheldIds.includes(id)),
      ).toEqual([]);
    }
  });

  test("empty effective set: every declared action can be withheld", () => {
    const set = compute({
      authContext: {
        ...auth,
        permissions: [],
        authorization: { permissions: [], resourceGrants: [] },
      },
      allowedActions: [
        { id: "booking.cancel", maxCalls: 1 },
        { id: "booking.unknown" },
      ],
    });

    expect(set.grantedActionIds).toEqual([]);
    expect(set.withheld).toHaveLength(2);
    // The declared (injected) surface is untouched: denied stubs keep slots.
    expect(set.declaredActionIds).toEqual(["booking.cancel", "booking.unknown"]);
  });

  test("is deterministic for identical inputs", () => {
    const actions = createActions();
    const args = {
      actions,
      allowedActions: [
        { id: "booking.cancel", maxCalls: 1 },
        { id: "booking.purge" },
      ],
    };
    const first = compute(args);
    const second = compute(args);

    expect(second.declaredActionIds).toEqual(first.declaredActionIds);
    expect(second.grantedActionIds).toEqual(first.grantedActionIds);
    expect(second.withheld).toEqual(first.withheld);
  });

  test("a duplicate allowlist id keeps its declared slot; the capability entry comes from the first occurrence", () => {
    // The declared surface must mirror the published allowlist
    // element-for-element: payload construction compares the two exactly, so
    // dropping a duplicate here would fail every invoke of such an artifact
    // with `interaction_failed` instead of the sandbox's pre-existing
    // capability-metadata rejection.
    const set = compute({
      allowedActions: [
        { id: "booking.cancel", maxCalls: 1 },
        { id: "booking.cancel", maxCalls: 5 },
      ],
    });

    expect(set.declaredActionIds).toEqual(["booking.cancel", "booking.cancel"]);
    expect(set.grantedActionIds).toEqual(["booking.cancel"]);
    const entry = set.capabilities.get("booking.cancel");
    expect(entry?.allowedAction.maxCalls).toBe(1);
  });

  test("the snapshot is immutable against later catalog mutation", () => {
    const actions = createActions();
    const snapshotted = actions.get("booking.cancel")!;
    const set = compute({ actions });

    actions.delete("booking.cancel");

    const entry = set.capabilities.get("booking.cancel");

    if (entry?.status !== "granted") {
      throw new Error("Expected a granted capability.");
    }

    expect(entry.action).toBe(snapshotted);
  });

  test("consumes an injected policy decider (the #26 evaluator seam)", () => {
    const seenActionIds: string[] = [];
    const denyAll: EffectiveCapabilityPolicyDecider = (request) => {
      seenActionIds.push(request.allowedAction.id);

      return {
        outcome: "deny",
        reason: "permission_denied",
        message: "Denied by test decider.",
      };
    };

    const set = compute({ decide: denyAll });

    expect(seenActionIds).toEqual(["booking.cancel"]);
    expect(set.grantedActionIds).toEqual([]);
    expect(set.withheld[0]).toMatchObject({
      reason: "permission_denied",
      code: "permission_denied",
      message: "Denied by test decider.",
    });
  });

  test("maps every withhold reason to a closed public wire code", () => {
    const set = compute({
      allowedActions: [
        { id: "booking.cancel", maxCalls: 1 },
        { id: "booking.purge" },
        { id: "booking.unknown" },
      ],
      authContext: {
        ...auth,
        permissions: [],
        authorization: { permissions: [], resourceGrants: [] },
      },
    });

    for (const entry of set.withheld) {
      expect(typeof entry.code).toBe("string");
      expect(entry.code.length).toBeGreaterThan(0);
      expect(typeof entry.message).toBe("string");
    }
  });
});
