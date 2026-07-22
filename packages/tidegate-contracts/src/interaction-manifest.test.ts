import { describe, expect, test } from "bun:test";
import { cancelAppointmentContract } from "@tidegate/contracts/fixtures";
import { toInteractionManifest } from "./interaction-manifest";
import { legacyPublicInteractionInvokeRoute } from "./interaction-public-routes";

describe("toInteractionManifest", () => {
  test("projects public fields from a private interaction contract", () => {
    const manifest = toInteractionManifest(cancelAppointmentContract);

    expect(manifest).toMatchObject({
      schemaVersion: "tidegate.interactionManifest.v1",
      id: cancelAppointmentContract.id,
      version: cancelAppointmentContract.version,
      title: cancelAppointmentContract.title,
      description: cancelAppointmentContract.description,
      inputSchema: cancelAppointmentContract.input.schema,
      outputSchema: cancelAppointmentContract.output.schema,
      effects: cancelAppointmentContract.effects.declared,
      riskLevel: cancelAppointmentContract.effects.riskLevel,
      timeoutMs: cancelAppointmentContract.timeout.executionMs,
      confirmation: cancelAppointmentContract.confirmation,
      invoke: legacyPublicInteractionInvokeRoute({
        interactionId: cancelAppointmentContract.id,
      }),
    });
  });

  test("does not expose private runtime details", () => {
    const manifest = toInteractionManifest(cancelAppointmentContract) as unknown as Record<
      string,
      unknown
    >;

    expect("allowedActions" in manifest).toBe(false);
    expect("source" in manifest).toBe(false);
    expect("audit" in manifest).toBe(false);
    expect("visibility" in manifest).toBe(false);
  });
});
