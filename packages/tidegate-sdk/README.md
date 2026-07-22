# Tidegate SDK

Minimal TypeScript SDK for connecting a trusted server to Tidegate.

Server/API-key helpers live under `@tidegate/sdk/server` so they are not
pulled into browser bundles from the root package entrypoint.

## Action bridge

Use the action bridge to expose your backend capabilities to Tidegate. Tidegate can call
only registered actions that are also allowlisted by the invoking interaction,
with input validation, declared-output validation, and server-derived auth.

```txt
TIDEGATE_ACTION_BRIDGE_SECRET=shared_secret_configured_in_tidegate
```

```ts
import { z } from "zod";
import {
  createTidegateActionCatalogManifest,
  createTidegateActionHandler,
  defineTidegateActions,
  tidegateAction,
} from "@tidegate/sdk/server";

const BookingCancelInput = z.object({
  appointmentId: z.string().min(1),
  reason: z.string().optional(),
});

const BookingCancelOutput = z.object({
  ok: z.boolean(),
  appointmentId: z.string(),
});

const actions = defineTidegateActions({
  booking: {
    cancel: tidegateAction({
      input: BookingCancelInput,
      returns: BookingCancelOutput,
      effects: "write",
      requiredPermissions: ["booking:write"],
      tenantScope: { fromAuth: "tenantId" },

      async execute(input, ctx) {
        return cancelAppointment({
          appointmentId: input.appointmentId,
          reason: input.reason,
          tenantId: ctx.auth.tenantId!,
        });
      },
    }),
  },
});

export const POST = createTidegateActionHandler(actions);

export const manifest = createTidegateActionCatalogManifest(actions, {
  catalogId: "acme-books",
  version: "2026-06-24T00:00:00.000Z",
});
```

`returns` is optional, like Convex return validators. If you omit it, TypeScript
still infers the return type of `execute` without a `Promise<...>` annotation,
and Tidegate emits a permissive output contract until static return-type codegen is
enabled:

```ts
const actions = defineTidegateActions({
  booking: {
    cancel: tidegateAction({
      input: BookingCancelInput,
      effects: "write",

      async execute(input, ctx) {
        return {
          ok: true,
          appointmentId: input.appointmentId,
          tenantId: ctx.auth.tenantId,
        };
      },
    }),
  },
});
```

The request body is limited to `actionId`, `input`, and optional `invocationId`.
Do not accept `tenantId`, roles, permissions, or user ids from the body. The
handler derives auth and the interaction action allowlist from the verified Tidegate
request.

The manifest is not executable code. Tidegate uses it to generate a sandbox
TypeScript client such as `ctx.capabilities.booking.cancel(...)`; the real
backend action still executes only through `createTidegateActionHandler(...)`.
The SDK normalizes the namespaced action tree above to the stable wire action id
`booking.cancel` for manifests, audit logs, allowlists, and bridge calls.

## Server invoke

Use `interactions.invoke` when your backend, job, or UI server action wants to
execute a public Tidegate interaction. This is separate from exposing backend actions
to Tidegate.

Set the API key in the server environment:

```txt
TIDEGATE_API_KEY=evk_live_...
```

Then call a public interaction id:

```ts
import { createTidegateServerClient } from "@tidegate/sdk/server";

const tidegate = createTidegateServerClient();

const result = await tidegate.interactions.invoke("ix.booking.cancelAppointment", {
  interactionVersion: "1",
  input: {
    appointmentId: "apt_123",
    reason: "Client requested cancellation",
  },
  surfaceId: "booking-page",
  sessionId: "sess_123",
  messageId: "msg_123",
  idempotencyKey: "ix.booking.cancelAppointment:sess_123:apt_123",
});
```

The SDK validates both the request envelope and Tidegate's response with
`@tidegate/contracts`.

For local development, staging, or self-hosting, pass explicit overrides:

```ts
const tidegate = createTidegateServerClient({
  apiKey: process.env.CUSTOM_TIDEGATE_API_KEY,
  baseUrl: "http://localhost:3000/api/v1",
});
```
