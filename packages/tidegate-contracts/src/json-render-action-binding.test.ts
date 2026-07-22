import { describe, expect, test } from "bun:test";
import {
  JsonRenderActionBindingSchema,
  JsonRenderPressEventSchema,
} from "./json-render-action-binding";

describe("JSON Render action bindings", () => {
  test("parses a press binding for the public interaction id", () => {
    const result = JsonRenderPressEventSchema.safeParse({
      press: {
        action: "ix.booking.cancelAppointment",
        params: {
          appointmentId: { $state: "/selectedAppointment/id" },
          reason: { $state: "/cancelReason" },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test("parses state refs and primitive params", () => {
    const result = JsonRenderActionBindingSchema.safeParse({
      action: "ix.booking.cancelAppointment",
      params: {
        appointmentId: { $state: "/selectedAppointment/id" },
        dryRun: false,
        attempts: 1,
        note: "Client requested cancellation",
        nullable: null,
      },
    });

    expect(result.success).toBe(true);
  });

  test("rejects empty action ids", () => {
    expect(
      JsonRenderActionBindingSchema.safeParse({
        action: "",
      }).success,
    ).toBe(false);
  });

  test("does not reject backend action ids by schema alone", () => {
    expect(
      JsonRenderActionBindingSchema.safeParse({
        action: "booking.cancel",
      }).success,
    ).toBe(true);
  });
});
