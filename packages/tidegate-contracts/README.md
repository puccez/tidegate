# @tidegate/contracts

Zod schemas and types shared across Tidegate: interaction manifests and
published interactions, action bridge and action catalog manifests
(`tidegate.actionCatalog.v1`), execution tracing, confirmation tokens, auth
context, and the public interaction invoke routes.

This package is the wire contract between a customer backend (see
`@tidegate/sdk`) and the Tidegate runtime: every payload that crosses the
boundary is validated against these schemas on both sides.

```ts
import {
  InvokeInteractionRequestSchema,
  TidegateActionCatalogManifestV1Schema,
} from "@tidegate/contracts";
```

## Publishing

The workspace `package.json` stays `private` and points at TypeScript source.
The publishable artifact is generated:

```bash
bun run build:pack
cd dist-pkg && npm pack   # or npm publish
```
