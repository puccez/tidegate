# Tidegate Runtime

Runtime helpers for executing public Tidegate interactions against trusted backend
actions.

## Remote action bridge

Use `createTidegateRemoteActionCatalogFromUrl(...)` in Tidegate's trusted server
runtime when the customer publishes a `tidegate.actionCatalog.v1` manifest. The
manifest supplies action ids, JSON Schemas, effects, permissions, tenant policy,
and audit metadata; the bridge secret stays in server configuration.

```ts
import {
  createTidegateRemoteActionCatalogFromUrl,
  createTidegateRuntime,
} from "@tidegate/runtime";

const actions = await createTidegateRemoteActionCatalogFromUrl({
  actionCatalogUrl: process.env.TIDEGATE_ACTION_CATALOG_URL!,
  actionEndpointUrl: process.env.TIDEGATE_ACTION_ENDPOINT_URL!,
  actionBridgeSecret: process.env.TIDEGATE_ACTION_BRIDGE_SECRET!,
});

const runtime = createTidegateRuntime({
  actions,
  interactions,
});
```

Use `createTidegateActionBridgeAction(...)` when an interaction should call a
developer-owned backend endpoint through the Tidegate action bridge instead of an
in-process function.

```ts
import { z } from "zod";
import {
  createTidegateActionBridgeAction,
  defineActionsCatalog,
} from "@tidegate/runtime";

const actions = defineActionsCatalog({
  "booking.cancel": createTidegateActionBridgeAction({
    id: "booking.cancel",
    description: "Cancel one appointment in the current salon.",
    effects: "write",
    requiredPermissions: ["booking:write"],
    tenantScope: {
      tenantId: "demo-salon",
    },
    endpoint: "https://customer.example.com/api/tidegate/actions",
    actionBridgeSecret: process.env.TIDEGATE_ACTION_BRIDGE_SECRET,
    inputSchema: z.object({
      appointmentId: z.string().min(1),
      reason: z.string().optional(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      appointmentId: z.string(),
    }),
  }),
});
```

The runtime still enforces the interaction allowlist, effect level, permissions,
tenant scope, input schema, output schema, and timeout before returning an
`InvokeInteractionResponse`. The bridge request carries only server-derived auth
context and the interaction action allowlist; callers never send tenant ids,
roles, permissions, or backend action ids directly to the browser.

## Typed capability codegen

Use `prepareTidegateSandboxCapabilities(...)` on Tidegate's side to turn a
`tidegate.actionCatalog.v1` manifest into sandbox TypeScript and write it into a
sandbox workspace. The generated file gives interaction code a typed
`ctx.capabilities` surface while keeping the raw action caller outside the
untrusted interaction context.

```ts
import { prepareTidegateSandboxCapabilities } from "@tidegate/runtime";

const prepared = await prepareTidegateSandboxCapabilities({
  sandbox,
  manifest,
});
```

By default this writes `tidegate-capabilities.generated.ts` at the sandbox
workspace root. Generated interaction code can then compile against:

```ts
import type { TidegateGeneratedInteractionContext } from "./tidegate-capabilities.generated";

export default async function run(
  input: { appointmentId: string },
  ctx: TidegateGeneratedInteractionContext,
) {
  const tenantId = ctx.auth.tenantId;

  return ctx.capabilities.booking.cancel({
    appointmentId: input.appointmentId,
  });
}
```

At runtime the generated helper maps the capability object back onto the trusted
runtime action caller:

```ts
import { withTidegateCapabilities } from "./tidegate-capabilities.generated";

const output = await run(input, withTidegateCapabilities(ctx));
```

That wrapper makes this call:

```ts
ctx.capabilities.booking.cancel({
  appointmentId: "apt_123",
});
```

route internally to the trusted action caller:

```ts
actions.call("booking.cancel", { appointmentId: "apt_123" });
```

The generated context type includes `auth`, `signal`, and `capabilities`; it
does not expose the raw action caller to generated interaction source.
Capability types are a developer experience layer; the runtime action caller
still validates policy and schemas.

The generated client is disposable sandbox code. Runtime validation and action
bridge policy remain authoritative.

## Published interaction execution

Published interaction artifacts execute through the `PublishedInteractionExecutor`
boundary. The default sandboxed executor writes the immutable source snapshot
and generated capabilities into a temporary execution workspace, runs the
generated `run(input, ctx)` function through a local process provider, and routes
capability calls back through `PublishedInteractionTrustedRuntime.callAction`.

```ts
import { createSandboxedPublishedInteractionExecutor } from "@tidegate/runtime";

const executor = createSandboxedPublishedInteractionExecutor();
```

Tests and local route harnesses can use `createFakePublishedInteractionExecutor`
to assert invoke behavior without starting a sandbox process. Both executors
receive an immutable execution payload with the artifact identity, action
allowlist, auth context, invocation id, timeout, and one-invocation action-call
token.

## Authoring workspace action files

`materializeInteractionAuthoringWorkspace(...)` also writes an `actions/`
folder next to `interaction.ts`:

```txt
tidegate-interactions/
  ix.booking.cancelAppointment/
    interaction.ts
    interaction.test.ts
    publish-request.json
    tidegate-capabilities.generated.ts
    actions/
      README.md
      catalog.json
      index.ts
      booking/
        cancel.ts
```

This folder is generated from the same effective action catalog manifest as the
capability client. It gives coding agents a filesystem-first TypeScript surface
for discovery: action ids, schemas, permissions, effects, input/output types,
and copyable call shapes such as `ctx.capabilities.booking.cancel(input)`.

The publish/runtime boundary remains unchanged: published interaction source
should call `ctx.capabilities.*` directly, and server-side validation still
checks the allowlist, schemas, permissions, effects, and tenant policy.
