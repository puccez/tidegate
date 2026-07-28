// Live end-to-end run of `doctor --e2e` against a REAL Tidegate control plane,
// gated on the environment (spec: "condizionato alla disponibilità di un
// control plane in esecuzione"). To run it:
//
//   1. Start a control plane (e.g. `bun dev` in apps/tidegate-agent) with the
//      customer-backend env pointing at this test's backend:
//        TIDEGATE_ACTION_CATALOG_URL=http://127.0.0.1:8787/api/action-catalog
//        TIDEGATE_ACTION_ENDPOINT_URL=http://127.0.0.1:8787/api/actions
//        TIDEGATE_ACTION_BRIDGE_SECRET=<same value as below>
//   2. Run the tests with:
//        TIDEGATE_DOCTOR_E2E_API_BASE_URL=http://127.0.0.1:3000/api/v1 \
//        TIDEGATE_DOCTOR_E2E_API_TOKEN=local-dev \
//        TIDEGATE_ACTION_BRIDGE_SECRET=dev_secret \
//        bun test doctor.live
//
// Optional: TIDEGATE_DOCTOR_E2E_BACKEND_PORT (default 8787).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createTidegateActionCatalogManifest,
  createTidegateActionHandler,
} from "@tidegate/sdk/server";

import { actions } from "../test-fixtures/golden/tidegate/actions.ts";
import { runCreateTidegate } from "./cli.ts";
import type { DoctorReport } from "./doctor.ts";

const apiBaseUrl = process.env.TIDEGATE_DOCTOR_E2E_API_BASE_URL;
const apiToken = process.env.TIDEGATE_DOCTOR_E2E_API_TOKEN;
const bridgeSecret = process.env.TIDEGATE_ACTION_BRIDGE_SECRET;
const backendPort = Number(process.env.TIDEGATE_DOCTOR_E2E_BACKEND_PORT ?? "8787");
const enabled =
  apiBaseUrl !== undefined && apiToken !== undefined && bridgeSecret !== undefined;

let backend: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
  if (!enabled) {
    return;
  }

  const handleActions = createTidegateActionHandler(actions, {
    actionBridgeSecret: bridgeSecret,
  });
  const manifest = createTidegateActionCatalogManifest(actions, {
    catalogId: "create-tidegate-live-test",
  });

  backend = Bun.serve({
    port: backendPort,
    async fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === "/api/action-catalog" && request.method === "GET") {
        return Response.json(manifest);
      }

      if (pathname === "/api/actions" && request.method === "POST") {
        return handleActions(request);
      }

      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  backend?.stop(true);
});

describe.skipIf(!enabled)("doctor --e2e against a live control plane", () => {
  test("publishes, invokes, and archives the ephemeral smoke interaction", async () => {
    const stdout: string[] = [];
    const exitCode = await runCreateTidegate(
      [
        "doctor",
        "--json",
        "--catalog-url",
        `http://127.0.0.1:${backendPort}/api/action-catalog`,
        "--actions-url",
        `http://127.0.0.1:${backendPort}/api/actions`,
        "--secret",
        bridgeSecret ?? "",
        "--e2e",
        "--api-base-url",
        apiBaseUrl ?? "",
        "--token",
        apiToken ?? "",
      ],
      { env: {}, stdout: (line) => stdout.push(line) },
    );

    const report = JSON.parse(stdout.join("\n")) as DoctorReport;
    const byId = Object.fromEntries(
      report.stages.map((stage) => [stage.id, stage]),
    );

    expect(byId["e2e-publish"]?.status).toBe("pass");
    expect(byId["e2e-invoke"]?.status).toBe("pass");
    expect(byId["e2e-archive"]?.status).toBe("pass");
    expect(exitCode).toBe(0);
  }, 120_000);
});
