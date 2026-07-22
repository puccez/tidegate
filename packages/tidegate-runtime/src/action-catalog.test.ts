import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineAction, defineActionsCatalog } from "./action-catalog";

describe("action catalog helpers", () => {
  test("keeps action definitions keyed by backend action id", () => {
    const catalog = defineActionsCatalog({
      "booking.cancel": defineAction({
        id: "booking.cancel",
        description: "Cancel one appointment.",
        effects: "write",
        tenantScope: {
          tenantId: "demo-salon",
        },
        inputSchema: z.object({ appointmentId: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        async execute() {
          return { ok: true };
        },
      }),
    });

    expect(catalog["booking.cancel"].id).toBe("booking.cancel");
  });
});
