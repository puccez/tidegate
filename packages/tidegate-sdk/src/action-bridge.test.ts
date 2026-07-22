import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { TidegateAuthContext } from "@tidegate/contracts";
import {
  TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER,
  TIDEGATE_ACTION_AUTH_CONTEXT_HEADER,
  TIDEGATE_ACTION_INTERACTION_ID_HEADER,
  TIDEGATE_ACTION_BRIDGE_SECRET_HEADER,
  createTidegateActionHandler,
  createTidegateActionCatalogManifest,
  defineTidegateActions,
  tidegateAction,
  TidegateActionHandlerError,
  verifyTidegateActionRequest,
  type TidegateActionCatalog,
  type TidegateActionShorthandDefinition,
} from "./server";

const auth: TidegateAuthContext = {
  authMode: "api-key",
  organizationId: "demo-salon",
  tenantId: "demo-salon",
  subjectId: "api_key_demo",
  subjectType: "api_key",
  credentialId: "api_key_demo",
  credentialType: "api_key",
  scopes: ["tidegate:action:invoke"],
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

function createRequest({
  actionId = "booking.cancel",
  body,
  headers,
  input = {
    appointmentId: "apt_123",
    reason: "Client requested cancellation",
  },
}: {
  actionId?: string;
  body?: unknown;
  headers?: RequestInit["headers"];
  input?: unknown;
} = {}) {
  return new Request("https://customer.example.com/api/tidegate/actions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TIDEGATE_ACTION_BRIDGE_SECRET_HEADER]: "secret_123",
      [TIDEGATE_ACTION_AUTH_CONTEXT_HEADER]: JSON.stringify(auth),
      [TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER]: JSON.stringify(["booking.cancel"]),
      [TIDEGATE_ACTION_INTERACTION_ID_HEADER]: "ix.booking.cancelAppointment",
      ...headers,
    },
    body: JSON.stringify(
      body ?? {
        actionId,
        input,
        invocationId: "act_inv_123",
      },
    ),
  });
}

function createActions({ output = undefined as unknown } = {}) {
  let calls = 0;
  const actions = defineTidegateActions({
    booking: {
      cancel: tidegateAction({
        input: inputSchema,
        returns: outputSchema,
        effects: "write",
        requiredPermissions: ["booking:write"],
        async execute(input, ctx) {
          calls += 1;
          if (output !== undefined) {
            return output as z.infer<typeof outputSchema>;
          }

          return {
            ok: true,
            appointmentId: input.appointmentId,
            tenantId: ctx.auth.tenantId!,
          };
        },
      }),
    },
  });

  return {
    actions,
    getCalls: () => calls,
  };
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("verifyTidegateActionRequest", () => {
  test("derives auth from a verified Tidegate action request", () => {
    const verified = verifyTidegateActionRequest({
      actionBridgeSecret: "secret_123",
      request: createRequest(),
    });

    expect(verified).toMatchObject({
      auth: {
        authMode: "api-key",
        tenantId: "demo-salon",
        permissions: ["booking:write"],
      },
      allowedActionIds: ["booking.cancel"],
      interactionId: "ix.booking.cancelAppointment",
    });
  });

  test("rejects requests without a valid action credential", () => {
    expect(() =>
      verifyTidegateActionRequest({
        actionBridgeSecret: "secret_123",
        request: createRequest({
          headers: {
            [TIDEGATE_ACTION_BRIDGE_SECRET_HEADER]: "wrong_secret",
          },
        }),
      }),
    ).toThrow("The Tidegate action request is missing a valid credential.");
  });
});

describe("createTidegateActionHandler", () => {
  test("executes a registered action with validated input and server-derived auth", async () => {
    const { actions, getCalls } = createActions();
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      status: "ok",
      invocationId: "act_inv_123",
      output: {
        ok: true,
        appointmentId: "apt_123",
        tenantId: "demo-salon",
      },
    });
    expect(getCalls()).toBe(1);
  });

  test("supports custom request verification without trusting body auth", async () => {
    const { actions, getCalls } = createActions();
    const POST = createTidegateActionHandler(actions, {
      verifyRequest: async () => ({
        auth,
        allowedActionIds: ["booking.cancel"],
      }),
    });

    const response = await POST(
      createRequest({
        headers: {
          [TIDEGATE_ACTION_BRIDGE_SECRET_HEADER]: "",
          [TIDEGATE_ACTION_AUTH_CONTEXT_HEADER]: "",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(getCalls()).toBe(1);
  });

  test("rejects body-supplied tenant or auth fields before action execution", async () => {
    const { actions, getCalls } = createActions();
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(
      createRequest({
        body: {
          actionId: "booking.cancel",
          input: {
            appointmentId: "apt_123",
          },
          tenantId: "attacker-controlled",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      status: "rejected",
      error: {
        code: "invalid_request",
      },
    });
    expect(getCalls()).toBe(0);
  });

  test("rejects unregistered actions", async () => {
    const { actions, getCalls } = createActions();
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(
      createRequest({
        actionId: "booking.refund",
        headers: {
          [TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER]: JSON.stringify([
            "booking.refund",
          ]),
        },
      }),
    );

    expect(response.status).toBe(404);
    expect(await json(response)).toMatchObject({
      status: "rejected",
      error: {
        code: "action_not_found",
      },
    });
    expect(getCalls()).toBe(0);
  });

  test("rejects registered actions that are not interaction-allowlisted", async () => {
    const { actions, getCalls } = createActions();
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(
      createRequest({
        headers: {
          [TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER]: JSON.stringify(["booking.read"]),
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({
      status: "rejected",
      error: {
        code: "action_not_allowed",
      },
    });
    expect(getCalls()).toBe(0);
  });

  test("rejects invalid action input", async () => {
    const { actions, getCalls } = createActions();
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(
      createRequest({
        input: {
          appointmentId: "",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      status: "rejected",
      error: {
        code: "action_input_invalid",
      },
    });
    expect(getCalls()).toBe(0);
  });

  test("rejects missing action permissions", async () => {
    const { actions, getCalls } = createActions();
    const POST = createTidegateActionHandler(actions, {
      verifyRequest: async () => ({
        auth: {
          ...auth,
          permissions: [],
          authorization: {
            permissions: [],
            resourceGrants: [],
          },
        },
        allowedActionIds: ["booking.cancel"],
      }),
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({
      status: "rejected",
      error: {
        code: "permission_denied",
      },
    });
    expect(getCalls()).toBe(0);
  });

  test("fails when action output does not match the registered schema", async () => {
    const { actions } = createActions({
      output: {
        ok: true,
        appointmentId: 123,
        tenantId: "demo-salon",
      },
    });
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(500);
    expect(await json(response)).toMatchObject({
      status: "failed",
      error: {
        code: "action_output_invalid",
      },
    });
  });

  test("returns a stable failure when action execution throws", async () => {
    const actions = defineTidegateActions({
      "booking.cancel": {
        input: inputSchema,
        output: outputSchema,
        effects: "write",
        async execute() {
          throw new Error("database unavailable");
        },
      },
    });
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(500);
    expect(await json(response)).toMatchObject({
      status: "failed",
      error: {
        code: "action_failed",
      },
    });
  });

  test("forwards the invocation id to the action execute context", async () => {
    let seenInvocationId: string | undefined;
    const actions = defineTidegateActions({
      "booking.cancel": {
        input: inputSchema,
        output: outputSchema,
        effects: "write",
        async execute({ invocationId, auth: executeAuth }) {
          seenInvocationId = invocationId;
          return {
            ok: true,
            appointmentId: "apt_123",
            tenantId: executeAuth.tenantId ?? "",
          };
        },
      },
    });
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(seenInvocationId).toBe("act_inv_123");
  });

  test("preserves a structured TidegateActionHandlerError thrown by the action", async () => {
    const actions = defineTidegateActions({
      "booking.cancel": {
        input: inputSchema,
        output: outputSchema,
        effects: "write",
        async execute() {
          throw new TidegateActionHandlerError(
            "auth_required",
            "The downstream gateway token could not be minted.",
            401,
            "rejected",
          );
        },
      },
    });
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({
      status: "rejected",
      invocationId: "act_inv_123",
      error: {
        code: "auth_required",
        message: "The downstream gateway token could not be minted.",
      },
    });
  });

  test("keeps the structured code when the thrown error has an empty message", async () => {
    const actions = defineTidegateActions({
      "booking.cancel": {
        input: inputSchema,
        output: outputSchema,
        effects: "write",
        async execute() {
          throw new TidegateActionHandlerError(
            "permission_denied",
            "",
            403,
            "rejected",
          );
        },
      },
    });
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({
      status: "rejected",
      invocationId: "act_inv_123",
      error: {
        code: "permission_denied",
        message:
          "The Tidegate action failed with error code permission_denied and no message.",
      },
    });
  });
});

describe("createTidegateActionCatalogManifest", () => {
  test("derives a portable action catalog manifest from namespaced TypeScript action definitions", () => {
    const actions = defineTidegateActions({
      booking: {
        cancel: tidegateAction({
          description: "Cancel one appointment in the current salon.",
          input: inputSchema,
          returns: outputSchema,
          effects: "write",
          requiredPermissions: ["booking:write"],
          tenantScope: { fromAuth: "tenantId" },
          async execute(input, ctx) {
            return {
              ok: true,
              appointmentId: input.appointmentId,
              tenantId: ctx.auth.tenantId!,
            };
          },
        }),
      },
    });

    const manifest = createTidegateActionCatalogManifest(actions, {
      catalogId: "acme-books",
      version: "2026-06-24T00:00:00.000Z",
    });

    expect(manifest).toMatchObject({
      schemaVersion: "tidegate.actionCatalog.v1",
      catalogId: "acme-books",
      version: "2026-06-24T00:00:00.000Z",
      actions: {
        "booking.cancel": {
          description: "Cancel one appointment in the current salon.",
          effects: "write",
          requiredPermissions: ["booking:write"],
          tenantScope: { fromAuth: "tenantId" },
          audit: {
            required: true,
            redactPaths: [],
          },
        },
      },
    });
    expect(Object.keys(manifest.actions)).toEqual(["booking.cancel"]);
    expect(manifest.actions["booking.cancel"]?.input).toMatchObject({
      type: "object",
      required: ["appointmentId"],
      properties: {
        appointmentId: {
          type: "string",
          minLength: 1,
        },
      },
      additionalProperties: false,
    });
    expect(
      "execute" in
        (manifest.actions["booking.cancel"] as unknown as Record<string, unknown>),
    ).toBe(false);
  });

  test("uses stable fallback metadata for minimal action definitions", () => {
    const { actions } = createActions();
    const manifest = createTidegateActionCatalogManifest(actions, {
      catalogId: "demo",
    });

    expect(manifest.version).toBe("1");
    expect(manifest.actions["booking.cancel"]).toMatchObject({
      description: "booking.cancel",
      audit: {
        required: true,
        redactPaths: [],
      },
    });
  });

  test("keeps flat action ids compatible for existing integrations", () => {
    const actions = defineTidegateActions({
      "booking.cancel": {
        input: inputSchema,
        output: outputSchema,
        effects: "write",
        async execute({ input, auth }) {
          return {
            ok: true,
            appointmentId: input.appointmentId,
            tenantId: auth.tenantId,
          };
        },
      },
    });
    const manifest = createTidegateActionCatalogManifest(actions, {
      catalogId: "demo",
    });

    expect(Object.keys(manifest.actions)).toEqual(["booking.cancel"]);
  });

  test("keeps normalized tidegateAction input/output definitions compatible", () => {
    const actions = defineTidegateActions({
      "booking.cancel": tidegateAction({
        input: inputSchema,
        output: outputSchema,
        effects: "write",
        async execute({ input, auth }) {
          return {
            ok: true,
            appointmentId: input.appointmentId,
            tenantId: auth.tenantId ?? "demo-salon",
          };
        },
      }),
    });
    const manifest = createTidegateActionCatalogManifest(actions, {
      catalogId: "demo",
    });

    expect(Object.keys(manifest.actions)).toEqual(["booking.cancel"]);
    expect(manifest.actions["booking.cancel"]?.output).toMatchObject({
      type: "object",
      required: ["ok", "appointmentId", "tenantId"],
    });
  });

  test("rejects duplicate action ids created by mixed flat and namespaced definitions", () => {
    expect(() =>
      defineTidegateActions({
        "booking.cancel": tidegateAction({
          input: inputSchema,
          returns: outputSchema,
          effects: "write",
          async execute(input) {
            return {
              ok: true,
              appointmentId: input.appointmentId,
              tenantId: "demo-salon",
            };
          },
        }),
        booking: {
          cancel: tidegateAction({
            input: inputSchema,
            returns: outputSchema,
            effects: "write",
            async execute(input) {
              return {
                ok: true,
                appointmentId: input.appointmentId,
                tenantId: "demo-salon",
              };
            },
          }),
        },
      }),
    ).toThrow('Duplicate Tidegate action id "booking.cancel"');
  });

  test("rejects action ids that collide with generated capability namespaces", () => {
    expect(() =>
      defineTidegateActions({
        booking: tidegateAction({
          input: z.object({}),
          returns: z.object({ ok: z.boolean() }),
          effects: "read",
          async execute() {
            return { ok: true };
          },
        }),
        "booking.cancel": tidegateAction({
          input: inputSchema,
          returns: outputSchema,
          effects: "write",
          async execute(input) {
            return {
              ok: true,
              appointmentId: input.appointmentId,
              tenantId: "demo-salon",
            };
          },
        }),
      }),
    ).toThrow('Tidegate action id "booking.cancel" conflicts with "booking"');
  });

  test("infers shorthand action input and context types for developer DX", () => {
    const actions = defineTidegateActions({
      booking: {
        cancel: tidegateAction({
          input: inputSchema,
          returns: outputSchema,
          effects: "write",
          async execute(input, ctx) {
            const appointmentId: string = input.appointmentId;
            const tenantId: string | undefined = ctx.auth.tenantId;

            // @ts-expect-error bookingId is not part of the registered input schema.
            input.bookingId;

            return {
              ok: true,
              appointmentId,
              tenantId: tenantId ?? "demo-salon",
            };
          },
        }),
      },
    });

    expect(actions.booking.cancel.effects).toBe("write");
  });

  test("allows returns to be omitted and infers async execute output without a Promise annotation", async () => {
    const actions = defineTidegateActions({
      booking: {
        cancel: tidegateAction({
          input: inputSchema,
          effects: "write",
          requiredPermissions: ["booking:write"],
          async execute(input, ctx) {
            const result = {
              ok: true,
              appointmentId: input.appointmentId,
              tenantId: ctx.auth.tenantId ?? "demo-salon",
            };

            const typedResult: {
              ok: boolean;
              appointmentId: string;
              tenantId: string;
            } = result;

            return typedResult;
          },
        }),
      },
    });
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(createRequest());
    const manifest = createTidegateActionCatalogManifest(actions, {
      catalogId: "demo",
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      status: "ok",
      output: {
        ok: true,
        appointmentId: "apt_123",
        tenantId: "demo-salon",
      },
    });
    expect(manifest.actions["booking.cancel"]?.output).toEqual({});
  });

  test("normalizes returns-less undefined output to null", async () => {
    const actions = defineTidegateActions({
      booking: {
        cancel: tidegateAction({
          input: inputSchema,
          effects: "write",
          requiredPermissions: ["booking:write"],
          async execute() {
            return undefined;
          },
        }),
      },
    });
    const POST = createTidegateActionHandler(actions, {
      actionBridgeSecret: "secret_123",
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      status: "ok",
      output: null,
    });
  });

  test("keeps the legacy TidegateActionShorthandDefinition type compatible", () => {
    const legacyAction: TidegateActionShorthandDefinition<
      typeof inputSchema,
      typeof outputSchema
    > = {
      inputSchema,
      outputSchema,
      effects: "write",
      async execute(input) {
        return {
          ok: true,
          appointmentId: input.appointmentId,
          tenantId: "demo-salon",
        };
      },
    };
    const actions = defineTidegateActions({
      booking: {
        cancel: tidegateAction(legacyAction),
      },
    });

    expect(actions.booking.cancel.effects).toBe("write");
  });

  test("rejects shorthand definitions that forgot the tidegateAction wrapper", () => {
    expect(() =>
      defineTidegateActions({
        booking: {
          cancel: {
            input: inputSchema,
            returns: outputSchema,
            effects: "write",
            async execute(input: z.infer<typeof inputSchema>) {
              return {
                ok: true,
                appointmentId: input.appointmentId,
                tenantId: "demo-salon",
              };
            },
          },
        },
      } as unknown as TidegateActionCatalog),
    ).toThrow(
      'Invalid Tidegate action "booking.cancel". Wrap input/returns shorthand definitions with tidegateAction(...).',
    );
  });

  test("rejects empty action namespaces", () => {
    expect(() =>
      defineTidegateActions({
        booking: {},
      } as unknown as TidegateActionCatalog),
    ).toThrow(
      'Invalid Tidegate action namespace "booking". Namespaces must contain at least one action.',
    );
  });

  test("rejects catalog keys that cannot become stable string action ids", () => {
    expect(() =>
      defineTidegateActions({
        booking: {
          [Symbol("cancel")]: tidegateAction({
            input: inputSchema,
            returns: outputSchema,
            effects: "write",
            async execute(input) {
              return {
                ok: true,
                appointmentId: input.appointmentId,
                tenantId: "demo-salon",
              };
            },
          }),
        },
      } as unknown as TidegateActionCatalog),
    ).toThrow(
      'Tidegate action namespace "booking" must use string keys only; symbol keys cannot become stable Tidegate action ids.',
    );
  });

  test("rejects catalogs with non-plain namespace prototypes", () => {
    const action = tidegateAction({
      input: inputSchema,
      returns: outputSchema,
      effects: "write",
      async execute(input) {
        return {
          ok: true,
          appointmentId: input.appointmentId,
          tenantId: "demo-salon",
        };
      },
    });

    expect(() =>
      defineTidegateActions({
        __proto__: {
          cancel: action,
        },
      } as unknown as TidegateActionCatalog),
    ).toThrow(
      "Tidegate action catalog must be a plain object with string action ids or namespace keys.",
    );
  });
});
