/**
 * Execution authority guard (#25) — live budget + revocation enforced DURING
 * execution.
 *
 * Frozen-at-launch authority is not enough: an operator may revoke an
 * interaction / credential / invocation, or a cumulative budget may run dry,
 * WHILE an interaction runs. The natural enforcement seam already exists — every
 * action call from generated (or static) interaction code is mediated
 * synchronously on the host side (`createTrustedRuntimeActionCaller.call`). This
 * module is the impure consumer that plugs into the #26 policy engine's
 * live-state seam: before each action call the guard consults its injected
 * ports, produces a {@link PolicyLiveStateSnapshot}, and hands that value to the
 * pure `decidePolicy`. The engine's `live-revocation` / `live-budget` rules
 * decide; the guard never decides on its own — it is a single-sourced input to
 * the one decision seam, not a second scattered check.
 *
 * Semantics (per plan, adapted to the merged engine):
 *   - Revocation: deny-next. Once revoked, EVERY subsequent action call is
 *     denied with `interaction_revoked`. (Hard mid-action abort via the
 *     interaction AbortController is the reserved upgrade — see the `revoked`
 *     `severity` field; this slice enforces deny-next, which the generated code
 *     observes as a thrown `action_result { ok:false }`.)
 *   - Budget: deny-next. A cumulative debit is attempted before the effect; if
 *     it cannot be satisfied the call is denied with `budget_exhausted`. The
 *     debit happens at the choke point (host side), so the sandbox path cannot
 *     bypass it.
 *
 * Fail-closed: a port that throws or rejects denies the call (a security
 * feature must not fail open). The static per-invocation counters remain the
 * always-available floor.
 *
 * Determinism: the guard reads no wall clock of its own — `now` is injected and
 * threaded into every port call, so a test with a fixed clock is fully
 * deterministic. Persistent stores are #44; this slice ships in-memory reference
 * ports in the app and leaves the typed seam here.
 */
import type { RuntimeAuthContext } from "./action-catalog.ts";
import type { PolicyLiveStateSnapshot } from "./policy-engine.ts";

/** Stable identity of a running invocation, passed to every port call. */
export type ExecutionAuthorityIdentity = {
  invocationId: string;
  interactionId: string;
  interactionVersion: string;
  auth: RuntimeAuthContext;
};

/** A structured revocation reason surfaced to the caller and the trace. */
export type RevocationReason = {
  /**
   * Which authority was withdrawn. `interaction` / `credential` / `invocation`
   * cover the three revocation scopes the plan calls out; the field is free-form
   * so a persistent store (#44) can add scopes without a contract break.
   */
  scope: "interaction" | "credential" | "invocation" | (string & {});
  /**
   * `abort` = hard revocation (reserved: also abort the in-flight action via the
   * interaction AbortController); `deny_next` = soft (deny subsequent calls
   * only). This slice enforces deny-next for both, with `abort` as the seam.
   */
  severity: "abort" | "deny_next";
  message?: string;
};

export type RevocationCheck = ExecutionAuthorityIdentity & { now: number };

export type RevocationChecker = {
  /**
   * Returns a revocation reason if authority has been withdrawn, else
   * undefined. Consulted read-through on EVERY action call (no TTL cache — a
   * cache is a fail-open window exactly equal to the TTL).
   */
  isRevoked(check: RevocationCheck): Promise<RevocationReason | undefined>;
};

export type BudgetDebit = ExecutionAuthorityIdentity & {
  actionId: string;
  units: number;
  now: number;
};

export type BudgetDecision =
  | { ok: true }
  | { ok: false; reason?: string };

export type BudgetLedger = {
  /**
   * Attempts to debit `units` of cumulative/shared budget for this action call.
   * Shaped as a reservation so a later action-reported-cost model (dollars /
   * tokens) drops in without a contract break. Returns `{ ok: false }` when the
   * budget cannot absorb the debit → the engine denies with `budget_exhausted`.
   */
  tryDebit(debit: BudgetDebit): Promise<BudgetDecision>;
  /**
   * Refunds a debit that never reached the external effect (pre-dispatch
   * rejection). Refunds after a possibly-applied effect are unsafe and are NOT
   * issued.
   */
  refund?(debit: BudgetDebit): Promise<void>;
};

/**
 * Budget descriptor resolved from the interaction artifact (#25 config). Units
 * are integer quota, weighted per action via the catalog — a rate-limit
 * primitive, not a dollar/token spend budget (real currency metering is out of
 * scope for this slice).
 */
export type ExecutionBudgetPolicy = {
  /** Cost charged per action call unless overridden. Defaults to 1. */
  defaultUnitsPerAction?: number;
  /** Per-action cost overrides keyed by action id. */
  unitsByActionId?: Record<string, number>;
};

export type ExecutionAuthorityGuard = {
  /**
   * Consulted at the action-call choke point BEFORE the effect. Attempts the
   * budget debit and the revocation read, folds both into the live-state
   * snapshot the pure engine consumes, and returns it plus the settlement
   * handle. Never throws for a denial — a denial is expressed in the snapshot so
   * the single engine decision remains the source of truth.
   */
  authorizeActionCall(args: {
    actionId: string;
    now: number;
  }): Promise<{
    liveState: PolicyLiveStateSnapshot;
    /** The debit that was attempted, so the caller can refund pre-dispatch. */
    settle: ExecutionActionCallSettlement;
  }>;
};

export type ExecutionActionCallSettlement = {
  /**
   * Refund the attempted debit. Called only when the action call is rejected
   * BEFORE the external effect (schema-invalid input, a policy deny). No-op when
   * no debit was charged or the ledger has no `refund`.
   */
  refundIfUncharged(): Promise<void>;
};

const NO_OP_SETTLEMENT: ExecutionActionCallSettlement = {
  async refundIfUncharged() {},
};

const AUTHORITY_INTACT: PolicyLiveStateSnapshot = {};

/**
 * Builds the per-invocation guard. Both ports are OPTIONAL: when neither is
 * supplied the guard always returns an empty ("authority intact") snapshot, so
 * an execution without live-state ports behaves exactly like today — this keeps
 * the change additive and every pre-existing test unchanged.
 */
export function createExecutionAuthorityGuard(options: {
  identity: ExecutionAuthorityIdentity;
  revocation?: RevocationChecker;
  budget?: BudgetLedger;
  budgetPolicy?: ExecutionBudgetPolicy;
  /**
   * Optional structured sink for denial/debit audit marks (vision principle
   * #8). Threaded from the sandbox tracing recorder when present.
   */
  onEvent?: (event: ExecutionAuthorityEvent) => void;
}): ExecutionAuthorityGuard {
  const { identity, revocation, budget, budgetPolicy, onEvent } = options;

  if (revocation === undefined && budget === undefined) {
    return {
      async authorizeActionCall() {
        return { liveState: AUTHORITY_INTACT, settle: NO_OP_SETTLEMENT };
      },
    };
  }

  const resolveUnits = (actionId: string): number =>
    budgetPolicy?.unitsByActionId?.[actionId] ??
    budgetPolicy?.defaultUnitsPerAction ??
    1;

  /**
   * Audit sinks must never interrupt authorization. A throwing `onEvent`
   * (finding #2) would otherwise reject `authorizeActionCall` AFTER a debit
   * consumed budget but before the settlement handle is returned — permanently
   * leaking the quota. Swallow (optionally warn) so the security decision is
   * never masked by an observability failure.
   */
  const emit = (event: ExecutionAuthorityEvent): void => {
    if (onEvent === undefined) {
      return;
    }
    try {
      onEvent(event);
    } catch (error) {
      console.warn("execution-authority onEvent sink threw; ignoring", error);
    }
  };

  return {
    async authorizeActionCall({ actionId, now }) {
      // Revocation first (security supersedes budget). Fail closed on throw.
      let revoked: RevocationReason | undefined;

      if (revocation !== undefined) {
        try {
          revoked = await revocation.isRevoked({ ...identity, now });
        } catch {
          revoked = {
            scope: "interaction",
            severity: "abort",
            message: "The revocation port failed; failing closed (denied).",
          };
        }
      }

      if (revoked !== undefined) {
        emit({ kind: "revocation-denied", actionId, reason: revoked });
        return {
          liveState: { revoked: { reason: revoked.message ?? revoked.scope } },
          settle: NO_OP_SETTLEMENT,
        };
      }

      if (budget === undefined) {
        return { liveState: AUTHORITY_INTACT, settle: NO_OP_SETTLEMENT };
      }

      const units = resolveUnits(actionId);

      // Finding #3: fail CLOSED on a bad resolved cost. A negative unit count
      // would *increase* the balance, and NaN makes `remaining - NaN < 0` false
      // forever (exhaustion permanently unreachable → fail-open). A budget must
      // never be silently disabled or expanded by config: reject the call.
      if (!Number.isInteger(units) || units <= 0) {
        emit({ kind: "budget-config-invalid", actionId, units });
        return {
          liveState: { budgetExhausted: true },
          settle: NO_OP_SETTLEMENT,
        };
      }

      const debit: BudgetDebit = { ...identity, actionId, units, now };

      let decision: BudgetDecision;

      try {
        // Preserve the `this` receiver (finding #1): a class-based ledger using
        // `this` in tryDebit throws a TypeError if the method is destructured.
        decision = await budget.tryDebit(debit);
      } catch {
        // Fail closed: a ledger that cannot answer denies the call.
        emit({ kind: "budget-port-failed", actionId, units });
        return {
          liveState: { budgetExhausted: true },
          settle: NO_OP_SETTLEMENT,
        };
      }

      if (!decision.ok) {
        emit({
          kind: "budget-exhausted",
          actionId,
          units,
          reason: decision.reason,
        });
        return {
          liveState: { budgetExhausted: true },
          settle: NO_OP_SETTLEMENT,
        };
      }

      emit({ kind: "budget-debited", actionId, units });

      // Debit succeeded. Expose a settlement that refunds it if the call is
      // rejected before the external effect runs.
      let charged = true;
      const settle: ExecutionActionCallSettlement = {
        async refundIfUncharged() {
          if (!charged || budget.refund === undefined) {
            return;
          }
          charged = false;
          // Call through `budget` to preserve the `this` receiver (finding #1):
          // destructuring `budget.refund` loses `this`, so a class-based
          // BudgetLedger using `this` in refund would throw a TypeError and the
          // pre-dispatch refund would fail, leaving the budget consumed.
          await budget.refund(debit);
          emit({ kind: "budget-refunded", actionId, units });
        },
      };

      return { liveState: AUTHORITY_INTACT, settle };
    },
  };
}

export type ExecutionAuthorityEvent =
  | { kind: "revocation-denied"; actionId: string; reason: RevocationReason }
  | { kind: "budget-exhausted"; actionId: string; units: number; reason?: string }
  | { kind: "budget-port-failed"; actionId: string; units: number }
  | { kind: "budget-config-invalid"; actionId: string; units: number }
  | { kind: "budget-debited"; actionId: string; units: number }
  | { kind: "budget-refunded"; actionId: string; units: number };

/** Injected live-state ports, threaded from `createTidegateRuntime` options. */
export type ExecutionAuthorityPorts = {
  revocation?: RevocationChecker;
  budget?: BudgetLedger;
  /**
   * Optional per-action budget weighting (units quota). Defaults to 1 unit per
   * call. Real dollar/token metering is out of scope; this is a rate-limit
   * primitive shaped so cost reporting drops in later.
   */
  budgetPolicy?: ExecutionBudgetPolicy;
  /** Optional structured sink for denial/debit audit marks. */
  onEvent?: (event: ExecutionAuthorityEvent) => void;
};
