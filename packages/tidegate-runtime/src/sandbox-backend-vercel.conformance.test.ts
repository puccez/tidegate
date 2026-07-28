/**
 * Cross-backend conformance of the Vercel Sandbox backend against REAL
 * microVMs. Each scenario allocates (and destroys) an actual sandbox, so
 * the suite runs only where Vercel credentials are available:
 * `VERCEL_OIDC_TOKEN` (deployments, `vercel env pull` locally) or
 * `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
 *
 * Without credentials the skip is explicit — a green CI without this suite
 * has NOT proven the backend, and says so.
 */
import { test } from "bun:test";
import { runSandboxBackendConformance } from "./sandbox-backend-conformance.ts";
import {
  createVercelSandboxBackend,
  createVercelSandboxRunnerSpawner,
  VercelPublishedInteractionSandboxWorkspaceFactory,
} from "./sandbox-backend-vercel.ts";
import { createTransportSandboxProvider } from "./sandbox-ndjson.ts";
import type { SandboxBackend } from "./sandbox-backend.ts";

const hasVercelCredentials =
  process.env.VERCEL_OIDC_TOKEN !== undefined ||
  (process.env.VERCEL_TOKEN !== undefined &&
    process.env.VERCEL_TEAM_ID !== undefined &&
    process.env.VERCEL_PROJECT_ID !== undefined);

if (!hasVercelCredentials) {
  test.skip(
    "vercel sandbox backend conformance SKIPPED: no Vercel credentials (set VERCEL_OIDC_TOKEN or VERCEL_TOKEN+VERCEL_TEAM_ID+VERCEL_PROJECT_ID to run against real microVMs)",
    () => {},
  );
} else {
  runSandboxBackendConformance({
    name: "vercel",
    createBackend: createVercelSandboxBackend,
    timeoutMs: 180_000,
    runawayTimeout: {
      createObservedBackend: () => {
        let stopCalls = 0;
        const spawnRunner = createVercelSandboxRunnerSpawner();
        const backend: SandboxBackend = {
          workspaceFactory:
            new VercelPublishedInteractionSandboxWorkspaceFactory(),
          provider: createTransportSandboxProvider(async (request) => {
            const transport = await spawnRunner(request);

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
}
