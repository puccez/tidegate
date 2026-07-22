import { describe, expect, test } from "bun:test";
import type {
  GeneratedInteractionContractV1,
  InvokeInteractionErrorCode,
  InvokeInteractionRequest,
  InvokeInteractionResponse,
  TidegateActionCatalogManifestV1,
  TidegateAuthContext,
} from "@tidegate/contracts";
import { cancelAppointmentContract } from "@tidegate/contracts/fixtures";
import { createInteractionRegistry, defineInteraction } from "./interaction-registry";
import {
  createTidegateRemoteActionCatalog,
  createTidegateRemoteActionCatalogFromUrl,
} from "./remote-action-catalog";
import { createTidegateRuntime } from "./runtime";
import type { TidegateActionBridgeFetch } from "./action-bridge";

const ACTION_ENDPOINT = "https://customer.example.com/api/tidegate/actions";
const ACTION_CATALOG_URL =
  "https://customer.example.com/api/tidegate/action-catalog";
const ACTION_BRIDGE_SECRET = "server_only_secret";

const manifest: TidegateActionCatalogManifestV1 = {
  schemaVersion: "tidegate.actionCatalog.v1",
  catalogId: "customer-demo",
  version: "2026-06-25.test",
  actions: {
    "booking.cancel": {
      description: "Cancel one appointment in the current salon.",
      input: {
        type: "object",
        required: ["appointmentId"],
        properties: {
          appointmentId: { type: "string", minLength: 1 },
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
      audit: { required: true, redactPaths: ["/reason"] },
    },
  },
};

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

function validRequest(
  overrides: Partial<InvokeInteractionRequest> = {},
): InvokeInteractionRequest {
  return {
    interactionVersion: "1",
    input: {
      appointmentId: "apt_123",
      reason: "Client requested cancellation",
    },
    surfaceId: "remote-action-catalog-test",
    sessionId: "sess_remote_catalog",
    messageId: "msg_remote_catalog",
    idempotencyKey: "ix.booking.cancelAppointment:sess_remote_catalog:apt_123",
    ...overrides,
  };
}

function cloneContract(
  overrides: Partial<GeneratedInteractionContractV1> = {},
): GeneratedInteractionContractV1 {
  return {
    ...structuredClone(cancelAppointmentContract),
    ...overrides,
  };
}

function cancelInteraction(contract = cancelAppointmentContract) {
  return defineInteraction({
    contract,
    async run(input, ctx) {
      return ctx.actions.call("booking.cancel", input);
    },
  });
}

function createRuntime({
  fetchImpl,
  interaction = cancelInteraction(),
  remoteManifest = manifest,
}: {
  fetchImpl: TidegateActionBridgeFetch;
  interaction?: ReturnType<typeof cancelInteraction>;
  remoteManifest?: TidegateActionCatalogManifestV1;
}) {
  const actions = createTidegateRemoteActionCatalog({
    manifest: remoteManifest,
    actionEndpointUrl: ACTION_ENDPOINT,
    actionBridgeSecret: ACTION_BRIDGE_SECRET,
    fetchImpl,
  });

  return createTidegateRuntime({
    actions,
    interactions: createInteractionRegistry([interaction]),
  });
}

function expectErrorCode(
  response: InvokeInteractionResponse,
  status: "rejected" | "failed",
  code: InvokeInteractionErrorCode,
) {
  expect(response.status).toBe(status);

  if (response.status !== status) {
    throw new Error(`Expected ${status} response.`);
  }

  expect(response.error.code).toBe(code);
}

function successfulActionFetch(): {
  fetchImpl: TidegateActionBridgeFetch;
  getActionCalls: () => number;
} {
  let actionCalls = 0;

  return {
    getActionCalls: () => actionCalls,
    fetchImpl: async (input, init) => {
      actionCalls += 1;
      expect(String(input)).toBe(ACTION_ENDPOINT);
      expect(init?.method).toBe("POST");

      const headers = new Headers(init?.headers);
      expect(headers.get("x-tidegate-action-bridge-secret")).toBe(
        ACTION_BRIDGE_SECRET,
      );

      const body = JSON.parse(String(init?.body)) as {
        input?: { appointmentId?: string };
      };

      return Response.json({
        status: "ok",
        output: {
          ok: true,
          appointmentId: body.input?.appointmentId,
        },
      });
    },
  };
}

describe("remote action catalog manifest adapter", () => {
  test("fetches, parses, and registers manifest actions with metadata preserved", async () => {
    let catalogRequests = 0;
    let actionRequests = 0;
    const fetchImpl: TidegateActionBridgeFetch = async (input, init) => {
      if (init?.method === "GET") {
        catalogRequests += 1;
        expect(String(input)).toBe(ACTION_CATALOG_URL);
        return Response.json(manifest);
      }

      actionRequests += 1;
      expect(String(input)).toBe(ACTION_ENDPOINT);
      return Response.json({
        status: "ok",
        output: {
          ok: true,
          appointmentId: "apt_123",
        },
      });
    };
    const actions = await createTidegateRemoteActionCatalogFromUrl({
      actionCatalogUrl: ACTION_CATALOG_URL,
      actionEndpointUrl: ACTION_ENDPOINT,
      actionBridgeSecret: ACTION_BRIDGE_SECRET,
      fetchImpl,
    });
    const action = actions.get("booking.cancel");

    expect(action).toMatchObject({
      id: "booking.cancel",
      effects: "write",
      requiredPermissions: ["booking:write"],
      tenantScope: { fromAuth: "tenantId" },
      audit: { required: true, redactPaths: ["/reason"] },
    });
    expect(JSON.stringify([...actions.values()])).not.toContain(
      ACTION_BRIDGE_SECRET,
    );

    const runtime = createTidegateRuntime({
      actions,
      interactions: createInteractionRegistry([cancelInteraction()]),
    });
    const response = await runtime.invokeInteraction({
      interactionId: "ix.booking.cancelAppointment",
      request: validRequest(),
      auth,
    });

    expect(response).toMatchObject({
      status: "ok",
      output: {
        ok: true,
        appointmentId: "apt_123",
      },
    });
    expect(catalogRequests).toBe(1);
    expect(actionRequests).toBe(1);
  });

  test("returns a typed permission response before calling the bridge", async () => {
    const { fetchImpl, getActionCalls } = successfulActionFetch();
    const runtime = createRuntime({ fetchImpl });
    const response = await runtime.invokeInteraction({
      interactionId: "ix.booking.cancelAppointment",
      request: validRequest(),
      auth: {
        ...auth,
        permissions: [],
        authorization: {
          permissions: [],
          resourceGrants: [],
        },
      },
    });

    expectErrorCode(response, "rejected", "permission_denied");
    expect(getActionCalls()).toBe(0);
  });

  test("validates manifest JSON Schema input before calling the bridge", async () => {
    const { fetchImpl, getActionCalls } = successfulActionFetch();
    const broadInputContract = cloneContract({
      id: "ix.booking.cancelAppointment.broadInput",
      input: {
        schema: {
          type: "object",
        },
      },
    });
    const runtime = createRuntime({
      fetchImpl,
      interaction: cancelInteraction(broadInputContract),
    });
    const response = await runtime.invokeInteraction({
      interactionId: broadInputContract.id,
      request: validRequest({
        input: {
          reason: "Missing appointment id",
        },
      }),
      auth,
    });

    expectErrorCode(response, "failed", "action_input_invalid");
    expect(getActionCalls()).toBe(0);
  });

  test("validates manifest JSON Schema output from the bridge", async () => {
    let actionCalls = 0;
    const runtime = createRuntime({
      fetchImpl: async () => {
        actionCalls += 1;
        return Response.json({
          status: "ok",
          output: {
            ok: "yes",
            appointmentId: "apt_123",
          },
        });
      },
    });
    const response = await runtime.invokeInteraction({
      interactionId: "ix.booking.cancelAppointment",
      request: validRequest(),
      auth,
    });

    expectErrorCode(response, "failed", "action_output_invalid");
    expect(actionCalls).toBe(1);
  });

  test("returns a typed tenant response when fromAuth tenant data is missing", async () => {
    const { fetchImpl, getActionCalls } = successfulActionFetch();
    const runtime = createRuntime({ fetchImpl });
    const response = await runtime.invokeInteraction({
      interactionId: "ix.booking.cancelAppointment",
      request: validRequest(),
      auth: {
        ...auth,
        tenantId: undefined,
      },
    });

    expectErrorCode(response, "rejected", "tenant_mismatch");
    expect(getActionCalls()).toBe(0);
  });
});
