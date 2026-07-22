import { runSandboxBackendConformance } from "./sandbox-backend-conformance";
import { createDeterministicSandboxBackend } from "./sandbox-backend-deterministic";
import {
  createLocalProcessSandboxBackend,
  LocalPublishedInteractionSandboxWorkspaceFactory,
  spawnLocalSandboxRunner,
} from "./sandbox-executor";
import type { SandboxBackend } from "./sandbox-backend";
import { createTransportSandboxProvider } from "./sandbox-ndjson";

runSandboxBackendConformance({
  name: "deterministic",
  createBackend: createDeterministicSandboxBackend,
  // In-process execution cannot be force-killed, so the uninterruptible-
  // runaway + stop()-on-timeout cases run only on transport-backed backends;
  // the deterministic backend asserts timeout result normalization only.
});

runSandboxBackendConformance({
  name: "local-process",
  createBackend: createLocalProcessSandboxBackend,
  runawayTimeout: {
    createObservedBackend: () => {
      let stopCalls = 0;
      const backend: SandboxBackend = {
        workspaceFactory:
          new LocalPublishedInteractionSandboxWorkspaceFactory(),
        provider: createTransportSandboxProvider((request) => {
          const transport = spawnLocalSandboxRunner(request);

          return {
            ...transport,
            async stop() {
              stopCalls += 1;
              await transport.stop();
            },
          };
        }),
      };

      return {
        backend,
        getStopCalls: () => stopCalls,
      };
    },
  },
});
