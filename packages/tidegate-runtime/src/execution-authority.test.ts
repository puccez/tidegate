import { describe, expect, test } from "bun:test";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import {
  createExecutionAuthorityGuard,
  type BudgetDebit,
  type BudgetLedger,
  type RevocationChecker,
} from "./execution-authority.ts";

const auth: RuntimeAuthContext = {
  organizationId: "demo-salon",
  subjectId: "demo-user",
  subjectType: "user",
  credentialId: "demo-session",
  credentialType: "session",
  scopes: ["tidegate:interaction:invoke"],
  userId: "demo-user",
  workosUserId: "demo-user",
  tenantId: "demo-salon",
  authorization: { permissions: ["booking:write"], resourceGrants: [] },
  permissions: ["booking:write"],
  authMode: "local-dev",
};

const identity = {
  invocationId: "inv_1",
  interactionId: "ix.booking.cancel",
  interactionVersion: "1",
  auth,
};

describe("createExecutionAuthorityGuard", () => {
  test("no ports → always authority-intact, no-op settlement", async () => {
    const guard = createExecutionAuthorityGuard({ identity });

    const result = await guard.authorizeActionCall({
      actionId: "booking.cancel",
      now: 0,
    });

    expect(result.liveState).toEqual({});
    // Refund is a no-op and must not throw.
    await result.settle.refundIfUncharged();
  });

  test("revocation → snapshot carries revoked reason", async () => {
    const revocation: RevocationChecker = {
      async isRevoked() {
        return { scope: "invocation", severity: "deny_next", message: "revoked" };
      },
    };
    const guard = createExecutionAuthorityGuard({ identity, revocation });

    const { liveState } = await guard.authorizeActionCall({
      actionId: "booking.cancel",
      now: 0,
    });

    expect(liveState.revoked).toEqual({ reason: "revoked" });
  });

  test("revocation fails closed when the port throws", async () => {
    const revocation: RevocationChecker = {
      async isRevoked() {
        throw new Error("store unreachable");
      },
    };
    const guard = createExecutionAuthorityGuard({ identity, revocation });

    const { liveState } = await guard.authorizeActionCall({
      actionId: "booking.cancel",
      now: 0,
    });

    expect(liveState.revoked).toBeDefined();
  });

  test("budget exhausted → snapshot flags budgetExhausted", async () => {
    const budget: BudgetLedger = {
      async tryDebit() {
        return { ok: false, reason: "quota" };
      },
    };
    const guard = createExecutionAuthorityGuard({ identity, budget });

    const { liveState } = await guard.authorizeActionCall({
      actionId: "booking.cancel",
      now: 0,
    });

    expect(liveState.budgetExhausted).toBe(true);
  });

  test("budget fails closed when the ledger throws", async () => {
    const budget: BudgetLedger = {
      async tryDebit() {
        throw new Error("ledger down");
      },
    };
    const guard = createExecutionAuthorityGuard({ identity, budget });

    const { liveState } = await guard.authorizeActionCall({
      actionId: "booking.cancel",
      now: 0,
    });

    expect(liveState.budgetExhausted).toBe(true);
  });

  test("revocation is checked before budget (no debit when revoked)", async () => {
    const debits: BudgetDebit[] = [];
    const revocation: RevocationChecker = {
      async isRevoked() {
        return { scope: "interaction", severity: "abort" };
      },
    };
    const budget: BudgetLedger = {
      async tryDebit(debit) {
        debits.push(debit);
        return { ok: true };
      },
    };
    const guard = createExecutionAuthorityGuard({ identity, revocation, budget });

    await guard.authorizeActionCall({ actionId: "booking.cancel", now: 0 });

    expect(debits).toHaveLength(0);
  });

  test("resolves units via per-action override, then default, then 1", async () => {
    const seen: number[] = [];
    const budget: BudgetLedger = {
      async tryDebit(debit) {
        seen.push(debit.units);
        return { ok: true };
      },
    };
    const guard = createExecutionAuthorityGuard({
      identity,
      budget,
      budgetPolicy: {
        defaultUnitsPerAction: 3,
        unitsByActionId: { "booking.cancel": 5 },
      },
    });

    await guard.authorizeActionCall({ actionId: "booking.cancel", now: 0 });
    await guard.authorizeActionCall({ actionId: "booking.other", now: 0 });

    expect(seen).toEqual([5, 3]);
  });

  test("refundIfUncharged refunds a successful debit exactly once", async () => {
    const refunds: BudgetDebit[] = [];
    const budget: BudgetLedger = {
      async tryDebit() {
        return { ok: true };
      },
      async refund(debit) {
        refunds.push(debit);
      },
    };
    const guard = createExecutionAuthorityGuard({ identity, budget });

    const { settle } = await guard.authorizeActionCall({
      actionId: "booking.cancel",
      now: 0,
    });

    await settle.refundIfUncharged();
    await settle.refundIfUncharged();

    expect(refunds).toHaveLength(1);
  });

  test("threads the injected clock into every port call (determinism)", async () => {
    const nows: number[] = [];
    const revocation: RevocationChecker = {
      async isRevoked(check) {
        nows.push(check.now);
        return undefined;
      },
    };
    const budget: BudgetLedger = {
      async tryDebit(debit) {
        nows.push(debit.now);
        return { ok: true };
      },
    };
    const guard = createExecutionAuthorityGuard({ identity, revocation, budget });

    await guard.authorizeActionCall({ actionId: "booking.cancel", now: 4242 });

    expect(nows).toEqual([4242, 4242]);
  });

  // Finding #1: the guard must preserve the ledger's `this` receiver so a
  // class-based BudgetLedger using `this` in refund/tryDebit works.
  test("refunds a class-based ledger (this receiver preserved) on pre-dispatch denial", async () => {
    class ClassLedger implements BudgetLedger {
      private balance = 5;
      readonly refunded: number[] = [];
      async tryDebit(d: BudgetDebit): Promise<{ ok: true } | { ok: false }> {
        // Using `this` here throws a TypeError if the method was destructured.
        this.balance -= d.units;
        return { ok: true };
      }
      async refund(d: BudgetDebit): Promise<void> {
        this.balance += d.units;
        this.refunded.push(d.units);
      }
      remaining(): number {
        return this.balance;
      }
    }
    const ledger = new ClassLedger();
    const guard = createExecutionAuthorityGuard({ identity, budget: ledger });

    const { settle } = await guard.authorizeActionCall({
      actionId: "booking.cancel",
      now: 0,
    });
    // A class-based ledger must refund without a TypeError on the `this` loss.
    await settle.refundIfUncharged();

    expect(ledger.refunded).toEqual([1]);
    expect(ledger.remaining()).toBe(5);
  });

  // Finding #2: a throwing audit sink must NOT interrupt authorization — a debit
  // that succeeded must still yield a refundable settlement handle.
  test("onEvent throwing on budget-debited still returns a refundable settlement", async () => {
    const refunds: BudgetDebit[] = [];
    const budget: BudgetLedger = {
      async tryDebit() {
        return { ok: true };
      },
      async refund(d) {
        refunds.push(d);
      },
    };
    const guard = createExecutionAuthorityGuard({
      identity,
      budget,
      onEvent: (event) => {
        if (event.kind === "budget-debited") {
          throw new Error("audit sink exploded");
        }
      },
    });

    // Must resolve (not reject) despite the throwing sink.
    const { liveState, settle } = await guard.authorizeActionCall({
      actionId: "booking.cancel",
      now: 0,
    });
    expect(liveState).toEqual({});

    await settle.refundIfUncharged();
    expect(refunds).toHaveLength(1);
  });

  // Finding #3: a bad resolved unit cost must FAIL CLOSED, never silently
  // disable (NaN) or expand (negative) the budget.
  for (const bad of [-1, 0, Number.NaN, 1.5]) {
    test(`fails closed on non-positive/NaN/non-integer units (${bad})`, async () => {
      let debited = false;
      const budget: BudgetLedger = {
        async tryDebit() {
          debited = true;
          return { ok: true };
        },
      };
      const guard = createExecutionAuthorityGuard({
        identity,
        budget,
        budgetPolicy: { defaultUnitsPerAction: bad },
      });

      const { liveState } = await guard.authorizeActionCall({
        actionId: "booking.cancel",
        now: 0,
      });

      expect(liveState.budgetExhausted).toBe(true);
      // Must never reach the ledger with an invalid cost.
      expect(debited).toBe(false);
    });
  }

  test("emits structured events for denials and debits", async () => {
    const events: string[] = [];
    const budget: BudgetLedger = {
      async tryDebit() {
        return { ok: false };
      },
    };
    const guard = createExecutionAuthorityGuard({
      identity,
      budget,
      onEvent: (event) => events.push(event.kind),
    });

    await guard.authorizeActionCall({ actionId: "booking.cancel", now: 0 });

    expect(events).toContain("budget-exhausted");
  });
});
