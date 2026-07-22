import { describe, expect, test } from "bun:test";
import type {
  AnyRuntimeAction,
  RuntimeAuthContext,
} from "./action-catalog.ts";
import {
  applyConstraints,
  decidePolicy,
  INVOKE_POLICY_DENY_CODES,
  mergePolicyConstraints,
  POLICY_RULES,
  PUBLISH_POLICY_DENY_CODES,
  resolvePolicySignals,
  type ActionPolicyRequest,
  type ConfirmationPolicyRequest,
  type EnvelopePolicyRequest,
  type InvokePolicyDenyReason,
  type PolicyConstraint,
  type PolicyDecisionRequest,
  type PolicyInteractionHeader,
  type PublishPolicyDenyReason,
} from "./policy-engine.ts";

const fullAuth: RuntimeAuthContext = {
  authMode: "api-key",
  credentialId: "api_key_engine",
  credentialType: "api_key",
  organizationId: "demo-salon",
  orgId: "demo-salon",
  tenantId: "demo-salon",
  salonId: "salon_123",
  subjectId: "api_key_engine",
  subjectType: "api_key",
  scopes: ["tidegate:interaction:invoke"],
  permissions: ["booking:cancel"],
  authorization: {
    permissions: ["booking:refund"],
    resourceGrants: [],
  },
};

const emptyAuth: RuntimeAuthContext = {
  authMode: "api-key",
  scopes: [],
  permissions: [],
};

function makeAction(overrides: Partial<AnyRuntimeAction> = {}): AnyRuntimeAction {
  return {
    id: "booking.cancel",
    description: "Cancel a booking.",
    inputSchema: { safeParse: (value) => ({ success: true, data: value }) },
    outputSchema: { safeParse: (value) => ({ success: true, data: value }) },
    effects: "write",
    requiredPermissions: ["booking:cancel"],
    tenantScope: { fromAuth: "salonId" },
    execute: async () => ({}),
    ...overrides,
  };
}

function makeHeader(
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

function envelopeRequest(
  overrides: {
    interaction?: Partial<PolicyInteractionHeader>;
    request?: EnvelopePolicyRequest["request"];
    budget?: EnvelopePolicyRequest["budget"];
    auth?: RuntimeAuthContext;
  } = {},
): EnvelopePolicyRequest {
  return {
    kind: "envelope",
    phase: "invoke",
    auth: overrides.auth ?? fullAuth,
    interaction: makeHeader(overrides.interaction),
    request: overrides.request ?? { interactionVersion: "1", idempotencyKey: "key-1" },
    budget: overrides.budget ?? {
      maxActionCalls: 3,
      allowedActions: [{ id: "booking.cancel", maxCalls: 2 }, { id: "booking.log" }],
    },
    now: 0,
  };
}

function confirmationRequest(
  overrides: {
    interaction?: Partial<PolicyInteractionHeader>;
    request?: ConfirmationPolicyRequest["request"];
    auth?: RuntimeAuthContext;
  } = {},
): ConfirmationPolicyRequest {
  return {
    kind: "confirmation",
    phase: "invoke",
    auth: overrides.auth ?? fullAuth,
    interaction: makeHeader(overrides.interaction),
    request: overrides.request ?? { idempotencyKey: "key-1" },
    now: 0,
  };
}

function actionRequest(
  overrides: {
    phase?: "invoke" | "publish";
    interaction?: Partial<PolicyInteractionHeader>;
    action?: Partial<AnyRuntimeAction>;
    allowedAction?: { id: string; maxCalls?: number };
    auth?: RuntimeAuthContext;
    liveState?: ActionPolicyRequest["liveState"];
  } = {},
): ActionPolicyRequest {
  return {
    kind: "action",
    phase: overrides.phase ?? "invoke",
    auth: overrides.auth ?? fullAuth,
    interaction: makeHeader(overrides.interaction),
    action: makeAction(overrides.action),
    allowedAction: overrides.allowedAction ?? { id: "booking.cancel", maxCalls: 2 },
    input: { appointmentId: "apt_123" },
    ...(overrides.liveState === undefined
      ? {}
      : { liveState: overrides.liveState }),
    now: 0,
  };
}

const confirmationRequired = {
  confirmation: {
    required: true,
    message: "Confirm the cancellation." as string | null,
    token: { presented: false as const, verified: false as const },
  },
};

describe("decidePolicy — envelope (invoke)", () => {
  test("denies revoked interactions first", () => {
    const decision = decidePolicy(
      envelopeRequest({ interaction: { status: "revoked" } }),
    );

    expect(decision).toEqual({
      outcome: "deny",
      reason: "interaction_revoked",
      message: "This interaction has been revoked.",
    });
  });

  test("denies archived interactions", () => {
    const decision = decidePolicy(
      envelopeRequest({ interaction: { status: "archived" } }),
    );

    expect(decision.outcome).toBe("deny");
    if (decision.outcome !== "deny") throw new Error("expected deny");
    expect(decision.reason).toBe("interaction_unavailable");
    expect(decision.message).toBe("This interaction is not active.");
  });

  test("denies version mismatches", () => {
    const decision = decidePolicy(
      envelopeRequest({ request: { interactionVersion: "2", idempotencyKey: "k" } }),
    );

    expect(decision.outcome).toBe("deny");
    if (decision.outcome !== "deny") throw new Error("expected deny");
    expect(decision.reason).toBe("interaction_version_mismatch");
    expect(decision.message).toBe("This interaction version is not available.");
  });

  test("denies required idempotency without a key", () => {
    const decision = decidePolicy(
      envelopeRequest({ request: { interactionVersion: "1" } }),
    );

    expect(decision.outcome).toBe("deny");
    if (decision.outcome !== "deny") throw new Error("expected deny");
    expect(decision.reason).toBe("idempotency_key_required");
    expect(decision.message).toBe(
      "This interaction requires an idempotency key.",
    );
  });

  test("constrains an admissible envelope with the canonical action-call budget", () => {
    const decision = decidePolicy(envelopeRequest());

    expect(decision).toEqual({
      outcome: "constrain",
      reason: "constrained",
      constraints: [
        { kind: "maxActionCalls", actionId: "booking.cancel", value: 2 },
        { kind: "maxTotalActionCalls", value: 3 },
      ],
    });
  });

  test("deny takes precedence over the budget constraint", () => {
    const decision = decidePolicy(
      envelopeRequest({ interaction: { status: "revoked" } }),
    );

    expect(decision.outcome).toBe("deny");
  });

  test("revoked wins over version mismatch by rule order", () => {
    const decision = decidePolicy(
      envelopeRequest({
        interaction: { status: "revoked" },
        request: { interactionVersion: "999" },
      }),
    );

    expect(decision.outcome).toBe("deny");
    if (decision.outcome !== "deny") throw new Error("expected deny");
    expect(decision.reason).toBe("interaction_revoked");
  });
});

describe("decidePolicy — confirmation (invoke)", () => {
  test("allows when confirmation is not required, even with a token presented", () => {
    const decision = decidePolicy(
      confirmationRequest({
        interaction: {
          confirmation: {
            required: false,
            message: null,
            token: { presented: true, verified: false, failure: null },
          },
        },
      }),
    );

    expect(decision).toEqual({ outcome: "allow", reason: "allowed" });
  });

  test("emits confirm with the contract message when no token is presented", () => {
    const decision = decidePolicy(
      confirmationRequest({ interaction: confirmationRequired }),
    );

    expect(decision).toEqual({
      outcome: "confirm",
      reason: "confirmation_required",
      message: "Confirm the cancellation.",
      confirmation: { message: "Confirm the cancellation." },
    });
  });

  test("falls back to the default confirmation message", () => {
    const decision = decidePolicy(
      confirmationRequest({
        interaction: {
          confirmation: { ...confirmationRequired.confirmation, message: null },
        },
      }),
    );

    expect(decision.outcome).toBe("confirm");
    if (decision.outcome !== "confirm") throw new Error("expected confirm");
    expect(decision.confirmation.message).toBe(
      "Confirm this action before continuing.",
    );
  });

  test("denies an anonymous subject before confirming (deny beats confirm)", () => {
    const decision = decidePolicy(
      confirmationRequest({
        auth: emptyAuth,
        interaction: confirmationRequired,
      }),
    );

    expect(decision.outcome).toBe("deny");
    if (decision.outcome !== "deny") throw new Error("expected deny");
    expect(decision.reason).toBe("confirmation_subject_required");
    expect(decision.message).toBe(
      "Confirmation requires an identified subject in the auth context.",
    );
  });

  test("denies a missing idempotency key before confirming", () => {
    const decision = decidePolicy(
      confirmationRequest({
        interaction: confirmationRequired,
        request: {},
      }),
    );

    expect(decision.outcome).toBe("deny");
    if (decision.outcome !== "deny") throw new Error("expected deny");
    expect(decision.reason).toBe("confirmation_idempotency_key_required");
  });

  test("stays silent on a presented-but-unverified token (kernel verifies next)", () => {
    const decision = decidePolicy(
      confirmationRequest({
        interaction: {
          confirmation: {
            ...confirmationRequired.confirmation,
            token: { presented: true, verified: false, failure: null },
          },
        },
      }),
    );

    expect(decision.outcome).toBe("allow");
  });

  test.each([
    ["expired", "confirmation_expired"],
    ["mismatch", "confirmation_input_mismatch"],
    ["invalid", "confirmation_invalid"],
  ] as const)(
    "denies a token the kernel reported as %s",
    (failure, expectedReason) => {
      const decision = decidePolicy(
        confirmationRequest({
          interaction: {
            confirmation: {
              ...confirmationRequired.confirmation,
              token: { presented: true, verified: false, failure },
            },
          },
        }),
      );

      expect(decision.outcome).toBe("deny");
      if (decision.outcome !== "deny") throw new Error("expected deny");
      expect(decision.reason).toBe(expectedReason);
    },
  );

  test("allows a kernel-verified token and does not re-emit confirm", () => {
    const decision = decidePolicy(
      confirmationRequest({
        interaction: {
          confirmation: {
            ...confirmationRequired.confirmation,
            token: { presented: true, verified: true },
          },
        },
      }),
    );

    expect(decision).toEqual({ outcome: "allow", reason: "allowed" });
  });
});

describe("decidePolicy — action (invoke)", () => {
  test("allows an action within effect, permission, and tenant policy", () => {
    expect(decidePolicy(actionRequest())).toEqual({
      outcome: "allow",
      reason: "allowed",
    });
  });

  test("denies an action whose effect exceeds the declaration", () => {
    const decision = decidePolicy(
      actionRequest({
        interaction: { declaredEffect: "read" },
      }),
    );

    expect(decision).toEqual({
      outcome: "deny",
      reason: "effect_exceeds_declared",
      message: "This action exceeds the interaction effect declaration.",
    });
  });

  test("denies a missing permission with the invoke message", () => {
    const decision = decidePolicy(
      actionRequest({
        action: { requiredPermissions: ["booking:destroy"] },
      }),
    );

    expect(decision).toEqual({
      outcome: "deny",
      reason: "permission_denied",
      message: "The current auth context cannot call this action.",
    });
  });

  test("accepts permissions granted via authorization claims", () => {
    const decision = decidePolicy(
      actionRequest({
        action: { requiredPermissions: ["booking:refund"] },
      }),
    );

    expect(decision.outcome).toBe("allow");
  });

  test("denies a tenant mismatch for effectful actions", () => {
    const decision = decidePolicy(
      actionRequest({
        auth: { ...fullAuth, salonId: undefined },
      }),
    );

    expect(decision).toEqual({
      outcome: "deny",
      reason: "tenant_mismatch",
      message: "The current auth context cannot access this tenant.",
    });
  });

  test("read actions skip the tenant-scope rule", () => {
    const decision = decidePolicy(
      actionRequest({
        auth: { ...fullAuth, salonId: undefined },
        action: { effects: "read", tenantScope: undefined },
      }),
    );

    expect(decision.outcome).toBe("allow");
  });

  test("denies degenerate empty auth on a permissioned action", () => {
    const decision = decidePolicy(actionRequest({ auth: emptyAuth }));

    expect(decision.outcome).toBe("deny");
    if (decision.outcome !== "deny") throw new Error("expected deny");
    expect(decision.reason).toBe("permission_denied");
  });

  test("allows an unpermissioned read action for empty auth", () => {
    const decision = decidePolicy(
      actionRequest({
        auth: emptyAuth,
        action: {
          effects: "read",
          requiredPermissions: undefined,
          tenantScope: undefined,
        },
      }),
    );

    expect(decision).toEqual({ outcome: "allow", reason: "allowed" });
  });

  // #25 live-state rules — the engine reads the kernel-supplied snapshot; the
  // impure ports live in the runtime guard, keeping decidePolicy pure.
  describe("live authority (#25)", () => {
    test("absent snapshot is authority-intact (behaves like today)", () => {
      expect(decidePolicy(actionRequest({ liveState: undefined }))).toEqual({
        outcome: "allow",
        reason: "allowed",
      });
    });

    test("empty snapshot is authority-intact", () => {
      expect(decidePolicy(actionRequest({ liveState: {} }))).toEqual({
        outcome: "allow",
        reason: "allowed",
      });
    });

    test("a revoked snapshot denies with interaction_revoked", () => {
      const decision = decidePolicy(
        actionRequest({ liveState: { revoked: { reason: "operator revoke" } } }),
      );

      expect(decision.outcome).toBe("deny");
      if (decision.outcome !== "deny") throw new Error("expected deny");
      expect(decision.reason).toBe("interaction_revoked");
    });

    test("an exhausted budget denies with budget_exhausted", () => {
      const decision = decidePolicy(
        actionRequest({ liveState: { budgetExhausted: true } }),
      );

      expect(decision.outcome).toBe("deny");
      if (decision.outcome !== "deny") throw new Error("expected deny");
      expect(decision.reason).toBe("budget_exhausted");
    });

    test("revocation supersedes budget (security first) via rule order", () => {
      const decision = decidePolicy(
        actionRequest({
          liveState: { revoked: { reason: "revoked" }, budgetExhausted: true },
        }),
      );

      expect(decision.outcome).toBe("deny");
      if (decision.outcome !== "deny") throw new Error("expected deny");
      expect(decision.reason).toBe("interaction_revoked");
    });

    test("revocation supersedes a frozen permission/effect deny", () => {
      const decision = decidePolicy(
        actionRequest({
          interaction: { declaredEffect: "read" },
          liveState: { revoked: { reason: "revoked" } },
        }),
      );

      expect(decision.outcome).toBe("deny");
      if (decision.outcome !== "deny") throw new Error("expected deny");
      expect(decision.reason).toBe("interaction_revoked");
    });
  });
});

describe("decidePolicy — publish/invoke phase divergence (pinned)", () => {
  const wildcardScopeAuth: RuntimeAuthContext = {
    ...emptyAuth,
    subjectId: "publisher",
    salonId: "salon_123",
    scopes: ["booking:*"],
  };

  test("a wildcard scope grants publish but NOT invoke", () => {
    const publishDecision = decidePolicy(
      actionRequest({ phase: "publish", auth: wildcardScopeAuth }),
    );
    const invokeDecision = decidePolicy(
      actionRequest({ phase: "invoke", auth: wildcardScopeAuth }),
    );

    expect(publishDecision.outcome).toBe("allow");
    expect(invokeDecision.outcome).toBe("deny");
    if (invokeDecision.outcome !== "deny") throw new Error("expected deny");
    expect(invokeDecision.reason).toBe("permission_denied");
  });

  test("an exact permission grants both phases", () => {
    expect(decidePolicy(actionRequest({ phase: "publish" })).outcome).toBe(
      "allow",
    );
    expect(decidePolicy(actionRequest({ phase: "invoke" })).outcome).toBe(
      "allow",
    );
  });

  test("the global wildcard grant allows any publish permission", () => {
    const decision = decidePolicy(
      actionRequest({
        phase: "publish",
        auth: { ...wildcardScopeAuth, scopes: ["*"] },
      }),
    );

    expect(decision.outcome).toBe("allow");
  });

  test("publish deny messages name the requested action", () => {
    const permissionDeny = decidePolicy(
      actionRequest({
        phase: "publish",
        auth: { ...emptyAuth, subjectId: "publisher", salonId: "salon_123" },
      }),
    );
    const effectDeny = decidePolicy(
      actionRequest({
        phase: "publish",
        interaction: { declaredEffect: "read" },
      }),
    );
    const tenantDeny = decidePolicy(
      actionRequest({
        phase: "publish",
        auth: { ...fullAuth, salonId: undefined },
      }),
    );

    expect(permissionDeny).toEqual({
      outcome: "deny",
      reason: "permission_denied",
      message: 'The current auth context cannot publish action "booking.cancel".',
    });
    expect(effectDeny).toEqual({
      outcome: "deny",
      reason: "effect_exceeds_declared",
      message: 'Action "booking.cancel" exceeds the declared interaction effect.',
    });
    expect(tenantDeny).toEqual({
      outcome: "deny",
      reason: "tenant_mismatch",
      message:
        'The current auth context cannot publish action "booking.cancel" for this tenant.',
    });
  });

  test("the same reason maps to different wire codes per phase", () => {
    expect(INVOKE_POLICY_DENY_CODES.effect_exceeds_declared).toBe(
      "action_not_allowed",
    );
    expect(PUBLISH_POLICY_DENY_CODES.effect_exceeds_declared).toEqual({
      code: "invalid_request",
      status: 400,
    });
    expect(INVOKE_POLICY_DENY_CODES.tenant_mismatch).toBe("tenant_mismatch");
    expect(PUBLISH_POLICY_DENY_CODES.tenant_mismatch).toEqual({
      code: "permission_denied",
      status: 403,
    });
  });

  test("publish-phase decisions never confirm or constrain", () => {
    const scenarios: PolicyDecisionRequest[] = [
      actionRequest({ phase: "publish" }),
      actionRequest({ phase: "publish", auth: emptyAuth }),
      actionRequest({
        phase: "publish",
        interaction: {
          ...confirmationRequired,
          declaredEffect: "read",
        },
      }),
      actionRequest({
        phase: "publish",
        allowedAction: { id: "booking.cancel", maxCalls: 1 },
      }),
    ];

    for (const scenario of scenarios) {
      const decision = decidePolicy(scenario);
      expect(["allow", "deny"]).toContain(decision.outcome);
    }
  });
});

describe("resolvePolicySignals — precedence", () => {
  const denySignal = {
    signal: "deny",
    reason: "permission_denied",
    message: "denied",
  } as const;
  const confirmSignal = { signal: "confirm", message: "confirm it" } as const;
  const constrainSignal = {
    signal: "constrain",
    constraints: [{ kind: "maxTotalActionCalls", value: 5 }] as PolicyConstraint[],
  } as const;

  test("deny beats confirm even when confirm is listed first", () => {
    const decision = resolvePolicySignals([confirmSignal, denySignal]);

    expect(decision.outcome).toBe("deny");
  });

  test("confirm beats constrain and discards constraints", () => {
    const decision = resolvePolicySignals([constrainSignal, confirmSignal]);

    expect(decision).toEqual({
      outcome: "confirm",
      reason: "confirmation_required",
      message: "confirm it",
      confirmation: { message: "confirm it" },
    });
  });

  test("multiple constrains merge into a single canonical constrain", () => {
    const decision = resolvePolicySignals([
      constrainSignal,
      {
        signal: "constrain",
        constraints: [{ kind: "maxTotalActionCalls", value: 2 }],
      },
    ]);

    expect(decision).toEqual({
      outcome: "constrain",
      reason: "constrained",
      constraints: [{ kind: "maxTotalActionCalls", value: 2 }],
    });
  });

  test("no signals means allow", () => {
    expect(resolvePolicySignals([])).toEqual({
      outcome: "allow",
      reason: "allowed",
    });
  });

  test("first deny by rule order wins the tiebreak", () => {
    const decision = resolvePolicySignals([
      denySignal,
      { signal: "deny", reason: "tenant_mismatch", message: "second" },
    ]);

    expect(decision.outcome).toBe("deny");
    if (decision.outcome !== "deny") throw new Error("expected deny");
    expect(decision.reason).toBe("permission_denied");
  });
});

describe("mergePolicyConstraints — constraint algebra", () => {
  test("maxCalls and maxTotalActionCalls take the minimum", () => {
    const merged = mergePolicyConstraints([
      { kind: "maxActionCalls", actionId: "a", value: 5 },
      { kind: "maxActionCalls", actionId: "a", value: 2 },
      { kind: "maxTotalActionCalls", value: 9 },
      { kind: "maxTotalActionCalls", value: 4 },
    ]);

    expect(merged).toEqual({
      ok: true,
      constraints: [
        { kind: "maxActionCalls", actionId: "a", value: 2 },
        { kind: "maxTotalActionCalls", value: 4 },
      ],
    });
  });

  test("redactPaths union is sorted and deduped", () => {
    const merged = mergePolicyConstraints([
      { kind: "redactPaths", paths: ["/b", "/a"] },
      { kind: "redactPaths", paths: ["/a", "/c"] },
    ]);

    expect(merged).toEqual({
      ok: true,
      constraints: [{ kind: "redactPaths", paths: ["/a", "/b", "/c"] }],
    });
  });

  test("tenant scopes intersect field-wise", () => {
    const merged = mergePolicyConstraints([
      { kind: "tenantScope", scope: { fromAuth: "salonId" } },
      { kind: "tenantScope", scope: { tenantId: "t1" } },
    ]);

    expect(merged).toEqual({
      ok: true,
      constraints: [
        { kind: "tenantScope", scope: { tenantId: "t1", fromAuth: "salonId" } },
      ],
    });
  });

  test("conflicting tenant scopes fail the merge", () => {
    const merged = mergePolicyConstraints([
      { kind: "tenantScope", scope: { tenantId: "t1" } },
      { kind: "tenantScope", scope: { tenantId: "t2" } },
    ]);

    expect(merged).toEqual({ ok: false, reason: "tenant_scope_conflict" });
  });

  test("a tenant-scope conflict fails closed to deny via signal resolution", () => {
    const decision = resolvePolicySignals([
      {
        signal: "constrain",
        constraints: [{ kind: "tenantScope", scope: { tenantId: "t1" } }],
      },
      {
        signal: "constrain",
        constraints: [{ kind: "tenantScope", scope: { tenantId: "t2" } }],
      },
    ]);

    expect(decision.outcome).toBe("deny");
    if (decision.outcome !== "deny") throw new Error("expected deny");
    expect(decision.reason).toBe("tenant_mismatch");
  });

  test("merge order does not change the canonical result", () => {
    const forward: PolicyConstraint[] = [
      { kind: "redactPaths", paths: ["/z"] },
      { kind: "maxTotalActionCalls", value: 7 },
      { kind: "maxActionCalls", actionId: "b", value: 1 },
      { kind: "maxActionCalls", actionId: "a", value: 3 },
      { kind: "redactPaths", paths: ["/a"] },
    ];
    const backward = [...forward].reverse();

    expect(mergePolicyConstraints(forward)).toEqual(
      mergePolicyConstraints(backward),
    );
  });
});

describe("applyConstraints — engine-owned enforcement", () => {
  test("enforces the total action-call budget with the invoke message", () => {
    const context = applyConstraints([
      { kind: "maxTotalActionCalls", value: 2 },
    ]);

    expect(context.registerActionCall("a")).toEqual({ ok: true });
    expect(context.registerActionCall("b")).toEqual({ ok: true });
    expect(context.registerActionCall("c")).toEqual({
      ok: false,
      message: "This interaction exceeded its action call limit.",
    });
  });

  test("enforces per-action limits with the invoke message", () => {
    const context = applyConstraints([
      { kind: "maxTotalActionCalls", value: 10 },
      { kind: "maxActionCalls", actionId: "a", value: 1 },
    ]);

    expect(context.registerActionCall("a")).toEqual({ ok: true });
    expect(context.registerActionCall("a")).toEqual({
      ok: false,
      message: "This interaction exceeded an action call limit.",
    });
    // Other actions remain unlimited apart from the total budget.
    expect(context.registerActionCall("b")).toEqual({ ok: true });
  });

  test("the total limit is checked before the per-action limit", () => {
    const context = applyConstraints([
      { kind: "maxTotalActionCalls", value: 1 },
      { kind: "maxActionCalls", actionId: "a", value: 1 },
    ]);

    expect(context.registerActionCall("a")).toEqual({ ok: true });
    expect(context.registerActionCall("a")).toEqual({
      ok: false,
      message: "This interaction exceeded its action call limit.",
    });
  });

  test("exposes merged redact paths and tenant scope", () => {
    const context = applyConstraints([
      { kind: "redactPaths", paths: ["/b", "/a", "/a"] },
      { kind: "tenantScope", scope: { fromAuth: "salonId" } },
    ]);

    expect(context.redactPaths).toEqual(["/a", "/b"]);
    expect(context.tenantScope).toEqual({ fromAuth: "salonId" });
  });
});

describe("determinism", () => {
  const matrix: PolicyDecisionRequest[] = [
    envelopeRequest(),
    envelopeRequest({ interaction: { status: "revoked" } }),
    envelopeRequest({ request: { interactionVersion: "2" } }),
    confirmationRequest({ interaction: confirmationRequired }),
    confirmationRequest({
      interaction: {
        confirmation: {
          ...confirmationRequired.confirmation,
          token: { presented: true, verified: true },
        },
      },
    }),
    confirmationRequest({
      interaction: {
        confirmation: {
          ...confirmationRequired.confirmation,
          token: { presented: true, verified: false, failure: "expired" },
        },
      },
    }),
    actionRequest(),
    actionRequest({ auth: emptyAuth }),
    actionRequest({ phase: "publish" }),
    actionRequest({ phase: "publish", interaction: { declaredEffect: "read" } }),
  ];

  test("same request in, same decision out", () => {
    for (const request of matrix) {
      expect(decidePolicy(request)).toEqual(decidePolicy(request));
    }
  });

  test("no rule reaches for the wall clock (Date.now throws)", () => {
    const originalNow = Date.now;
    Date.now = () => {
      throw new Error("decidePolicy must not read the wall clock");
    };

    try {
      for (const request of matrix) {
        expect(() => decidePolicy(request)).not.toThrow();
      }
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("mapping tables — exhaustiveness", () => {
  const invokeReasons: InvokePolicyDenyReason[] = [
    "interaction_revoked",
    "interaction_unavailable",
    "interaction_version_mismatch",
    "idempotency_key_required",
    "confirmation_subject_required",
    "confirmation_idempotency_key_required",
    "confirmation_expired",
    "confirmation_input_mismatch",
    "confirmation_invalid",
    "effect_exceeds_declared",
    "permission_denied",
    "tenant_mismatch",
  ];
  const publishReasons: PublishPolicyDenyReason[] = [
    "effect_exceeds_declared",
    "permission_denied",
    "tenant_mismatch",
  ];

  test("every invoke deny reason maps to a wire error code", () => {
    for (const reason of invokeReasons) {
      expect(INVOKE_POLICY_DENY_CODES[reason]).toBeString();
    }
  });

  test("every publish deny reason maps to a code and HTTP status", () => {
    for (const reason of publishReasons) {
      expect(PUBLISH_POLICY_DENY_CODES[reason].code).toBeString();
      expect([400, 403]).toContain(PUBLISH_POLICY_DENY_CODES[reason].status);
    }
  });

  test("every rule is phase- and kind-tagged", () => {
    for (const rule of POLICY_RULES) {
      expect(rule.id.length).toBeGreaterThan(0);
      expect(rule.phases.length).toBeGreaterThan(0);
      expect(rule.kinds.length).toBeGreaterThan(0);
    }
  });
});
