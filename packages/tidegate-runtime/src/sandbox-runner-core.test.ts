import { describe, expect, test } from "bun:test";
import { createSandboxRunnerSource } from "./sandbox-executor";
import { hardenSandboxGlobals, runInteraction } from "./sandbox-runner-core";

describe("sandbox runner core", () => {
  test("the generated runner source embeds the shared core (anti-drift guard)", () => {
    const source = createSandboxRunnerSource();

    // The string wrapper must call the shared core, not re-implement it. If
    // this sentinel disappears, the process runner and the deterministic
    // backend can silently diverge.
    expect(source).toContain("runInteraction(");
    expect(source).toContain("const runInteraction =");
    expect(source).toContain("hardenSandboxGlobals(globalThis)");
    expect(source).toContain(
      "Published interaction must default export a run function.",
    );
    expect(source).toContain('await import("./interaction.generated.mjs")');
    // The embedded core must be plain JavaScript (types stripped).
    expect(source).not.toContain(": unknown");
    expect(source).not.toContain("SandboxRunnerError");
  });

  test("runs the module default export with capability tree and auth context", async () => {
    const seenCalls: Array<{ actionId: string; input: unknown }> = [];
    const result = await runInteraction({
      moduleLoader: async () => ({
        default: async (
          input: { appointmentId: string },
          ctx: {
            auth: unknown;
            capabilities: {
              booking: { cancel: (input: unknown) => Promise<unknown> };
            };
          },
        ) => {
          const cancelled = await ctx.capabilities.booking.cancel(input);
          return { cancelled, auth: ctx.auth };
        },
      }),
      input: { appointmentId: "apt_123" },
      auth: { subjectId: "subject_1" },
      capabilities: { actionIds: ["booking.cancel"] },
      actionCaller: async (actionId, input) => {
        seenCalls.push({ actionId, input });
        return { ok: true };
      },
    });

    expect(result).toEqual({
      status: "ok",
      output: {
        cancelled: { ok: true },
        auth: { subjectId: "subject_1" },
      },
    });
    expect(seenCalls).toEqual([
      { actionId: "booking.cancel", input: { appointmentId: "apt_123" } },
    ]);
  });

  test("capability segments that collide with Object.prototype members stay isolated", async () => {
    const seenCalls: Array<{ actionId: string; input: unknown }> = [];
    const result = await runInteraction({
      moduleLoader: async () => ({
        default: async (
          input: unknown,
          ctx: {
            capabilities: {
              toString: { cancel: (input: unknown) => Promise<unknown> };
              valueOf: (input: unknown) => Promise<unknown>;
            };
          },
        ) => {
          const nested = await ctx.capabilities.toString.cancel(input);
          const leaf = await ctx.capabilities.valueOf(input);
          return { nested, leaf };
        },
      }),
      input: { appointmentId: "apt_123" },
      auth: {},
      capabilities: { actionIds: ["toString.cancel", "valueOf"] },
      actionCaller: async (actionId, input) => {
        seenCalls.push({ actionId, input });
        return { actionId };
      },
    });

    expect(result).toEqual({
      status: "ok",
      output: {
        nested: { actionId: "toString.cancel" },
        leaf: { actionId: "valueOf" },
      },
    });
    expect(seenCalls).toEqual([
      { actionId: "toString.cancel", input: { appointmentId: "apt_123" } },
      { actionId: "valueOf", input: { appointmentId: "apt_123" } },
    ]);
    // Building the tree must never mutate the shared Object.prototype
    // members the segments collide with.
    expect("cancel" in Object.prototype.toString).toBe(false);
  });

  test("normalizes thrown errors, preserving code/status/retryable", async () => {
    const thrown = Object.assign(new Error("not allowed"), {
      code: "action_not_allowed",
      status: "rejected",
      retryable: false,
    });
    const result = await runInteraction({
      moduleLoader: async () => ({
        default: async () => {
          throw thrown;
        },
      }),
      input: {},
      auth: {},
      capabilities: { actionIds: [] },
      actionCaller: async () => undefined,
    });

    expect(result).toEqual({
      status: "error",
      error: {
        code: "action_not_allowed",
        status: "rejected",
        message: "not allowed",
        retryable: false,
      },
    });
  });

  test("fails closed when the module has no default run function", async () => {
    const result = await runInteraction({
      moduleLoader: async () => ({}),
      input: {},
      auth: {},
      capabilities: { actionIds: [] },
      actionCaller: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "error",
      error: {
        code: "interaction_failed",
        status: "failed",
        message: "Published interaction must default export a run function.",
      },
    });
  });

  test("rejects capability action ids that are not identifier segments", async () => {
    const result = await runInteraction({
      moduleLoader: async () => ({ default: async () => ({}) }),
      input: {},
      auth: {},
      capabilities: { actionIds: ["booking.cancel-all"] },
      actionCaller: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "error",
      error: {
        code: "interaction_failed",
        status: "failed",
        message: "Generated capability action ids must use identifier segments.",
      },
    });
  });

  test("hardenGlobals runs before the module loads", async () => {
    const order: string[] = [];
    await runInteraction({
      moduleLoader: async () => {
        order.push("module");
        return { default: async () => ({}) };
      },
      input: {},
      auth: {},
      capabilities: { actionIds: [] },
      actionCaller: async () => undefined,
      hardenGlobals: () => {
        order.push("harden");
      },
    });

    expect(order).toEqual(["harden", "module"]);
  });

  test("hardenSandboxGlobals strips host globals and silences console", () => {
    const fakeGlobal: Record<string, unknown> = {
      Bun: {},
      fetch: () => {},
      process: {},
      eval: () => {},
      Function: () => {},
      Buffer: {},
      require: () => {},
      console: { log: () => {} },
      JSON,
    };

    hardenSandboxGlobals(fakeGlobal);

    for (const name of [
      "Bun",
      "fetch",
      "process",
      "eval",
      "Function",
      "Buffer",
      "require",
    ]) {
      expect(fakeGlobal[name]).toBeUndefined();
    }
    expect(fakeGlobal.JSON).toBe(JSON);
    const console = fakeGlobal.console as Record<string, unknown>;
    for (const method of ["debug", "error", "info", "log", "warn"]) {
      expect(typeof console[method]).toBe("function");
    }
  });
});
