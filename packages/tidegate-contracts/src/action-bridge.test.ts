import { describe, expect, test } from "bun:test";
import {
  TidegateActionInvokeRequestSchema,
  TidegateActionInvokeResponseSchema,
} from "./action-bridge";

describe("Tidegate action bridge contracts", () => {
  test("parses a minimal action invoke request", () => {
    expect(
      TidegateActionInvokeRequestSchema.parse({
        actionId: "booking.cancel",
        input: {
          appointmentId: "apt_123",
        },
      }),
    ).toEqual({
      actionId: "booking.cancel",
      input: {
        appointmentId: "apt_123",
      },
    });
  });

  test("rejects body-supplied auth context", () => {
    expect(() =>
      TidegateActionInvokeRequestSchema.parse({
        actionId: "booking.cancel",
        input: {
          appointmentId: "apt_123",
        },
        tenantId: "attacker-controlled",
      }),
    ).toThrow();
  });

  test("parses stable action bridge response variants", () => {
    expect(
      TidegateActionInvokeResponseSchema.parse({
        status: "ok",
        invocationId: "act_inv_123",
        output: {
          ok: true,
        },
      }),
    ).toMatchObject({
      status: "ok",
      invocationId: "act_inv_123",
    });

    expect(
      TidegateActionInvokeResponseSchema.parse({
        status: "rejected",
        invocationId: "act_inv_123",
        error: {
          code: "action_not_allowed",
          message: "Not allowed.",
        },
      }),
    ).toMatchObject({
      status: "rejected",
      error: {
        code: "action_not_allowed",
      },
    });
  });
});
