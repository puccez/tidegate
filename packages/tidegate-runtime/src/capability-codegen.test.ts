import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { TidegateActionCatalogManifestV1 } from "@tidegate/contracts";
import { generateTidegateCapabilitiesClient } from "./capability-codegen";

const manifest: TidegateActionCatalogManifestV1 = {
  schemaVersion: "tidegate.actionCatalog.v1",
  catalogId: "acme-books",
  version: "2026-06-24T00:00:00.000Z",
  actions: {
    "booking.cancel": {
      description: "Cancel one appointment in the current salon.",
      input: {
        type: "object",
        required: ["appointmentId"],
        properties: {
          appointmentId: { type: "string" },
          reason: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        required: ["ok", "appointmentId"],
        properties: {
          ok: { type: "boolean" },
          appointmentId: { type: "string" },
        },
        additionalProperties: false,
      },
      effects: "write",
      requiredPermissions: ["booking:write"],
      tenantScope: { fromAuth: "tenantId" },
      audit: { required: true, redactPaths: [] },
    },
    "booking.read": {
      description: "Read appointments.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        type: "object",
        required: ["appointments"],
        properties: {
          appointments: {
            type: "array",
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      effects: "read",
      requiredPermissions: ["booking:read"],
      audit: { required: false, redactPaths: [] },
    },
  },
};

describe("generateTidegateCapabilitiesClient", () => {
  test("generates a nested ctx.capabilities client over action ids", () => {
    const generated = generateTidegateCapabilitiesClient(manifest);

    expect(generated.filename).toBe("tidegate-capabilities.generated.ts");
    expect(generated.source).toContain("export type TidegateActionMap");
    expect(generated.source).toContain("export type TidegateCapabilities");
    expect(generated.source).toContain(
      "cancel(input: TidegateActionMap[\"booking.cancel\"][\"input\"])",
    );
    expect(generated.source).toContain(
      "cancel: (input) => actions.call(\"booking.cancel\", input)",
    );
  });

  test("generated TypeScript accepts valid capability calls", async () => {
    const generated = generateTidegateCapabilitiesClient(manifest);
    const dir = await mkdtemp(join(tmpdir(), "tidegate-capabilities-"));

    try {
      await Bun.write(join(dir, generated.filename), generated.source);
      await Bun.write(
        join(dir, "valid.ts"),
        [
          "import type { TidegateGeneratedInteractionContext } from './tidegate-capabilities.generated';",
          "declare const ctx: TidegateGeneratedInteractionContext;",
          "async function run() {",
          "  const result = await ctx.capabilities.booking.cancel({",
          "    appointmentId: 'apt_123',",
          "    reason: 'Client requested cancellation',",
          "  });",
          "  result.appointmentId satisfies string;",
          "  ctx.auth.permissions satisfies string[];",
          "  ctx.auth.tenantId satisfies string | undefined;",
          "  ctx.signal.aborted satisfies boolean;",
          "}",
          "void run;",
        ].join("\n"),
      );

      const result = await runTsc(dir, "valid.ts");

      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generated wrapper accepts the real runtime action caller shape", async () => {
    const generated = generateTidegateCapabilitiesClient(manifest);
    const dir = await mkdtemp(join(tmpdir(), "tidegate-capabilities-"));

    try {
      await Bun.write(join(dir, generated.filename), generated.source);
      await Bun.write(
        join(dir, "runtime-context.ts"),
        [
          "import { withTidegateCapabilities } from './tidegate-capabilities.generated';",
          "",
          "type InteractionRuntimeContext = {",
          "  auth: {",
          "    scopes: string[];",
          "    permissions: string[];",
          "    authMode: 'local-dev';",
          "    tenantId?: string;",
          "  };",
          "  signal: {",
          "    readonly aborted: boolean;",
          "    readonly reason?: unknown;",
          "    throwIfAborted(): void;",
          "  };",
          "  actions: {",
          "    call(actionId: string, input: unknown): Promise<unknown>;",
          "  };",
          "};",
          "",
          "declare const runtimeCtx: InteractionRuntimeContext;",
          "const ctx = withTidegateCapabilities(runtimeCtx);",
          "ctx satisfies import('./tidegate-capabilities.generated').TidegateGeneratedInteractionContext;",
          "ctx.auth.permissions satisfies string[];",
          "ctx.signal.aborted satisfies boolean;",
          "",
          "async function run() {",
          "  const result = await ctx.capabilities.booking.cancel({",
          "    appointmentId: 'apt_123',",
          "    reason: 'Client requested cancellation',",
          "  });",
          "  result.appointmentId satisfies string;",
          "}",
          "void run;",
        ].join("\n"),
      );

      const result = await runTsc(dir, "runtime-context.ts");

      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generated TypeScript rejects unknown capabilities and wrong input", async () => {
    const generated = generateTidegateCapabilitiesClient(manifest);
    const dir = await mkdtemp(join(tmpdir(), "tidegate-capabilities-"));

    try {
      await Bun.write(join(dir, generated.filename), generated.source);
      await Bun.write(
        join(dir, "invalid.ts"),
        [
          "import type { TidegateGeneratedInteractionContext } from './tidegate-capabilities.generated';",
          "declare const ctx: TidegateGeneratedInteractionContext;",
          "ctx.capabilities.booking.refund({ appointmentId: 'apt_123' });",
          "ctx.capabilities.booking.cancel({ bookingId: 'apt_123' });",
          "ctx.actions.call('booking.cancel', { appointmentId: 'apt_123' });",
        ].join("\n"),
      );

      const result = await runTsc(dir, "invalid.ts");

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("refund");
      expect(result.stderr).toContain("bookingId");
      expect(result.stderr).toContain("actions");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generated TypeScript parenthesizes array item unions", async () => {
    const generated = generateTidegateCapabilitiesClient({
      ...manifest,
      actions: {
        "reports.export": {
          description: "Export report rows.",
          input: {
            type: "object",
            required: ["rowIds"],
            properties: {
              rowIds: {
                type: "array",
                items: {
                  anyOf: [{ type: "string" }, { type: "number" }],
                },
              },
            },
            additionalProperties: false,
          },
          output: {
            type: "object",
            required: ["ok"],
            properties: {
              ok: { type: "boolean" },
            },
            additionalProperties: false,
          },
          effects: "read",
          requiredPermissions: [],
          audit: { required: false, redactPaths: [] },
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "tidegate-capabilities-"));

    try {
      expect(generated.source).toContain("rowIds: (string | number)[];");

      await Bun.write(join(dir, generated.filename), generated.source);
      await Bun.write(
        join(dir, "valid-union-array.ts"),
        [
          "import type { TidegateGeneratedInteractionContext } from './tidegate-capabilities.generated';",
          "declare const ctx: TidegateGeneratedInteractionContext;",
          "async function run() {",
          "  await ctx.capabilities.reports.export({ rowIds: ['row_1', 2] });",
          "}",
          "void run;",
        ].join("\n"),
      );

      const result = await runTsc(dir, "valid-union-array.ts");

      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generated TypeScript preserves additionalProperties value types", async () => {
    const generated = generateTidegateCapabilitiesClient({
      ...manifest,
      actions: {
        "settings.update": {
          description: "Update feature settings.",
          input: {
            type: "object",
            required: ["flags"],
            properties: {
              flags: {
                type: "object",
                additionalProperties: { type: "boolean" },
              },
            },
            additionalProperties: false,
          },
          output: {
            type: "object",
            required: ["ok"],
            properties: {
              ok: { type: "boolean" },
            },
            additionalProperties: false,
          },
          effects: "write",
          requiredPermissions: ["settings:write"],
          audit: { required: true, redactPaths: [] },
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "tidegate-capabilities-"));

    try {
      expect(generated.source).toContain(
        "flags: Record<string, boolean>;",
      );

      await Bun.write(join(dir, generated.filename), generated.source);
      await Bun.write(
        join(dir, "valid-record.ts"),
        [
          "import type { TidegateGeneratedInteractionContext } from './tidegate-capabilities.generated';",
          "declare const ctx: TidegateGeneratedInteractionContext;",
          "async function run() {",
          "  await ctx.capabilities.settings.update({ flags: { beta: true } });",
          "}",
          "void run;",
        ].join("\n"),
      );
      await Bun.write(
        join(dir, "invalid-record.ts"),
        [
          "import type { TidegateGeneratedInteractionContext } from './tidegate-capabilities.generated';",
          "declare const ctx: TidegateGeneratedInteractionContext;",
          "ctx.capabilities.settings.update({ flags: { beta: 'yes' } });",
        ].join("\n"),
      );

      const validResult = await runTsc(dir, "valid-record.ts");
      const invalidResult = await runTsc(dir, "invalid-record.ts");

      expect(validResult.exitCode).toBe(0);
      expect(invalidResult.exitCode).not.toBe(0);
      expect(invalidResult.stderr).toContain("string");
      expect(invalidResult.stderr).toContain("boolean");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects unresolved JSON Schema refs instead of generating unknown", () => {
    expect(() =>
      generateTidegateCapabilitiesClient({
        ...manifest,
        actions: {
          "booking.cancel": {
            ...manifest.actions["booking.cancel"]!,
            input: { $ref: "#/$defs/BookingCancelInput" },
          },
        },
      }),
    ).toThrow(
      "JSON Schema $ref is not supported by Tidegate capability codegen: #/$defs/BookingCancelInput",
    );
  });

  test("rejects mixed properties and typed additionalProperties", () => {
    expect(() =>
      generateTidegateCapabilitiesClient({
        ...manifest,
        actions: {
          "settings.update": {
            description: "Update settings.",
            input: {
              type: "object",
              required: ["fixed"],
              properties: {
                fixed: { type: "string" },
              },
              additionalProperties: { type: "boolean" },
            },
            output: {
              type: "object",
              required: ["ok"],
              properties: {
                ok: { type: "boolean" },
              },
              additionalProperties: false,
            },
            effects: "write",
            requiredPermissions: ["settings:write"],
            audit: { required: true, redactPaths: [] },
          },
        },
      }),
    ).toThrow(
      "JSON Schema objects with both named properties and schema-valued additionalProperties are not supported by Tidegate capability codegen.",
    );
  });

  test("rejects action ids that collide with namespaces", () => {
    expect(() =>
      generateTidegateCapabilitiesClient({
        ...manifest,
        actions: {
          ...manifest.actions,
          booking: {
            description: "Conflicting namespace.",
            input: { type: "object" },
            output: { type: "object" },
            effects: "read",
            requiredPermissions: [],
            audit: { required: false, redactPaths: [] },
          },
        },
      }),
    ).toThrow("conflicts with");
  });
});

async function runTsc(dir: string, file: string) {
  const process = Bun.spawn(
    [
      "bunx",
      "tsc",
      "--noEmit",
      "--strict",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--target",
      "ESNext",
      "--lib",
      "ESNext",
      "--skipLibCheck",
      file,
    ],
    {
      cwd: dir,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);

  return {
    exitCode,
    stderr: `${stderr}\n${stdout}`,
  };
}
