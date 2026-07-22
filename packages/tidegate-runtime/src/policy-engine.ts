/**
 * Tidegate policy engine — the single deterministic decision seam (#26).
 *
 * "The model advises, the kernel decides." Generated interaction code (the
 * sandbox) can only *request* an action; every admission decision — may this
 * auth context invoke this interaction, call this action, publish this
 * declaration — flows through `decidePolicy` and comes back as one of four
 * outcomes: `allow`, `deny`, `confirm`, or `constrain`.
 *
 * Determinism contract: `decidePolicy` is a pure function of its request. It
 * performs no I/O, calls no model, and never reads the wall clock — `now` is
 * injected and reserved for future budget/expiry rules (no rule reads it in
 * this slice; a test pins that by making `Date.now` throw). Same request in,
 * same decision out.
 *
 * Confirmation boundary (#24): the engine never sees or verifies token bytes.
 * The kernel mints and verifies confirmation tokens (`confirmation-token.ts`)
 * and reports the result through `PolicyConfirmationTokenState`; the
 * confirmation rules key off that kernel-supplied state:
 *
 *   1. Round one — token absent (`presented: false`) → outcome `confirm`;
 *      the kernel mints a token and returns the confirmation envelope.
 *   2. Token presented but not yet verified (`verified: false`,
 *      `failure: null`) → the state rule stays silent so the pure
 *      precondition rules (identified subject, idempotency key) can deny
 *      first; on `allow` the kernel verifies the token and consults the
 *      engine again with the verification result.
 *   3. Round two — `verified: true` → `allow` (the rule does NOT re-emit
 *      `confirm`; a verified re-run proceeds). A reported failure →
 *      `deny` with the matching confirmation reason.
 *
 * Phase divergence (deliberate, preserved): publish-time and invoke-time
 * permission checks are NOT the same predicate. Publish asks "could this auth
 * context ever be granted these actions?" and matches required permissions
 * against grants (scopes + permissions) with wildcard support; invoke asks
 * "may this specific call proceed now?" and matches against exact permission
 * entries only. The `required-permissions` rule is phase-parameterized to
 * reproduce both behaviors byte-for-byte; unifying them is a deliberate
 * behavior change deferred out of this slice.
 *
 * Precedence: every applicable rule is evaluated (no first-match
 * short-circuit), then the decision is selected as deny > confirm >
 * constrain > allow. Deny-vs-deny ties break by declared rule order, which
 * keeps today's error ordering stable. Constraints merge through a
 * deterministic algebra (min for call budgets, sorted-deduped union for
 * redact paths, intersection for tenant scopes — an empty intersection fails
 * closed to deny).
 */
import type {
  EffectClass,
  IdempotencyPolicy,
  InteractionAvailabilityStatus,
  InvokeInteractionErrorCode,
  RiskLevel,
} from "@tidegate/contracts";
import type {
  AnyRuntimeAction,
  RuntimeAuthContext,
  RuntimeTenantScope,
} from "./action-catalog.ts";
import {
  collectInteractionAuthGrants,
  collectInteractionAuthPermissions,
  interactionActionEffectExceedsDeclared,
  interactionActionRequiresTenantScope,
  interactionTenantScopeAllowsAuth,
  resolveAuthSubject,
} from "./interaction-action-policy.ts";

export type PolicyPhase = "publish" | "invoke";
export type PolicyOutcome = "allow" | "deny" | "confirm" | "constrain";
export type PolicyRequestKind = "envelope" | "confirmation" | "action";

/** Kernel-reported verification failure for a presented confirmation token. */
export type PolicyConfirmationFailure = "expired" | "mismatch" | "invalid";

/**
 * Kernel-supplied confirmation token state (#24 seam). The engine never
 * receives raw token bytes: the kernel verifies the token and reports the
 * outcome here. `failure: null` means "presented but not yet verified" — the
 * kernel consults the engine once for the pure preconditions, verifies on
 * `allow`, then consults again with the result.
 */
export type PolicyConfirmationTokenState =
  | { presented: false; verified: false }
  | { presented: true; verified: false; failure: PolicyConfirmationFailure | null }
  | { presented: true; verified: true };

export type PolicyConfirmationState = {
  required: boolean;
  message: string | null;
  token: PolicyConfirmationTokenState;
};

/**
 * The interaction (or, at publish time, the interaction declaration) the
 * decision is about. Publish callers supply a synthetic header — there is no
 * published version or availability status yet.
 */
export type PolicyInteractionHeader = {
  id: string;
  version: string;
  declaredEffect: EffectClass;
  riskLevel: RiskLevel;
  idempotency: IdempotencyPolicy;
  confirmation: PolicyConfirmationState;
  status?: InteractionAvailabilityStatus;
};

type PolicyRequestBase = {
  phase: PolicyPhase;
  auth: RuntimeAuthContext;
  interaction: PolicyInteractionHeader;
  /**
   * Injected clock — reserved as the single sanctioned time source for
   * future budget/expiry rules (#25). No rule reads it in this slice; the
   * determinism test pins that no rule reaches for the wall clock instead.
   */
  now: number;
};

/** Invoke-level admission: availability, version, idempotency, call budget. */
export type EnvelopePolicyRequest = PolicyRequestBase & {
  kind: "envelope";
  request: { interactionVersion?: string; idempotencyKey?: string };
  budget: {
    maxActionCalls: number;
    allowedActions: readonly { id: string; maxCalls?: number }[];
  };
};

/** Confirmation gate: subject, idempotency key, kernel-verified token state. */
export type ConfirmationPolicyRequest = PolicyRequestBase & {
  kind: "confirmation";
  request: { idempotencyKey?: string };
};

/**
 * Live-execution authority snapshot (#25). Frozen-at-launch authority is not
 * enough: an operator may revoke an interaction/credential/invocation, or a
 * cumulative budget may run dry, WHILE an interaction runs. The kernel refreshes
 * this snapshot before every action call (consulting its impure ports), then
 * hands the *values* to the pure engine — so `decidePolicy` stays a pure
 * function of its request and never performs I/O itself.
 *
 * `revoked` short-circuits to a hard deny (security). `budgetExhausted` denies
 * the next call (soft, deny-next). Both fields default to "authority intact"
 * when the snapshot is absent, so an execution with no live-state ports behaves
 * exactly like today.
 */
export type PolicyLiveStateSnapshot = {
  /** A revocation reason if authority has been withdrawn, else undefined. */
  revoked?: { reason: string } | undefined;
  /** True when a debit against the cumulative budget could not be satisfied. */
  budgetExhausted?: boolean;
};

/** Per-action gate: effect ceiling, permissions, tenant scope, live state. */
export type ActionPolicyRequest = PolicyRequestBase & {
  kind: "action";
  action: AnyRuntimeAction;
  /** The interaction's allowlist entry (or the publish-requested entry). */
  allowedAction: { id: string; maxCalls?: number };
  input: unknown;
  /**
   * Kernel-supplied live authority snapshot (#25). Absent at publish time and
   * for executions without live-state ports — the engine treats absence as
   * "authority intact", preserving today's behavior byte-for-byte.
   */
  liveState?: PolicyLiveStateSnapshot;
};

export type PolicyDecisionRequest =
  | EnvelopePolicyRequest
  | ConfirmationPolicyRequest
  | ActionPolicyRequest;

export type InvokeEnvelopePolicyDenyReason =
  | "interaction_revoked"
  | "interaction_unavailable"
  | "interaction_version_mismatch"
  | "idempotency_key_required";

export type InvokeConfirmationPolicyDenyReason =
  | "confirmation_subject_required"
  | "confirmation_idempotency_key_required"
  | "confirmation_expired"
  | "confirmation_input_mismatch"
  | "confirmation_invalid";

export type ActionPolicyDenyReason =
  | "effect_exceeds_declared"
  | "permission_denied"
  | "tenant_mismatch"
  // Live-state denials (#25): authority withdrawn or budget exhausted DURING
  // execution. Unlike the reasons above (frozen at launch), these are decided
  // against a per-call snapshot the kernel refreshes before every action.
  | "interaction_revoked"
  | "budget_exhausted";

export type InvokePolicyDenyReason =
  | InvokeEnvelopePolicyDenyReason
  | InvokeConfirmationPolicyDenyReason
  | ActionPolicyDenyReason;

/**
 * Publish-phase rules can only emit these reasons (no confirm/constrain, and no
 * live-state reasons — a publish decision carries no execution snapshot).
 */
export type PublishPolicyDenyReason =
  | "effect_exceeds_declared"
  | "permission_denied"
  | "tenant_mismatch";

export type PolicyDenyReason = InvokePolicyDenyReason;

export type PolicyReasonCode =
  | "allowed"
  | "constrained"
  | "confirmation_required"
  | PolicyDenyReason;

export type PolicyConstraint =
  | { kind: "maxActionCalls"; actionId: string; value: number }
  | { kind: "maxTotalActionCalls"; value: number }
  | { kind: "redactPaths"; paths: readonly string[] }
  | { kind: "tenantScope"; scope: RuntimeTenantScope };

export type PolicyAllowDecision = { outcome: "allow"; reason: "allowed" };

export type PolicyDenyDecision = {
  outcome: "deny";
  reason: PolicyDenyReason;
  message: string;
};

export type PolicyConfirmDecision = {
  outcome: "confirm";
  reason: "confirmation_required";
  message: string;
  confirmation: { message: string };
};

export type PolicyConstrainDecision = {
  outcome: "constrain";
  reason: "constrained";
  constraints: readonly PolicyConstraint[];
};

export type PolicyDecision =
  | PolicyAllowDecision
  | PolicyDenyDecision
  | PolicyConfirmDecision
  | PolicyConstrainDecision;

export type EnvelopePolicyDecision =
  | PolicyAllowDecision
  | PolicyDenyDecision
  | PolicyConstrainDecision;

export type ConfirmationPolicyDecision =
  | PolicyAllowDecision
  | PolicyDenyDecision
  | PolicyConfirmDecision;

export type ActionPolicyDecision = PolicyAllowDecision | PolicyDenyDecision;

export type PublishPolicyDecision =
  | PolicyAllowDecision
  | (PolicyDenyDecision & { reason: PublishPolicyDenyReason });

/**
 * Reason → invoke error code. Exhaustive over every reason the invoke phase
 * can produce, so a new rule cannot deny without a wire code.
 */
export const INVOKE_POLICY_DENY_CODES: Record<
  InvokePolicyDenyReason,
  InvokeInteractionErrorCode
> = {
  interaction_revoked: "interaction_revoked",
  interaction_unavailable: "interaction_unavailable",
  interaction_version_mismatch: "interaction_version_mismatch",
  idempotency_key_required: "idempotency_key_required",
  confirmation_subject_required: "auth_required",
  confirmation_idempotency_key_required: "idempotency_key_required",
  confirmation_expired: "confirmation_expired",
  confirmation_input_mismatch: "confirmation_input_mismatch",
  confirmation_invalid: "confirmation_invalid",
  effect_exceeds_declared: "action_not_allowed",
  permission_denied: "permission_denied",
  tenant_mismatch: "tenant_mismatch",
  budget_exhausted: "budget_exhausted",
};

/**
 * Reason → publish error code + HTTP status. Keyed by only the reasons the
 * publish phase can produce: the effect ceiling is an invalid declaration
 * (400) at publish but a runtime refusal at invoke, and a tenant mismatch
 * surfaces as `permission_denied` (403) at publish.
 */
export const PUBLISH_POLICY_DENY_CODES: Record<
  PublishPolicyDenyReason,
  { code: "invalid_request" | "permission_denied"; status: 400 | 403 }
> = {
  effect_exceeds_declared: { code: "invalid_request", status: 400 },
  permission_denied: { code: "permission_denied", status: 403 },
  tenant_mismatch: { code: "permission_denied", status: 403 },
};

export type PolicyRuleSignal =
  | { signal: "deny"; reason: PolicyDenyReason; message: string }
  | { signal: "confirm"; message: string }
  | { signal: "constrain"; constraints: PolicyConstraint[] };

/**
 * The typed rule representation: the rule list IS the declarative policy for
 * this slice. Each rule is a named, phase- and kind-tagged pure predicate
 * over the decision request. Loading external/tenant-authored policy is #28+
 * territory; adding a rule here is one entry + (if it denies) one reason code
 * + one mapping row, enforced by the exhaustive mapping tables.
 */
export type PolicyRule = {
  id: string;
  kinds: readonly PolicyRequestKind[];
  phases: readonly PolicyPhase[];
  evaluate: (request: PolicyDecisionRequest) => PolicyRuleSignal | undefined;
};

const DEFAULT_CONFIRMATION_MESSAGE = "Confirm this action before continuing.";

const interactionStatusRule: PolicyRule = {
  id: "interaction-status",
  kinds: ["envelope"],
  phases: ["invoke"],
  evaluate: ({ interaction }) => {
    if (interaction.status === "revoked") {
      return {
        signal: "deny",
        reason: "interaction_revoked",
        message: "This interaction has been revoked.",
      };
    }

    if (interaction.status === "archived") {
      return {
        signal: "deny",
        reason: "interaction_unavailable",
        message: "This interaction is not active.",
      };
    }

    return undefined;
  },
};

const interactionVersionRule: PolicyRule = {
  id: "interaction-version",
  kinds: ["envelope"],
  phases: ["invoke"],
  evaluate: (request) => {
    if (request.kind !== "envelope") {
      return undefined;
    }

    if (request.interaction.version !== request.request.interactionVersion) {
      return {
        signal: "deny",
        reason: "interaction_version_mismatch",
        message: "This interaction version is not available.",
      };
    }

    return undefined;
  },
};

const idempotencyRequiredRule: PolicyRule = {
  id: "idempotency-required",
  kinds: ["envelope"],
  phases: ["invoke"],
  evaluate: (request) => {
    if (request.kind !== "envelope") {
      return undefined;
    }

    if (
      request.interaction.idempotency === "required" &&
      !request.request.idempotencyKey
    ) {
      return {
        signal: "deny",
        reason: "idempotency_key_required",
        message: "This interaction requires an idempotency key.",
      };
    }

    return undefined;
  },
};

/**
 * Emits the invocation's action-call budget as constraints. Enforcement is
 * owned by `applyConstraints`: the runtime cannot execute actions without
 * threading the constrained execution context it returns.
 */
const actionCallBudgetRule: PolicyRule = {
  id: "action-call-budget",
  kinds: ["envelope"],
  phases: ["invoke"],
  evaluate: (request) => {
    if (request.kind !== "envelope") {
      return undefined;
    }

    const constraints: PolicyConstraint[] = [
      { kind: "maxTotalActionCalls", value: request.budget.maxActionCalls },
    ];

    for (const allowedAction of request.budget.allowedActions) {
      if (allowedAction.maxCalls !== undefined) {
        constraints.push({
          kind: "maxActionCalls",
          actionId: allowedAction.id,
          value: allowedAction.maxCalls,
        });
      }
    }

    return { signal: "constrain", constraints };
  },
};

const confirmationSubjectRule: PolicyRule = {
  id: "confirmation-subject",
  kinds: ["confirmation"],
  phases: ["invoke"],
  evaluate: ({ auth, interaction }) => {
    if (!interaction.confirmation.required) {
      return undefined;
    }

    if (resolveAuthSubject(auth) === "") {
      // Never confirm for an anonymous subject: a token bound to an empty
      // subject would be replayable across every unauthenticated caller.
      return {
        signal: "deny",
        reason: "confirmation_subject_required",
        message:
          "Confirmation requires an identified subject in the auth context.",
      };
    }

    return undefined;
  },
};

const confirmationIdempotencyRule: PolicyRule = {
  id: "confirmation-idempotency",
  kinds: ["confirmation"],
  phases: ["invoke"],
  evaluate: (request) => {
    if (request.kind !== "confirmation") {
      return undefined;
    }

    // Confirmation implies mandatory idempotency: the idempotency ledger is
    // the replay guard that makes "confirm once -> execute once" true.
    if (
      request.interaction.confirmation.required &&
      !request.request.idempotencyKey
    ) {
      return {
        signal: "deny",
        reason: "confirmation_idempotency_key_required",
        message:
          "This interaction requires confirmation, so an idempotency key is required. Provide idempotencyKey and retry.",
      };
    }

    return undefined;
  },
};

const CONFIRMATION_FAILURE_SIGNALS: Record<
  PolicyConfirmationFailure,
  Extract<PolicyRuleSignal, { signal: "deny" }>
> = {
  expired: {
    signal: "deny",
    reason: "confirmation_expired",
    message:
      "The confirmation token has expired. Re-invoke without a confirmation token to get a fresh confirmation.",
  },
  mismatch: {
    signal: "deny",
    reason: "confirmation_input_mismatch",
    message:
      "The request changed since it was confirmed. Resend the exact request you confirmed, or re-invoke without a confirmation token to confirm the new request.",
  },
  invalid: {
    signal: "deny",
    reason: "confirmation_invalid",
    message:
      "The confirmation token is malformed or was not issued by this kernel.",
  },
};

const confirmationStateRule: PolicyRule = {
  id: "confirmation-state",
  kinds: ["confirmation"],
  phases: ["invoke"],
  evaluate: ({ interaction }) => {
    const { required, message, token } = interaction.confirmation;

    if (!required) {
      return undefined;
    }

    if (!token.presented) {
      return {
        signal: "confirm",
        message: message ?? DEFAULT_CONFIRMATION_MESSAGE,
      };
    }

    if (token.verified) {
      // Verified re-entry: do NOT re-emit confirm — the confirmed request
      // proceeds (and per-action rules re-apply on this second pass).
      return undefined;
    }

    // failure === null means the kernel has not verified the token yet; stay
    // silent so the precondition rules decide round one, then the kernel
    // verifies and consults again with the result.
    return token.failure === null
      ? undefined
      : CONFIRMATION_FAILURE_SIGNALS[token.failure];
  },
};

/**
 * Live authority revocation (#25). Consulted per action call against the
 * kernel-refreshed snapshot: if the interaction, credential, or this specific
 * invocation was revoked mid-run, the NEXT action call is denied immediately.
 * Ordered first among action rules so revocation supersedes effect/permission
 * reasons — a withdrawn authority is the strongest signal. Invoke phase only:
 * publish never carries a live snapshot.
 */
const liveRevocationRule: PolicyRule = {
  id: "live-revocation",
  kinds: ["action"],
  phases: ["invoke"],
  evaluate: (request) => {
    if (request.kind !== "action") {
      return undefined;
    }

    const revoked = request.liveState?.revoked;

    if (revoked === undefined) {
      return undefined;
    }

    return {
      signal: "deny",
      reason: "interaction_revoked",
      message:
        "This interaction's authority was revoked during execution; further action calls are denied.",
    };
  },
};

/**
 * Live budget exhaustion (#25). Deny-next semantics: when the cumulative
 * budget could not absorb this call's cost, the call is denied (the debit was
 * already attempted by the kernel before consulting the engine). Distinct from
 * the frozen per-invocation `maxActionCalls` counter — this reads shared /
 * cross-invocation budget through an injected ledger.
 */
const liveBudgetRule: PolicyRule = {
  id: "live-budget",
  kinds: ["action"],
  phases: ["invoke"],
  evaluate: (request) => {
    if (request.kind !== "action") {
      return undefined;
    }

    if (request.liveState?.budgetExhausted !== true) {
      return undefined;
    }

    return {
      signal: "deny",
      reason: "budget_exhausted",
      message:
        "This interaction's budget was exhausted during execution; further action calls are denied.",
    };
  },
};

const effectCeilingRule: PolicyRule = {
  id: "effect-ceiling",
  kinds: ["action"],
  phases: ["invoke", "publish"],
  evaluate: (request) => {
    if (request.kind !== "action") {
      return undefined;
    }

    if (
      !interactionActionEffectExceedsDeclared({
        actionEffect: request.action.effects,
        declaredEffect: request.interaction.declaredEffect,
      })
    ) {
      return undefined;
    }

    return {
      signal: "deny",
      reason: "effect_exceeds_declared",
      message:
        request.phase === "publish"
          ? `Action "${request.allowedAction.id}" exceeds the declared interaction effect.`
          : "This action exceeds the interaction effect declaration.",
    };
  },
};

/**
 * Phase-parameterized permission rule — the one deliberately divergent rule.
 * Publish matches required permissions against grants (scopes + permissions)
 * with wildcard support; invoke matches against exact permission entries
 * only. Both behaviors are pinned by regression tests; unifying them is a
 * deliberate behavior change deferred past this slice.
 */
const requiredPermissionsRule: PolicyRule = {
  id: "required-permissions",
  kinds: ["action"],
  phases: ["invoke", "publish"],
  evaluate: (request) => {
    if (request.kind !== "action") {
      return undefined;
    }

    const requiredPermissions = request.action.requiredPermissions ?? [];

    if (request.phase === "publish") {
      const grantedGrants = collectInteractionAuthGrants(request.auth);
      const missingPermission = requiredPermissions.find(
        (permission) =>
          !grantedGrants.some((grantedGrant) =>
            grantAllows({ grantedGrant, requiredGrant: permission }),
          ),
      );

      if (missingPermission === undefined) {
        return undefined;
      }

      return {
        signal: "deny",
        reason: "permission_denied",
        message: `The current auth context cannot publish action "${request.allowedAction.id}".`,
      };
    }

    const grantedPermissions = new Set(
      collectInteractionAuthPermissions(request.auth),
    );
    const missingPermission = requiredPermissions.find(
      (permission) => !grantedPermissions.has(permission),
    );

    if (missingPermission === undefined) {
      return undefined;
    }

    return {
      signal: "deny",
      reason: "permission_denied",
      message: "The current auth context cannot call this action.",
    };
  },
};

const tenantScopeRule: PolicyRule = {
  id: "tenant-scope",
  kinds: ["action"],
  phases: ["invoke", "publish"],
  evaluate: (request) => {
    if (request.kind !== "action") {
      return undefined;
    }

    if (!interactionActionRequiresTenantScope(request.action.effects)) {
      return undefined;
    }

    if (
      interactionTenantScopeAllowsAuth({
        auth: request.auth,
        tenantScope: request.action.tenantScope,
      })
    ) {
      return undefined;
    }

    return {
      signal: "deny",
      reason: "tenant_mismatch",
      message:
        request.phase === "publish"
          ? `The current auth context cannot publish action "${request.allowedAction.id}" for this tenant.`
          : "The current auth context cannot access this tenant.",
    };
  },
};

/**
 * Rule order is the deny tiebreak: when several rules deny, the first one in
 * this list wins, which preserves the pre-engine error ordering.
 */
export const POLICY_RULES: readonly PolicyRule[] = [
  interactionStatusRule,
  interactionVersionRule,
  idempotencyRequiredRule,
  actionCallBudgetRule,
  confirmationSubjectRule,
  confirmationIdempotencyRule,
  confirmationStateRule,
  // Live-state rules first among action rules: a revoked authority or an
  // exhausted budget supersedes the frozen-at-launch effect/permission checks.
  liveRevocationRule,
  liveBudgetRule,
  effectCeilingRule,
  requiredPermissionsRule,
  tenantScopeRule,
];

export function decidePolicy(request: EnvelopePolicyRequest): EnvelopePolicyDecision;
export function decidePolicy(
  request: ConfirmationPolicyRequest,
): ConfirmationPolicyDecision;
export function decidePolicy(
  request: ActionPolicyRequest & { phase: "publish" },
): PublishPolicyDecision;
export function decidePolicy(request: ActionPolicyRequest): ActionPolicyDecision;
export function decidePolicy(request: PolicyDecisionRequest): PolicyDecision;
export function decidePolicy(request: PolicyDecisionRequest): PolicyDecision {
  const signals: PolicyRuleSignal[] = [];

  for (const rule of POLICY_RULES) {
    if (!rule.kinds.includes(request.kind) || !rule.phases.includes(request.phase)) {
      continue;
    }

    const signal = rule.evaluate(request);

    if (signal !== undefined) {
      signals.push(signal);
    }
  }

  return resolvePolicySignals(signals);
}

/**
 * Evaluate-all-then-select precedence: deny > confirm > constrain > allow.
 * Exported so the precedence contract itself is directly testable.
 */
export function resolvePolicySignals(
  signals: readonly PolicyRuleSignal[],
): PolicyDecision {
  const deny = signals.find(
    (signal): signal is Extract<PolicyRuleSignal, { signal: "deny" }> =>
      signal.signal === "deny",
  );

  if (deny) {
    return { outcome: "deny", reason: deny.reason, message: deny.message };
  }

  const confirm = signals.find(
    (signal): signal is Extract<PolicyRuleSignal, { signal: "confirm" }> =>
      signal.signal === "confirm",
  );

  if (confirm) {
    // A confirmation supersedes shaping: accumulated constraints are
    // discarded and re-apply on the post-confirmation re-entry.
    return {
      outcome: "confirm",
      reason: "confirmation_required",
      message: confirm.message,
      confirmation: { message: confirm.message },
    };
  }

  const constraints = signals.flatMap((signal) =>
    signal.signal === "constrain" ? signal.constraints : [],
  );

  if (constraints.length > 0) {
    const merged = mergePolicyConstraints(constraints);

    if (!merged.ok) {
      // Conflicting tenant scopes fail closed: never silently drop one.
      return {
        outcome: "deny",
        reason: "tenant_mismatch",
        message: "Policy constraints require incompatible tenant scopes.",
      };
    }

    return {
      outcome: "constrain",
      reason: "constrained",
      constraints: merged.constraints,
    };
  }

  return { outcome: "allow", reason: "allowed" };
}

export type PolicyConstraintMergeResult =
  | { ok: true; constraints: PolicyConstraint[] }
  | { ok: false; reason: "tenant_scope_conflict" };

/**
 * Deterministic constraint algebra: `maxTotalActionCalls`/`maxActionCalls`
 * take the minimum, `redactPaths` the sorted deduped union, `tenantScope`
 * the intersection (an empty intersection is a conflict — the caller fails
 * closed to deny). The merged array is canonicalized (sorted by kind, then
 * action id) so equivalent inputs serialize identically.
 */
export function mergePolicyConstraints(
  constraints: readonly PolicyConstraint[],
): PolicyConstraintMergeResult {
  let maxTotal: number | undefined;
  const maxByActionId = new Map<string, number>();
  const redactPaths = new Set<string>();
  let tenantScope: RuntimeTenantScope | undefined;

  for (const constraint of constraints) {
    switch (constraint.kind) {
      case "maxTotalActionCalls":
        maxTotal =
          maxTotal === undefined
            ? constraint.value
            : Math.min(maxTotal, constraint.value);
        break;
      case "maxActionCalls": {
        const existing = maxByActionId.get(constraint.actionId);
        maxByActionId.set(
          constraint.actionId,
          existing === undefined
            ? constraint.value
            : Math.min(existing, constraint.value),
        );
        break;
      }
      case "redactPaths":
        for (const path of constraint.paths) {
          redactPaths.add(path);
        }
        break;
      case "tenantScope": {
        const intersection =
          tenantScope === undefined
            ? constraint.scope
            : intersectTenantScopes(tenantScope, constraint.scope);

        if (intersection === undefined) {
          return { ok: false, reason: "tenant_scope_conflict" };
        }

        tenantScope = intersection;
        break;
      }
    }
  }

  const merged: PolicyConstraint[] = [
    ...[...maxByActionId.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([actionId, value]): PolicyConstraint => ({
        kind: "maxActionCalls",
        actionId,
        value,
      })),
    ...(maxTotal === undefined
      ? []
      : [{ kind: "maxTotalActionCalls", value: maxTotal } as const]),
    ...(redactPaths.size === 0
      ? []
      : [{ kind: "redactPaths", paths: [...redactPaths].sort() } as const]),
    ...(tenantScope === undefined
      ? []
      : [{ kind: "tenantScope", scope: tenantScope } as const]),
  ];

  return { ok: true, constraints: merged };
}

function intersectTenantScopes(
  left: RuntimeTenantScope,
  right: RuntimeTenantScope,
): RuntimeTenantScope | undefined {
  const tenantId = intersectScopeField(left.tenantId, right.tenantId);
  const salonId = intersectScopeField(left.salonId, right.salonId);
  const fromAuth = intersectScopeField(left.fromAuth, right.fromAuth);

  if (
    tenantId === CONFLICT ||
    salonId === CONFLICT ||
    fromAuth === CONFLICT
  ) {
    return undefined;
  }

  return {
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(salonId === undefined ? {} : { salonId }),
    ...(fromAuth === undefined ? {} : { fromAuth }),
  };
}

const CONFLICT = Symbol("tenant-scope-conflict");

function intersectScopeField<T>(
  left: T | undefined,
  right: T | undefined,
): T | undefined | typeof CONFLICT {
  if (left === undefined) {
    return right;
  }

  if (right === undefined || left === right) {
    return left;
  }

  return CONFLICT;
}

export type ConstrainedActionCallResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * The execution-side handle for a `constrain` decision. The runtime action
 * caller cannot dispatch an action without registering the call here first,
 * so a caller physically cannot "forget" a constraint.
 */
export type ConstrainedExecutionContext = {
  constraints: readonly PolicyConstraint[];
  /** Merged audit redaction paths (none emitted by current rules). */
  redactPaths: readonly string[];
  /** Narrowed tenant scope (none emitted by current rules). */
  tenantScope: RuntimeTenantScope | undefined;
  /**
   * Registers an attempted action call against the budget. Counts every
   * attempt — including calls that later fail registration or policy — so a
   * misbehaving interaction burns budget on rejected calls too.
   */
  registerActionCall: (actionId: string) => ConstrainedActionCallResult;
};

/**
 * Constraint enforcement is owned by the engine, not re-scattered to
 * callers: `applyConstraints` turns a `constrain` decision into the only
 * context through which the runtime may count and admit action calls.
 */
export function applyConstraints(
  constraints: readonly PolicyConstraint[],
): ConstrainedExecutionContext {
  let maxTotalActionCalls: number | undefined;
  const maxCallsByActionId = new Map<string, number>();
  const redactPaths: string[] = [];
  let tenantScope: RuntimeTenantScope | undefined;

  for (const constraint of constraints) {
    switch (constraint.kind) {
      case "maxTotalActionCalls":
        maxTotalActionCalls =
          maxTotalActionCalls === undefined
            ? constraint.value
            : Math.min(maxTotalActionCalls, constraint.value);
        break;
      case "maxActionCalls": {
        const existing = maxCallsByActionId.get(constraint.actionId);
        maxCallsByActionId.set(
          constraint.actionId,
          existing === undefined
            ? constraint.value
            : Math.min(existing, constraint.value),
        );
        break;
      }
      case "redactPaths":
        redactPaths.push(...constraint.paths);
        break;
      case "tenantScope":
        tenantScope = constraint.scope;
        break;
    }
  }

  let totalActionCalls = 0;
  const callsByActionId = new Map<string, number>();

  return {
    constraints,
    redactPaths: [...new Set(redactPaths)].sort(),
    tenantScope,
    registerActionCall: (actionId) => {
      totalActionCalls += 1;
      const actionCalls = (callsByActionId.get(actionId) ?? 0) + 1;
      callsByActionId.set(actionId, actionCalls);

      if (
        maxTotalActionCalls !== undefined &&
        totalActionCalls > maxTotalActionCalls
      ) {
        return {
          ok: false,
          message: "This interaction exceeded its action call limit.",
        };
      }

      const maxCalls = maxCallsByActionId.get(actionId);

      if (maxCalls !== undefined && actionCalls > maxCalls) {
        return {
          ok: false,
          message: "This interaction exceeded an action call limit.",
        };
      }

      return { ok: true };
    },
  };
}

/**
 * #25 seam — NOW REALIZED. The reserved live-state hook is fulfilled by the
 * runtime's `ExecutionAuthorityGuard` (`execution-authority.ts`): before each
 * action call the kernel consults its impure revocation/budget ports, folds the
 * result into a {@link PolicyLiveStateSnapshot}, and passes that value into the
 * `action` decision request. `decidePolicy` stays pure — the `live-revocation`
 * and `live-budget` rules read the snapshot, never the ports. This hook type is
 * the sync projection the guard produces per call; it is retained so a future
 * pure caller can drive the same rules directly from a precomputed snapshot.
 */
export type PolicyLiveStateHook = {
  budgetRemaining?: (args: {
    auth: RuntimeAuthContext;
    interaction: { id: string; version: string };
    now: number;
  }) => number | undefined;
  isAuthorityRevoked?: (args: {
    auth: RuntimeAuthContext;
    interaction: { id: string; version: string };
    now: number;
  }) => boolean;
};

function grantAllows({
  grantedGrant,
  requiredGrant,
}: {
  grantedGrant: string;
  requiredGrant: string;
}): boolean {
  if (grantedGrant === "*" || grantedGrant === requiredGrant) {
    return true;
  }

  if (!grantedGrant.endsWith(":*")) {
    return false;
  }

  return requiredGrant.startsWith(grantedGrant.slice(0, -1));
}
