import { describe, expect, test } from "bun:test";
import { TidegateActionCatalogManifestV1Schema } from "./action-catalog-manifest";

describe("TidegateActionCatalogManifestV1Schema", () => {
  test("parses a language-neutral action catalog manifest", () => {
    const manifest = TidegateActionCatalogManifestV1Schema.parse({
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
      },
    });

    expect(manifest.actions["booking.cancel"]).toMatchObject({
      effects: "write",
      tenantScope: { fromAuth: "tenantId" },
    });
  });

  test("defaults required permissions and audit policy", () => {
    const manifest = TidegateActionCatalogManifestV1Schema.parse({
      schemaVersion: "tidegate.actionCatalog.v1",
      catalogId: "demo",
      version: "1",
      actions: {
        "booking.read": {
          description: "Read bookings.",
          input: { type: "object" },
          output: { type: "object" },
          effects: "read",
        },
      },
    });

    expect(manifest.actions["booking.read"]?.requiredPermissions).toEqual([]);
    expect(manifest.actions["booking.read"]?.audit).toEqual({
      required: false,
      redactPaths: [],
    });
  });

  test("defaults write action audit policy to required", () => {
    const manifest = TidegateActionCatalogManifestV1Schema.parse({
      schemaVersion: "tidegate.actionCatalog.v1",
      catalogId: "demo",
      version: "1",
      actions: {
        "booking.cancel": {
          description: "Cancel bookings.",
          input: { type: "object" },
          output: { type: "object" },
          effects: "write",
        },
      },
    });

    expect(manifest.actions["booking.cancel"]?.audit).toEqual({
      required: true,
      redactPaths: [],
    });
  });

  test("rejects executable fields in manifest actions", () => {
    expect(() =>
      TidegateActionCatalogManifestV1Schema.parse({
        schemaVersion: "tidegate.actionCatalog.v1",
        catalogId: "demo",
        version: "1",
        actions: {
          "booking.cancel": {
            description: "Cancel bookings.",
            input: { type: "object" },
            output: { type: "object" },
            effects: "write",
            execute: "not allowed",
          },
        },
      }),
    ).toThrow();
  });

  test("rejects action ids that cannot become a safe capability path", () => {
    expect(() =>
      TidegateActionCatalogManifestV1Schema.parse({
        schemaVersion: "tidegate.actionCatalog.v1",
        catalogId: "demo",
        version: "1",
        actions: {
          "booking..cancel": {
            description: "Cancel bookings.",
            input: { type: "object" },
            output: { type: "object" },
            effects: "write",
          },
        },
      }),
    ).toThrow("Action ids must use non-empty dot-separated segments.");

    expect(() =>
      TidegateActionCatalogManifestV1Schema.parse({
        schemaVersion: "tidegate.actionCatalog.v1",
        catalogId: "demo",
        version: "1",
        actions: {
          "__proto__.cancel": {
            description: "Cancel bookings.",
            input: { type: "object" },
            output: { type: "object" },
            effects: "write",
          },
        },
      }),
    ).toThrow("Action ids cannot use reserved JavaScript object segments.");

    expect(() =>
      TidegateActionCatalogManifestV1Schema.parse(
        JSON.parse(
          JSON.stringify({
            schemaVersion: "tidegate.actionCatalog.v1",
            catalogId: "demo",
            version: "1",
            actions: {
              ["__proto__"]: {
                description: "Unsafe exact action id.",
                input: { type: "object" },
                output: { type: "object" },
                effects: "read",
              },
            },
          }),
        ),
      ),
    ).toThrow("Action ids cannot use reserved JavaScript object segments.");
  });

  test("rejects action ids that collide with namespace paths", () => {
    expect(() =>
      TidegateActionCatalogManifestV1Schema.parse({
        schemaVersion: "tidegate.actionCatalog.v1",
        catalogId: "demo",
        version: "1",
        actions: {
          booking: {
            description: "Booking namespace collision.",
            input: { type: "object" },
            output: { type: "object" },
            effects: "read",
          },
          "booking.cancel": {
            description: "Cancel bookings.",
            input: { type: "object" },
            output: { type: "object" },
            effects: "write",
          },
        },
      }),
    ).toThrow("conflicts with");
  });
});
