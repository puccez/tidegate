import { describe, expect, test } from "bun:test";
import {
  InvokeInteractionErrorCodeSchema,
  InvokeInteractionRequestSchema,
  InvokeInteractionResponseSchema,
} from "./invoke-interaction";

const validRequest = {
  interactionVersion: "1",
  input: {
    appointmentId: "apt_123",
    reason: "Client requested cancellation",
  },
  surfaceId: "interaction-demo",
  sessionId: "sess_demo",
  messageId: "msg_demo",
};

describe("InvokeInteractionRequestSchema", () => {
  test("parses the required invoke fields", () => {
    expect(InvokeInteractionRequestSchema.safeParse(validRequest).success).toBe(
      true,
    );
  });

  test("rejects body-supplied auth or tenant fields", () => {
    const forbiddenFields = ["auth", "tenantId", "role", "permissions"];

    for (const field of forbiddenFields) {
      expect(
        InvokeInteractionRequestSchema.safeParse({
          ...validRequest,
          [field]: "attacker-controlled",
        }).success,
      ).toBe(false);
    }
  });

  test("rejects requests that omit input", () => {
    const { input, ...requestWithoutInput } = validRequest;
    expect(InvokeInteractionRequestSchema.safeParse(requestWithoutInput).success).toBe(
      false,
    );
    expect(input).toEqual({
      appointmentId: "apt_123",
      reason: "Client requested cancellation",
    });
  });

  test("allows a write request to include an idempotency key", () => {
    expect(
      InvokeInteractionRequestSchema.safeParse({
        ...validRequest,
        idempotencyKey: "ix.booking.cancelAppointment:sess_demo:apt_123",
      }).success,
    ).toBe(true);
  });
});

describe("InvokeInteractionResponseSchema", () => {
  test("parses all first-slice response variants", () => {
    const variants = [
      {
        status: "ok",
        invocationId: "inv_1",
        output: { ok: true },
      },
      {
        status: "confirmation_required",
        invocationId: "inv_1",
        confirmation: {
          message: "Confirm cancellation.",
          confirmationToken: "payload.signature",
          inputHash: "sha256:hash_1",
          inputSummary: [{ path: "/appointmentId", value: "apt_123" }],
          expiresAt: "2026-06-21T00:05:00.000Z",
          confirmRoute:
            "/api/interactions/ix.booking.cancelAppointment/confirm",
        },
      },
      {
        status: "rejected",
        invocationId: "inv_1",
        error: {
          code: "permission_denied",
          message: "Not allowed.",
        },
      },
      {
        status: "failed",
        invocationId: "inv_1",
        error: {
          code: "interaction_failed",
          message: "The interaction failed.",
          retryable: false,
        },
      },
      {
        status: "timed_out",
        invocationId: "inv_1",
        error: {
          code: "interaction_timeout",
          message: "Timed out.",
        },
      },
    ];

    for (const variant of variants) {
      expect(InvokeInteractionResponseSchema.safeParse(variant).success).toBe(
        true,
      );
    }
  });

  test("restricts error codes", () => {
    expect(
      InvokeInteractionErrorCodeSchema.safeParse("not_a_real_error").success,
    ).toBe(false);
  });

  test("accepts the confirmation_input_mismatch error code", () => {
    expect(
      InvokeInteractionErrorCodeSchema.safeParse("confirmation_input_mismatch")
        .success,
    ).toBe(true);
  });

  test("requires the confirmation envelope to carry a confirmationToken", () => {
    expect(
      InvokeInteractionResponseSchema.safeParse({
        status: "confirmation_required",
        invocationId: "inv_1",
        confirmation: {
          message: "Confirm cancellation.",
          inputHash: "sha256:hash_1",
          inputSummary: [{ path: "/appointmentId", value: "apt_123" }],
          expiresAt: "2026-06-21T00:05:00.000Z",
          confirmRoute:
            "/api/interactions/ix.booking.cancelAppointment/confirm",
        },
      }).success,
    ).toBe(false);
  });

  test("fails closed on unknown response status", () => {
    expect(
      InvokeInteractionResponseSchema.safeParse({
        status: "maybe_ok",
        invocationId: "inv_1",
        output: { ok: true },
      }).success,
    ).toBe(false);
  });
});
