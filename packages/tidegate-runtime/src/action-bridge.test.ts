import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER,
  TIDEGATE_ACTION_AUTH_CONTEXT_HEADER,
  TIDEGATE_ACTION_INTERACTION_ID_HEADER,
  TIDEGATE_ACTION_BRIDGE_SECRET_HEADER,
  type TidegateAuthContext,
  type InvokeInteractionRequest,
} from "@tidegate/contracts";
import { cancelAppointmentContract } from "@tidegate/contracts/fixtures";
import {
  createTidegateActionHandler,
  defineTidegateActions,
} from "@tidegate/sdk/server";
import { createTidegateRuntime } from "./runtime";
import { createTidegateActionBridgeAction } from "./action-bridge";
import { createInteractionRegistry, defineInteraction } from "./interaction-registry";

const auth: TidegateAuthContext = {
  authMode: "api-key",
  organizationId: "demo-salon",
  tenantId: "demo-salon",
  subjectId: "api_key_demo",
  subjectType: "api_key",
  credentialId: "api_key_demo",
  credentialType: "api_key",
  scopes: ["tidegate:interaction:invoke"],
  permissions: ["booking:write"],
  authorization: {
    permissions: ["booking:write"],
    resourceGrants: [],
  },
};

const inputSchema = z.object({
  appointmentId: z.string().min(1),
  reason: z.string().optional(),
});

const outputSchema = z.object({
  ok: z.boolean(),
  appointmentId: z.string(),
  tenantId: z.string(),
});

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

function createCustomerActionHandler({
  requiredPermissions = ["booking:write"],
}: {
  requiredPermissions?: string[];
} = {}) {
  let calls = 0;
  const POST = createTidegateActionHandler(
    defineTidegateActions({
      "booking.cancel": {
        input: inputSchema,
        output: outputSchema,
        effects: "write",
        requiredPermissions,
        async execute({ input, auth }) {
          calls += 1;
          return {
            ok: true,
            appointmentId: input.appointmentId,
            tenantId: auth.tenantId,
          };
        },
      },
    }),
    {
      actionBridgeSecret: "secret_123",
    },
  );

  return {
    POST,
    getCalls: () => calls,
  };
}

function requestFromFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  return new Request(String(input), {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
    signal: init?.signal,
  });
}

describe("createTidegateActionBridgeAction", () => {
  test("calls a customer action handler with server-derived auth and interaction allowlist", async () => {
    const { POST, getCalls } = createCustomerActionHandler();
    const action = createTidegateActionBridgeAction({
      id: "booking.cancel",
      description: "Cancel one appointment.",
      inputSchema,
      outputSchema,
      effects: "write",
      tenantScope: {
        tenantId: "demo-salon",
      },
      endpoint: "https://customer.example.com/api/tidegate/actions",
      actionBridgeSecret: "secret_123",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://customer.example.com/api/tidegate/actions");
        expect(init?.method).toBe("POST");

        const headers = new Headers(init?.headers);
        expect(headers.get(TIDEGATE_ACTION_BRIDGE_SECRET_HEADER)).toBe("secret_123");
        expect(headers.get(TIDEGATE_ACTION_INTERACTION_ID_HEADER)).toBe(
          "ix.booking.cancelAppointment",
        );
        expect(JSON.parse(headers.get(TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER)!)).toEqual([
          "booking.cancel",
        ]);
        expect(
          JSON.parse(headers.get(TIDEGATE_ACTION_AUTH_CONTEXT_HEADER)!),
        ).toMatchObject({
          tenantId: "demo-salon",
          permissions: ["booking:write"],
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          actionId: "booking.cancel",
          input: {
            appointmentId: "apt_123",
            reason: "Client requested cancellation",
          },
          invocationId: "inv_123",
        });

        return POST(requestFromFetch(input, init));
      },
    });

    const output = await action.execute({
      input: {
        appointmentId: "apt_123",
        reason: "Client requested cancellation",
      },
      auth,
      signal: new AbortController().signal,
      invocationId: "inv_123",
      interaction: {
        id: "ix.booking.cancelAppointment",
        version: "1",
        allowedActionIds: ["booking.cancel"],
      },
    });

    expect(output).toEqual({
      ok: true,
      appointmentId: "apt_123",
      tenantId: "demo-salon",
    });
    expect(getCalls()).toBe(1);
  });

  test("can be invoked through createTidegateRuntime as a remote backend action", async () => {
    const { POST, getCalls } = createCustomerActionHandler();
    const action = createTidegateActionBridgeAction({
      id: "booking.cancel",
      description: "Cancel one appointment.",
      inputSchema,
      outputSchema,
      effects: "write",
      tenantScope: {
        tenantId: "demo-salon",
      },
      endpoint: "https://customer.example.com/api/tidegate/actions",
      actionBridgeSecret: "secret_123",
      fetchImpl: async (input, init) => POST(requestFromFetch(input, init)),
    });
    const interaction = defineInteraction({
      contract: {
        ...cancelAppointmentContract,
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["ok", "appointmentId", "tenantId"],
            properties: {
              ok: { type: "boolean" },
              appointmentId: { type: "string" },
              tenantId: { type: "string" },
            },
          },
        },
      },
      async run(input, ctx) {
        return ctx.actions.call("booking.cancel", input);
      },
    });
    const runtime = createTidegateRuntime({
      actions: new Map([["booking.cancel", action]]),
      interactions: createInteractionRegistry([interaction]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: "ix.booking.cancelAppointment",
      request: validRequest,
      auth,
    });

    expect(response).toMatchObject({
      status: "ok",
      output: {
        ok: true,
        appointmentId: "apt_123",
        tenantId: "demo-salon",
      },
    });
    expect(getCalls()).toBe(1);
  });

  test("maps customer action bridge rejections back into runtime responses", async () => {
    const { POST, getCalls } = createCustomerActionHandler();
    const action = createTidegateActionBridgeAction({
      id: "booking.cancel",
      description: "Cancel one appointment.",
      inputSchema,
      outputSchema,
      effects: "write",
      tenantScope: {
        tenantId: "demo-salon",
      },
      endpoint: "https://customer.example.com/api/tidegate/actions",
      actionBridgeSecret: "wrong_secret",
      fetchImpl: async (input, init) => POST(requestFromFetch(input, init)),
    });
    const interaction = defineInteraction({
      contract: cancelAppointmentContract,
      async run(input, ctx) {
        return ctx.actions.call("booking.cancel", input);
      },
    });
    const runtime = createTidegateRuntime({
      actions: new Map([["booking.cancel", action]]),
      interactions: createInteractionRegistry([interaction]),
    });

    const response = await runtime.invokeInteraction({
      interactionId: "ix.booking.cancelAppointment",
      request: validRequest,
      auth,
    });

    expect(response).toMatchObject({
      status: "rejected",
      error: {
        code: "auth_required",
      },
    });
    expect(getCalls()).toBe(0);
  });
});
