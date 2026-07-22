import { describe, expect, test } from "bun:test";
import {
  collectGeneratedInteractionPublishSourcePolicyFindings,
  findGeneratedInteractionRuntimeSourcePolicyFinding,
  transpileGeneratedInteractionSource,
} from "./generated-interaction-source-policy";

describe("generated interaction source policy", () => {
  test("shares runtime and publish labels for sandbox-enforced source rules", () => {
    const scenarios = [
      {
        label: "computed property access",
        source: `
export default async function run(input, ctx) {
  return ctx.capabilities["booking"].cancel(input);
}
`.trim(),
      },
      {
        label: "host runtime globals",
        source: `
export default async function run(input) {
  void globalThis;
  return { ok: true, appointmentId: input.appointmentId };
}
`.trim(),
      },
      {
        label: "dynamic code evaluation",
        source: `
export default async function run(input) {
  Function("return 1")();
  return { ok: true, appointmentId: input.appointmentId };
}
`.trim(),
      },
      {
        label: "raw action caller access",
        source: `
export default async function run(input, ctx) {
  const actions = ctx.actions;
  return actions.call("booking.cancel", input);
}
`.trim(),
      },
    ];

    for (const scenario of scenarios) {
      expect(
        collectGeneratedInteractionPublishSourcePolicyFindings(
          scenario.source,
        ).some((finding) => finding.label === scenario.label),
      ).toBe(true);
      expect(
        findGeneratedInteractionRuntimeSourcePolicyFinding(scenario.source),
      ).toEqual(expect.objectContaining({ label: scenario.label }));
    }
  });

  test("allows declaration-level generated helper type imports", () => {
    const source = `
import type { TidegateGeneratedInteractionContext } from "./tidegate-capabilities.generated";

export default async function run(input, ctx: TidegateGeneratedInteractionContext) {
  return ctx.capabilities.booking.cancel(input);
}
`.trim();

    expect(collectGeneratedInteractionPublishSourcePolicyFindings(source)).toEqual(
      [],
    );
    expect(findGeneratedInteractionRuntimeSourcePolicyFinding(source)).toBeUndefined();
  });

  test("keeps publish-only authoring rules out of runtime enforcement", () => {
    const source = `
export default async function run(input, ctx: any) {
  return ctx.capabilities.booking.cancel(input);
}
`.trim();

    expect(
      collectGeneratedInteractionPublishSourcePolicyFindings(source),
    ).toEqual([
      expect.objectContaining({
        code: "unsafe_any",
        label: "unsafe any",
      }),
    ]);
    expect(findGeneratedInteractionRuntimeSourcePolicyFinding(source)).toBeUndefined();
  });

  test("transpiles type-only generated source for sandbox and harness loading", () => {
    const output = transpileGeneratedInteractionSource(`
import type { TidegateGeneratedInteractionContext } from "./tidegate-capabilities.generated";

export default async function run(
  input: { appointmentId: string },
  ctx: TidegateGeneratedInteractionContext,
) {
  return ctx.capabilities.booking.cancel(input);
}
`.trim());

    expect(output).not.toContain("import type");
    expect(output).toContain("export default async function run(input, ctx)");
  });
});
