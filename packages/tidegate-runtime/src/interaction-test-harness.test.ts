import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cancelAppointmentPublishRequest } from "@tidegate/contracts/fixtures";
import {
  createInteractionTestHarness,
  InteractionTestHarnessError,
  toInteractionTestHarnessDiagnostics,
} from "./interaction-test-harness";

const cancelAppointmentSource = `
export default async function run(input, ctx) {
  if ("actions" in ctx) {
    throw new Error("ctx.actions must not be exposed");
  }

  const result = await ctx.capabilities.booking.cancel({
    appointmentId: input.appointmentId,
    reason: input.reason ?? "Requested by user",
  });

  return {
    ok: result.ok,
    appointmentId: result.appointmentId,
  };
}
`.trim();

function publishRequestWithoutSource(): Record<string, unknown> {
  const { source: _source, ...publishRequest } = structuredClone(
    cancelAppointmentPublishRequest,
  );

  return publishRequest;
}

describe("createInteractionTestHarness", () => {
  test("invokes generated source through ctx.capabilities and records action calls", async () => {
    const harness = await createInteractionTestHarness({
      source: cancelAppointmentSource,
      publishRequest: publishRequestWithoutSource(),
      capabilities: {
        "booking.cancel": async (input) => {
          expect(input).toEqual({
            appointmentId: "apt_123",
            reason: "customer request",
          });

          return {
            ok: true,
            appointmentId: "apt_123",
          };
        },
      },
    });

    await expect(
      harness.invoke({
        appointmentId: "apt_123",
        reason: "customer request",
      }),
    ).resolves.toEqual({
      ok: true,
      appointmentId: "apt_123",
    });
    expect(harness.actionCalls()).toEqual([
      {
        actionId: "booking.cancel",
        input: {
          appointmentId: "apt_123",
          reason: "customer request",
        },
      },
    ]);
  });

  test("loads interaction source and publish request from workspace file paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tidegate-harness-test-"));

    try {
      await writeFile(
        join(workspace, "interaction.ts"),
        cancelAppointmentSource,
        "utf8",
      );
      await writeFile(
        join(workspace, "publish-request.json"),
        JSON.stringify(publishRequestWithoutSource()),
        "utf8",
      );

      const harness = await createInteractionTestHarness({
        cwd: workspace,
        sourcePath: "./interaction.ts",
        publishRequestPath: "./publish-request.json",
        capabilities: {
          "booking.cancel": async (input) => ({
            ok: true,
            appointmentId: (input as { appointmentId?: unknown }).appointmentId,
          }),
        },
      });

      await expect(
        harness.invoke({
          appointmentId: "apt_from_file",
        }),
      ).resolves.toEqual({
        ok: true,
        appointmentId: "apt_from_file",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects capability mocks not declared by the publish request", async () => {
    await expect(
      createInteractionTestHarness({
        source: cancelAppointmentSource,
        publishRequest: publishRequestWithoutSource(),
        capabilities: {
          "booking.reschedule": async () => ({ ok: true }),
        },
      }),
    ).rejects.toMatchObject({
      code: "capability_not_declared",
      diagnostics: [
        {
          actionId: "booking.reschedule",
          code: "capability_not_declared",
          severity: "error",
        },
      ],
    });
  });

  test("rejects source that reads an undeclared capability", async () => {
    const harness = await createInteractionTestHarness({
      source: `
export default async function run(input, ctx) {
  return await ctx.capabilities.booking.reschedule(input);
}
`.trim(),
      publishRequest: publishRequestWithoutSource(),
      capabilities: {
        "booking.cancel": async () => ({ ok: true }),
      },
    });

    let thrown: unknown;

    try {
      await harness.invoke({
        appointmentId: "apt_123",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InteractionTestHarnessError);
    expect(thrown).toMatchObject({
      code: "capability_not_declared",
      diagnostics: [
        {
          actionId: "booking.reschedule",
          code: "capability_not_declared",
          file: "<interaction source>",
          severity: "error",
        },
      ],
    });
    expect(
      toInteractionTestHarnessDiagnostics(thrown, {
        testName: "rejects source that reads an undeclared capability",
      })[0],
    ).toMatchObject({
      actionId: "booking.reschedule",
      testName: "rejects source that reads an undeclared capability",
    });
  });

  test("rejects called declared capabilities that do not have mocks", async () => {
    const harness = await createInteractionTestHarness({
      source: cancelAppointmentSource,
      publishRequest: publishRequestWithoutSource(),
      capabilities: {},
    });

    await expect(
      harness.invoke({
        appointmentId: "apt_123",
      }),
    ).rejects.toMatchObject({
      code: "capability_mock_missing",
      diagnostics: [
        {
          actionId: "booking.cancel",
          code: "capability_mock_missing",
          severity: "error",
        },
      ],
    });
    expect(harness.actionCalls()).toEqual([
      {
        actionId: "booking.cancel",
        input: {
          appointmentId: "apt_123",
          reason: "Requested by user",
        },
      },
    ]);
  });

  test("rejects interactions that exceed the invocation timeout", async () => {
    const harness = await createInteractionTestHarness({
      source: `
export default async function run() {
  await new Promise(() => {});
}
`.trim(),
      publishRequest: publishRequestWithoutSource(),
      capabilities: {
        "booking.cancel": async () => ({ ok: true }),
      },
      timeoutMs: 10,
    });

    await expect(harness.invoke({})).rejects.toMatchObject({
      code: "interaction_timeout",
      diagnostics: [
        {
          code: "interaction_timeout",
          file: "<interaction source>",
          severity: "error",
        },
      ],
    });
  });
});
