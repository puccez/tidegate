/**
 * Effective capability set (#28) — the per-execution intersection of the
 * published catalog allowlist × the caller's credential permissions × the
 * caller's tenant scope, computed ONCE per invocation and consumed by BOTH
 * sandbox capability injection and call-time enforcement so the two can
 * never diverge (`capabilitiesMatchAllowedActions` stays green).
 *
 * Invariants:
 *
 * - **Restrict, never widen.** The computation iterates only the published
 *   allowlist, so `grantedActionIds ⊆ declaredActionIds` by construction and
 *   `declaredActionIds` is exactly the published allowlist — an action the
 *   catalog never published cannot appear, and a declared action is never
 *   silently dropped from the injected surface.
 * - **Denied-but-declared actions stay injected as denied stubs.** A
 *   withheld capability keeps its slot in the declared surface (the sandbox
 *   still receives the typed capability), and calling it throws the same
 *   structured error the live per-call path produces (`permission_denied`,
 *   `tenant_mismatch`, …) — never a missing-property `interaction_failed`.
 * - **Additional gate, not a replacement.** The live per-call checks in the
 *   trusted action caller remain as defense in depth; the snapshot gate just
 *   makes the static decision once, at execution start.
 * - **Engine-decided.** Each declared action is admitted or withheld by the
 *   #26 policy engine (`decidePolicy`, kind `"action"`, phase `"invoke"`),
 *   not by re-implemented predicates. Future dimensions (consent,
 *   environment) plug in as new action-kind rules in the engine's rule
 *   library — or through the injectable {@link EffectiveCapabilityPolicyDecider}
 *   seam — without touching this computation.
 * - **Input-independent.** The snapshot is computed before any action input
 *   exists, so `input` is `undefined` in the decision request. No current
 *   action-kind rule reads input; an input-dependent rule would be enforced
 *   by the live per-call gate, which re-decides with the real input.
 * - **Server-trusted inputs only.** Auth context, registered catalog, and
 *   published allowlist all come from the kernel; generated code never
 *   participates in the computation.
 */
import type { InvokeInteractionErrorCode } from "@tidegate/contracts";
import type { AnyRuntimeAction, RuntimeAuthContext } from "./action-catalog.ts";
import {
  decidePolicy,
  INVOKE_POLICY_DENY_CODES,
  type ActionPolicyDecision,
  type ActionPolicyRequest,
  type InvokePolicyDenyReason,
  type PolicyInteractionHeader,
} from "./policy-engine.ts";

/** The published allowlist entry shape the computation needs (structural). */
export type EffectiveCapabilityAllowedAction = {
  readonly id: string;
  readonly maxCalls?: number;
  readonly timeoutMs?: number;
};

/**
 * In practice the engine's action-kind rules only emit
 * `effect_exceeds_declared` / `permission_denied` / `tenant_mismatch`, but
 * the seam is typed over every invoke deny reason so a future rule (or a
 * custom decider) that denies with a new reason still maps to a closed wire
 * code through the exhaustive `INVOKE_POLICY_DENY_CODES` table — fail
 * closed, never an untyped error.
 */
export type EffectiveCapabilityWithholdReason =
  | "action_not_registered"
  | InvokePolicyDenyReason;

export type GrantedEffectiveCapability = {
  status: "granted";
  allowedAction: EffectiveCapabilityAllowedAction;
  /**
   * The registered action, snapshotted at computation time so the effective
   * set is immutable for the execution's lifetime: this ref is what the
   * trusted action caller executes, so a catalog entry replaced after
   * computation cannot swap in a new implementation or schemas. (The live
   * per-call path keeps an existence check against the live catalog as
   * defense in depth — removal mid-execution still fails closed.)
   */
  action: AnyRuntimeAction;
};

export type WithheldEffectiveCapability = {
  status: "withheld";
  allowedAction: EffectiveCapabilityAllowedAction;
  reason: EffectiveCapabilityWithholdReason;
  /** The closed public wire code this withholding surfaces as at call time. */
  code: InvokeInteractionErrorCode;
  /** The exact message the live per-call path produces for this denial. */
  message: string;
};

export type EffectiveCapability =
  | GrantedEffectiveCapability
  | WithheldEffectiveCapability;

export type EffectiveCapabilitySet = {
  interactionId: string;
  interactionVersion: string;
  /**
   * The full published allowlist, order preserved — the injected capability
   * surface. Never narrowed: withheld actions keep their slot as denied
   * stubs so injection and enforcement stay derived from this one object.
   */
  declaredActionIds: readonly string[];
  /** The survivors: declared ∩ registered ∩ permitted ∩ tenant-scoped. */
  grantedActionIds: readonly string[];
  withheld: readonly WithheldEffectiveCapability[];
  capabilities: ReadonlyMap<string, EffectiveCapability>;
};

/**
 * The evaluator seam for future capability dimensions: defaults to the #26
 * policy engine's `decidePolicy`. Consent/environment resolvers land as new
 * action-kind rules in the engine (or a wrapped decider here) — the
 * computation itself never changes.
 */
export type EffectiveCapabilityPolicyDecider = (
  request: ActionPolicyRequest,
) => ActionPolicyDecision;

const ACTION_NOT_REGISTERED_MESSAGE = "This action is not registered.";

export function computeEffectiveCapabilitySet({
  actions,
  allowedActions,
  auth,
  decide = decidePolicy,
  interaction,
  now,
}: {
  /** The live registered action catalog; granted refs are snapshotted. */
  actions: ReadonlyMap<string, AnyRuntimeAction>;
  /** The published allowlist — the upper bound the set can only restrict. */
  allowedActions: readonly EffectiveCapabilityAllowedAction[];
  auth: RuntimeAuthContext;
  decide?: EffectiveCapabilityPolicyDecider;
  interaction: PolicyInteractionHeader;
  now: number;
}): EffectiveCapabilitySet {
  const capabilities = new Map<string, EffectiveCapability>();
  const declaredActionIds: string[] = [];
  const grantedActionIds: string[] = [];
  const withheld: WithheldEffectiveCapability[] = [];

  for (const allowedAction of allowedActions) {
    // A duplicate id keeps its slot in the declared surface: the injected
    // payload must mirror the published allowlist element-for-element (the
    // payload construction gate compares them exactly), so dropping a
    // duplicate here would turn every invoke of such an artifact into an
    // `interaction_failed`. Publish-time validation rejects duplicates, but
    // artifacts can reach the runtime from external stores and the contract
    // schema does not forbid them — the sandbox's capability-metadata match
    // stays the enforcement point, exactly as before the snapshot existed.
    declaredActionIds.push(allowedAction.id);

    if (capabilities.has(allowedAction.id)) {
      continue;
    }

    const entry = computeEffectiveCapability({
      actions,
      allowedAction,
      auth,
      decide,
      interaction,
      now,
    });
    capabilities.set(allowedAction.id, entry);

    if (entry.status === "granted") {
      grantedActionIds.push(allowedAction.id);
    } else {
      withheld.push(entry);
    }
  }

  return {
    interactionId: interaction.id,
    interactionVersion: interaction.version,
    declaredActionIds,
    grantedActionIds,
    withheld,
    capabilities,
  };
}

/**
 * Mirrors the live per-call order exactly — registration first, then the
 * engine's action-kind rules (effect ceiling > permissions > tenant scope by
 * declared rule order) — so a withheld capability throws the same error, in
 * the same precedence, as the pre-snapshot behavior.
 */
function computeEffectiveCapability({
  actions,
  allowedAction,
  auth,
  decide,
  interaction,
  now,
}: {
  actions: ReadonlyMap<string, AnyRuntimeAction>;
  allowedAction: EffectiveCapabilityAllowedAction;
  auth: RuntimeAuthContext;
  decide: EffectiveCapabilityPolicyDecider;
  interaction: PolicyInteractionHeader;
  now: number;
}): EffectiveCapability {
  const action = actions.get(allowedAction.id);

  if (!action) {
    return {
      status: "withheld",
      allowedAction,
      reason: "action_not_registered",
      code: "action_not_registered",
      message: ACTION_NOT_REGISTERED_MESSAGE,
    };
  }

  const decision = decide({
    kind: "action",
    phase: "invoke",
    auth,
    interaction,
    action,
    allowedAction,
    input: undefined,
    now,
  });

  if (decision.outcome === "deny") {
    return {
      status: "withheld",
      allowedAction,
      reason: decision.reason,
      code: INVOKE_POLICY_DENY_CODES[decision.reason],
      message: decision.message,
    };
  }

  return {
    status: "granted",
    allowedAction,
    action,
  };
}
