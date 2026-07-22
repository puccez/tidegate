import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { TidegateActionCatalogManifestV1 } from "@tidegate/contracts";
import { prepareTidegateSandboxCapabilities } from "./sandbox-capabilities";

const manifest: TidegateActionCatalogManifestV1 = {
  schemaVersion: "tidegate.actionCatalog.v1",
  catalogId: "acme-books",
  version: "2026-06-25T00:00:00.000Z",
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
  },
};

describe("prepareTidegateSandboxCapabilities", () => {
  test("writes the generated capability client into a sandbox workspace", async () => {
    const writes: Array<{ path: string; content: string }> = [];

    const prepared = await prepareTidegateSandboxCapabilities({
      manifest,
      sandbox: {
        writeTextFile(args) {
          writes.push(args);
        },
      },
    });

    expect(prepared.path).toBe("tidegate-capabilities.generated.ts");
    expect(prepared.importSpecifier).toBe("./tidegate-capabilities.generated");
    expect(prepared.actionIds).toEqual(["booking.cancel"]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(prepared.path);
    expect(writes[0]?.content).toContain("export type TidegateCapabilities");
    expect(writes[0]?.content).toContain(
      "cancel: (input) => actions.call(\"booking.cancel\", input)",
    );
  });

  test("normalizes custom workspace paths and import specifiers", async () => {
    const writes: Array<{ path: string; content: string }> = [];

    const prepared = await prepareTidegateSandboxCapabilities({
      manifest,
      path: "./.tidegate/tidegate-capabilities.generated.ts",
      sandbox: {
        writeTextFile(args) {
          writes.push(args);
        },
      },
    });

    expect(prepared.path).toBe(".tidegate/tidegate-capabilities.generated.ts");
    expect(prepared.importSpecifier).toBe(
      "./.tidegate/tidegate-capabilities.generated",
    );
    expect(writes[0]?.path).toBe(prepared.path);
  });

  test("rejects paths that leave the sandbox workspace", async () => {
    await expect(
      prepareTidegateSandboxCapabilities({
        manifest,
        path: "../tidegate-capabilities.generated.ts",
        sandbox: {
          writeTextFile() {
            throw new Error("should not write");
          },
        },
      }),
    ).rejects.toThrow(
      "Tidegate sandbox capability path must stay inside the sandbox workspace.",
    );
  });

  test("generated capabilities can wrap a runtime action caller", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tidegate-sandbox-capabilities-"));

    try {
      const prepared = await prepareTidegateSandboxCapabilities({
        manifest,
        sandbox: {
          writeTextFile(args) {
            return Bun.write(join(dir, args.path), args.content);
          },
        },
      });
      await Bun.write(
        join(dir, "valid-runtime.ts"),
        [
          `import { withTidegateCapabilities } from ${JSON.stringify(prepared.importSpecifier)};`,
          "const calls: Array<{ actionId: string; input: unknown }> = [];",
          "const ctx = withTidegateCapabilities({",
          "  actions: {",
          "    async call(actionId, input) {",
          "      calls.push({ actionId, input });",
          "      return { ok: true, appointmentId: 'apt_123' };",
          "    },",
          "  },",
          "});",
          "const result = await ctx.capabilities.booking.cancel({",
          "  appointmentId: 'apt_123',",
          "  reason: 'Client requested cancellation',",
          "});",
          "if (calls[0]?.actionId !== 'booking.cancel') throw new Error('wrong action');",
          "if (result.appointmentId !== 'apt_123') throw new Error('wrong output');",
        ].join("\n"),
      );

      const result = Bun.spawnSync(["bun", "valid-runtime.ts"], {
        cwd: dir,
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
