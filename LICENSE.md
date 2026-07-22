# Licensing

TideGate is open core. Each package in this repository declares its own
license; there is no single repository-wide license.

| Path | License |
|------|---------|
| `packages/tidegate-contracts` | [Apache-2.0](./packages/tidegate-contracts/LICENSE) |
| `packages/tidegate-sdk` | [Apache-2.0](./packages/tidegate-sdk/LICENSE) |
| `packages/tidegate-runtime` | [FSL-1.1-ALv2](./packages/tidegate-runtime/LICENSE) |
| `packages/tidegate-auth-server` | [FSL-1.1-ALv2](./packages/tidegate-auth-server/LICENSE) |
| everything else (build scripts, CI, docs) | Apache-2.0 |

**Apache-2.0** covers the integration surface — the contracts and the SDK any
backend embeds — so adopting TideGate never restricts your own code.

**FSL-1.1-ALv2** (the [Functional Source License](https://fsl.software),
Apache-2.0 future license) covers the kernel and the auth server: the source
is available and free for any purpose except competing with the hosted
TideGate offering, and every release automatically converts to Apache-2.0 two
years after its publication.

Copyright 2026 Emanuele Puccetti.
