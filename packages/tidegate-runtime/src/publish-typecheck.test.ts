import { describe, expect, test } from "bun:test";
import type { JsonSchema } from "@tidegate/contracts";
import { demoActions } from "./demo-fixtures";
import { runPublishTypecheckGate } from "./publish-typecheck";

const inputSchema = {
  type: "object",
  required: ["appointmentId"],
  properties: {
    appointmentId: { type: "string" },
    reason: { type: "string" },
  },
  additionalProperties: false,
} satisfies JsonSchema;

const outputSchema = {
  type: "object",
  required: ["ok", "appointmentId"],
  properties: {
    ok: { type: "boolean" },
    appointmentId: { type: "string" },
  },
  additionalProperties: false,
} satisfies JsonSchema;

function typecheck(source: string) {
  return runPublishTypecheckGate({
    actionCatalogMetadata: {
      id: "booking-actions",
      version: "2026-06-25",
    },
    actions: [demoActions["booking.cancel"]],
    inputSchema,
    outputSchema,
    source,
  });
}

describe("runPublishTypecheckGate", () => {
  test("accepts a generated source module that calls the typed capability client", async () => {
    const result = await typecheck(`
export default async function run(input, ctx) {
  const cancelled = await ctx.capabilities.booking.cancel({
    appointmentId: input.appointmentId,
    reason: input.reason,
  });

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim());

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok && result.generated.source).toContain(
      "export type TidegateGeneratedInteractionRunner",
    );
  });

  test("rejects unknown capabilities with TypeScript diagnostics", async () => {
    const result = await typecheck(`
export default async function run(input, ctx) {
  await ctx.capabilities.booking.refund({
    appointmentId: input.appointmentId,
  });

  return {
    ok: true,
    appointmentId: input.appointmentId,
  };
}
`.trim());

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "typecheck_failed",
          file: "submitted-source.original.ts",
          line: 2,
          typescriptCode: "TS2339",
        }),
      ]),
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "refund",
    );
  });

  test("rejects wrong capability input shapes with TypeScript diagnostics", async () => {
    const result = await typecheck(`
export default async function run(input, ctx) {
  await ctx.capabilities.booking.cancel({
    bookingId: input.appointmentId,
  });

  return {
    ok: true,
    appointmentId: input.appointmentId,
  };
}
`.trim());

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "typecheck_failed",
        }),
      ]),
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "bookingId",
    );
  });

  test("rejects local, package, node, and reference-directive imports except the generated helper", async () => {
    const sources = [
      "import helper from './local-helper';\nexport default async function run(input, ctx) { return { ok: true, appointmentId: input.appointmentId }; }",
      "import { z } from 'zod';\nexport default async function run(input, ctx) { return { ok: true, appointmentId: input.appointmentId }; }",
      "import { readFile } from 'node:fs/promises';\nexport default async function run(input, ctx) { return { ok: true, appointmentId: input.appointmentId }; }",
      "/// <reference path=\"./local-helper.ts\" />\nexport default async function run(input, ctx) { return { ok: true, appointmentId: input.appointmentId }; }",
      "import { withTidegateCapabilities } from './tidegate-capabilities.generated';\nexport default async function run(input, ctx) { return { ok: true, appointmentId: input.appointmentId }; }",
      "export type { TidegateGeneratedInteractionContext } from './tidegate-capabilities.generated';\nexport default async function run(input, ctx) { return { ok: true, appointmentId: input.appointmentId }; }",
      "export default async function run(input, ctx) { const spec = './tidegate-capabilities.generated'; await import(spec); return { ok: true, appointmentId: input.appointmentId }; }",
      "declare const require: any;\nexport default async function run(input, ctx) { const spec = 'node:fs'; require(spec); return { ok: true, appointmentId: input.appointmentId }; }",
      "type InteractionContext = import('./tidegate-capabilities.generated').TidegateGeneratedInteractionContext;\nexport default async function run(input, ctx: InteractionContext) { return { ok: true, appointmentId: input.appointmentId }; }",
    ];
    const results = await Promise.all(sources.map((source) => typecheck(source)));

    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.flatMap((result) => result.diagnostics)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "import_disallowed",
          specifier: "./local-helper",
        }),
        expect.objectContaining({
          code: "import_disallowed",
          specifier: "zod",
        }),
        expect.objectContaining({
          code: "import_disallowed",
          specifier: "node:fs/promises",
        }),
        expect.objectContaining({
          code: "import_disallowed",
          specifier: "./local-helper.ts",
        }),
        expect.objectContaining({
          code: "import_disallowed",
          specifier: "./tidegate-capabilities.generated",
        }),
        expect.objectContaining({
          code: "unsafe_any",
        }),
        expect.objectContaining({
          code: "import_disallowed",
          specifier: "./tidegate-capabilities.generated",
        }),
      ]),
    );
  });

  test("mirrors sandbox source policy before publish", async () => {
    const sources = [
      `
export default async function run(input, ctx) {
  const cancelled = await ctx.capabilities["booking"].cancel({
    appointmentId: input.appointmentId,
  });

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim(),
      `
export default async function run(input, ctx) {
  void globalThis;

  return {
    ok: true,
    appointmentId: input.appointmentId,
  };
}
`.trim(),
      `
export default async function run(input, ctx) {
  const value = Function("return 1")();

  return {
    ok: value === 1,
    appointmentId: input.appointmentId,
  };
}
`.trim(),
      `
export default async function run(input, ctx) {
  const actions = {
    async call(_id: string, value: typeof input) {
      return {
        ok: true,
        appointmentId: value.appointmentId,
      };
    },
  };
  const cancelled = await actions.call("booking.cancel", input);

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim(),
    ];
    const results = await Promise.all(sources.map((source) => typecheck(source)));

    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.flatMap((result) => result.diagnostics)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "source_policy_disallowed",
          message: expect.stringContaining("computed property access"),
        }),
        expect.objectContaining({
          code: "source_policy_disallowed",
          message: expect.stringContaining("host runtime globals"),
        }),
        expect.objectContaining({
          code: "source_policy_disallowed",
          message: expect.stringContaining("dynamic code evaluation"),
        }),
        expect.objectContaining({
          code: "raw_action_bypass",
          message: expect.stringContaining("raw action caller access"),
        }),
      ]),
    );
  });

  test("allows TypeScript array type annotations while still rejecting element access", async () => {
    const arrayTypeResult = await typecheck(`
type Todo = {
  id: string;
  title: string;
};

type Output = {
  todos?: Todo[];
};

export default async function run(input, ctx) {
  const cancelled = await ctx.capabilities.booking.cancel({
    appointmentId: input.appointmentId,
    reason: input.reason,
  });
  const output: Output = { todos: [] };
  void output;

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim());
    const elementAccessResult = await typecheck(`
export default async function run(input, ctx) {
  const cancelled = await ctx.capabilities["booking"].cancel({
    appointmentId: input.appointmentId,
    reason: input.reason,
  });

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim());

    expect(arrayTypeResult.ok).toBe(true);
    expect(elementAccessResult.ok).toBe(false);
    expect(elementAccessResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "source_policy_disallowed",
          message: expect.stringContaining("computed property access"),
        }),
      ]),
    );
  });

  test("accepts declaration-level type imports from the generated helper", async () => {
    const result = await typecheck(`
import type { TidegateGeneratedInteractionContext } from "./tidegate-capabilities.generated";

export default async function run(
  input,
  ctx: TidegateGeneratedInteractionContext,
) {
  const cancelled = await ctx.capabilities.booking.cancel({
    appointmentId: input.appointmentId,
    reason: input.reason,
  });

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim());

    expect(result.ok).toBe(true);
  });

  test("rejects source without a compatible default run export", async () => {
    const result = await typecheck(`
export async function run(input, ctx) {
  return {
    ok: true,
    appointmentId: input.appointmentId,
  };
}
`.trim());

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "missing_default_run",
      }),
    ]);
  });

  test("rejects raw ctx.actions.call and ctx.actions.invoke bypasses", async () => {
    const result = await typecheck(`
export default async function run(input, ctx) {
  await ctx.actions.call("booking.cancel", {
    appointmentId: input.appointmentId,
  });
  await ctx.actions.invoke("booking.cancel", {
    appointmentId: input.appointmentId,
  });
  const actions = ctx.actions;
  await actions.call("booking.cancel", {
    appointmentId: input.appointmentId,
  });

  return {
    ok: true,
    appointmentId: input.appointmentId,
  };
}
`.trim());

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "raw_action_bypass",
        }),
      ]),
    );
    expect(result.diagnostics).toHaveLength(4);
  });

  test("rejects raw action aliases through renamed and destructured context parameters", async () => {
    const sources = [
      `
export default async function run(input, c) {
  const actions = c.actions;
  const cancelled = await actions.call("booking.cancel", input);

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim(),
      `
export default async function run(input, c: any) {
  const actions = c.actions;
  const cancelled = await actions.call("booking.cancel", input);

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim(),
      `
export default async function run(input, { actions }) {
  const cancelled = await actions.call("booking.cancel", input);

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim(),
      `
export default async function run(input, { actions }: any) {
  const cancelled = await actions.call("booking.cancel", input);

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim(),
      `
export default async function run(input, { actions: { call } }) {
  const cancelled = await call("booking.cancel", input);

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim(),
      `
export default async function run(input, { actions: { call } }: any) {
  const cancelled = await call("booking.cancel", input);

  return {
    ok: cancelled.ok,
    appointmentId: cancelled.appointmentId,
  };
}
`.trim(),
    ];
    const results = await Promise.all(sources.map((source) => typecheck(source)));

    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.flatMap((result) => result.diagnostics)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "raw_action_bypass",
        }),
        expect.objectContaining({
          code: "unsafe_any",
        }),
      ]),
    );
  });
});
