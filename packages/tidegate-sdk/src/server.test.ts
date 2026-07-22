import { afterEach, describe, expect, test } from "bun:test";
import type { InvokeInteractionRequest } from "@tidegate/contracts";
import {
  DEFAULT_TIDEGATE_API_BASE_URL,
  TidegateSdkError,
  createTidegateServerClient,
  type TidegateFetch,
} from "./server";

const originalTidegateApiKey = process.env.TIDEGATE_API_KEY;

const validRequest: InvokeInteractionRequest = {
  interactionVersion: "1",
  input: {
    appointmentId: "apt_123",
    reason: "Client requested cancellation",
  },
  surfaceId: "interaction-demo",
  sessionId: "sess_demo",
  messageId: "msg_demo",
  idempotencyKey: "ix.booking.cancelAppointment:sess_demo:apt_123",
};

afterEach(() => {
  if (originalTidegateApiKey === undefined) {
    delete process.env.TIDEGATE_API_KEY;
  } else {
    process.env.TIDEGATE_API_KEY = originalTidegateApiKey;
  }
});

describe("createTidegateServerClient", () => {
  test("fails fast when no API key is configured", () => {
    delete process.env.TIDEGATE_API_KEY;

    expect(() => createTidegateServerClient()).toThrow(TidegateSdkError);
    expect(() => createTidegateServerClient()).toThrow(
      "Missing TIDEGATE_API_KEY. Create an API key in the Tidegate dashboard and add it to your server environment.",
    );
  });

  test("reads TIDEGATE_API_KEY and invokes the default hosted API URL", async () => {
    process.env.TIDEGATE_API_KEY = "evk_test_env";

    const fetchImpl: TidegateFetch = async (input, init) => {
      expect(String(input)).toBe(
        `${DEFAULT_TIDEGATE_API_BASE_URL}/interactions/ix.booking.cancelAppointment/invoke`,
      );
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer evk_test_env");
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual(validRequest);

      return Response.json({
        status: "ok",
        invocationId: "inv_123",
        output: {
          ok: true,
          appointmentId: "apt_123",
        },
      });
    };

    const tidegate = createTidegateServerClient({ fetchImpl });
    await expect(
      tidegate.interactions.invoke("ix.booking.cancelAppointment", validRequest),
    ).resolves.toEqual({
      status: "ok",
      invocationId: "inv_123",
      output: {
        ok: true,
        appointmentId: "apt_123",
      },
    });
  });

  test("supports explicit API key and base URL overrides", async () => {
    process.env.TIDEGATE_API_KEY = "evk_test_env";

    const fetchImpl: TidegateFetch = async (input, init) => {
      expect(String(input)).toBe(
        "http://localhost:3000/api/tidegate/v1/interactions/ix.booking.cancelAppointment/invoke",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer evk_test_override",
      );

      return Response.json({
        status: "ok",
        invocationId: "inv_override",
        output: {
          ok: true,
          appointmentId: "apt_123",
        },
      });
    };

    const tidegate = createTidegateServerClient({
      apiKey: "evk_test_override",
      baseUrl: "http://localhost:3000/api/tidegate/v1/",
      fetchImpl,
    });

    const result = await tidegate.interactions.invoke(
      "ix.booking.cancelAppointment",
      validRequest,
    );

    expect(result).toMatchObject({
      status: "ok",
      invocationId: "inv_override",
    });
  });

  test("builds invoke URLs through the canonical encoded route contract", async () => {
    const fetchImpl: TidegateFetch = async (input) => {
      expect(String(input)).toBe(
        "http://localhost:3000/api/tidegate/v1/interactions/ix.booking.cancel%20appointment/invoke",
      );

      return Response.json({
        status: "ok",
        invocationId: "inv_encoded",
        output: {
          ok: true,
        },
      });
    };

    const tidegate = createTidegateServerClient({
      apiKey: "evk_test_override",
      baseUrl: "http://localhost:3000/api/tidegate/v1/",
      fetchImpl,
    });

    await expect(
      tidegate.interactions.invoke("ix.booking.cancel appointment", validRequest),
    ).resolves.toMatchObject({
      status: "ok",
      invocationId: "inv_encoded",
    });
  });

  test("returns typed Tidegate rejections instead of throwing for valid error responses", async () => {
    const tidegate = createTidegateServerClient({
      apiKey: "evk_test",
      baseUrl: "http://localhost:3000/api/tidegate/v1",
      fetchImpl: async () =>
        Response.json(
          {
            status: "rejected",
            invocationId: "inv_rejected",
            error: {
              code: "permission_denied",
              message: "The API key is missing a required scope.",
            },
          },
          { status: 403 },
        ),
    });

    await expect(
      tidegate.interactions.invoke("ix.booking.cancelAppointment", validRequest),
    ).resolves.toEqual({
      status: "rejected",
      invocationId: "inv_rejected",
      error: {
        code: "permission_denied",
        message: "The API key is missing a required scope.",
      },
    });
  });

  test("validates invoke requests before calling Tidegate", async () => {
    let called = false;
    const tidegate = createTidegateServerClient({
      apiKey: "evk_test",
      fetchImpl: async () => {
        called = true;
        return Response.json({});
      },
    });

    await expect(
      tidegate.interactions.invoke("ix.booking.cancelAppointment", {
        ...validRequest,
        tenantId: "attacker-controlled",
      } as InvokeInteractionRequest),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  test("rejects invalid interaction response bodies", async () => {
    const tidegate = createTidegateServerClient({
      apiKey: "evk_test",
      fetchImpl: async () =>
        Response.json({
          status: "maybe_ok",
          invocationId: "inv_invalid",
        }),
    });

    await expect(
      tidegate.interactions.invoke("ix.booking.cancelAppointment", validRequest),
    ).rejects.toThrow(
      "Tidegate returned HTTP 200 with an invalid interaction response.",
    );
  });
});
