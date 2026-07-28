import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  PublishInteractionRequestSchema,
  InvokeInteractionRequestSchema,
} from "@tidegate/contracts";
import {
  createTidegateActionCatalogManifest,
  createTidegateActionHandler,
  defineTidegateActions,
  tidegateAction,
} from "@tidegate/sdk/server";

import { actions } from "../test-fixtures/golden/tidegate/actions.ts";
import { runCreateTidegate } from "./cli.ts";
import type { DoctorReport, DoctorStage } from "./doctor.ts";

const BRIDGE_SECRET = "test_bridge_secret";
const API_TOKEN = "test_api_token";
const SMOKE_ID = "ix.diagnostics.echo";
const SOURCE_HASH = `sha256:${"a".repeat(64)}`;

// A deliberately wrong diagnostics.ping that does not echo ctx.auth.tenantId:
// doctor must reject it, because the echo is what proves the auth seam.
const noEchoActions = defineTidegateActions({
  diagnostics: {
    ping: tidegateAction({
      description: "Ping without the tenant echo.",
      input: z.object({}).strict(),
      returns: z.object({ pong: z.literal(true) }),
      effects: "read",
      async execute() {
        return { pong: true as const };
      },
    }),
  },
});

// The customer backend under test is the scaffolded golden output itself,
// served over real HTTP: the same catalog manifest and the same
// createTidegateActionHandler route a scaffolded project exposes.
let backend: ReturnType<typeof Bun.serve>;
let backendUrl: string;

// Minimal control plane standing in for the Tidegate API in --e2e runs. Its
// responses conform to the published contracts; request bodies are validated
// against the real schemas.
let controlPlane: ReturnType<typeof Bun.serve>;
let controlPlaneUrl: string;
const controlPlaneCalls: string[] = [];
let publishMode: "ok" | "empty-body" | "other-id" = "ok";
let invokeMode: "ok" | "confirm-then-ok" | "rejected" = "ok";
let invokeAttempts = 0;

beforeAll(() => {
  const handleActions = createTidegateActionHandler(actions, {
    actionBridgeSecret: BRIDGE_SECRET,
  });
  const handleNoEchoActions = createTidegateActionHandler(noEchoActions, {
    actionBridgeSecret: BRIDGE_SECRET,
  });
  const manifest = createTidegateActionCatalogManifest(actions, {
    catalogId: "acme-backend",
  });
  const noPingManifest = createTidegateActionCatalogManifest(
    { example: actions.example },
    { catalogId: "acme-backend" },
  );
  const noEchoManifest = createTidegateActionCatalogManifest(noEchoActions, {
    catalogId: "acme-backend",
  });

  backend = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);

      if (request.method === "GET") {
        switch (pathname) {
          case "/api/action-catalog":
            return Response.json(manifest);
          case "/api/action-catalog-noping":
            return Response.json(noPingManifest);
          case "/api/action-catalog-noecho":
            return Response.json(noEchoManifest);
          case "/api/catalog-html":
            return new Response("<html>login required</html>", {
              headers: { "content-type": "text/html" },
            });
          case "/api/catalog-invalid":
            return Response.json({ schemaVersion: "wrong" });
        }
      }

      if (request.method === "POST") {
        switch (pathname) {
          case "/api/actions":
            return handleActions(request);
          case "/api/actions-noecho":
            return handleNoEchoActions(request);
          case "/api/actions-proxy401":
            return new Response("unauthorized", { status: 401 });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });
  backendUrl = `http://127.0.0.1:${backend.port}`;

  controlPlane = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);

      if (request.headers.get("authorization") !== `Bearer ${API_TOKEN}`) {
        return Response.json(
          {
            status: "rejected",
            error: { code: "auth_required", message: "Invalid credential." },
          },
          { status: 401 },
        );
      }

      if (pathname === "/api/v1/interactions/publish") {
        controlPlaneCalls.push("publish");

        if (publishMode === "empty-body") {
          return new Response(null, { status: 201 });
        }

        const body = PublishInteractionRequestSchema.safeParse(
          await request.json(),
        );

        if (!body.success) {
          return Response.json(
            {
              status: "rejected",
              error: {
                code: "invalid_request",
                message: body.error.issues
                  .map((issue) => issue.message)
                  .join("; "),
              },
            },
            { status: 400 },
          );
        }

        const interactionId =
          publishMode === "other-id"
            ? "ix.diagnostics.unexpected"
            : body.data.requestedInteractionId;

        return Response.json(
          {
            interactionId,
            version: "1",
            sourceHash: SOURCE_HASH,
            visibility: "tenant",
            owner: { tenantId: "tenant_test" },
            invoke: {
              method: "POST",
              path: `/api/v1/interactions/${encodeURIComponent(interactionId)}/invoke`,
            },
          },
          { status: 201 },
        );
      }

      if (pathname === `/api/v1/interactions/${encodeURIComponent(SMOKE_ID)}/invoke`) {
        controlPlaneCalls.push("invoke");
        invokeAttempts += 1;
        const body = InvokeInteractionRequestSchema.safeParse(
          await request.json(),
        );

        if (!body.success || body.data.interactionVersion !== "1") {
          return Response.json(
            {
              status: "rejected",
              invocationId: "inv_1",
              error: {
                code: "invalid_request",
                message: "Invalid invoke request.",
              },
            },
            { status: 400 },
          );
        }

        if (invokeMode === "rejected") {
          return Response.json(
            {
              status: "rejected",
              invocationId: "inv_1",
              error: {
                code: "action_not_registered",
                message: "The backend bridge is not registered.",
              },
            },
            { status: 400 },
          );
        }

        if (invokeMode === "confirm-then-ok" && body.data.confirmationToken === undefined) {
          return Response.json({
            status: "confirmation_required",
            invocationId: "inv_1",
            confirmation: {
              message: "Confirm the diagnostic echo.",
              confirmationToken: "ctk_test",
              inputHash: SOURCE_HASH,
              inputSummary: [{ path: "message", value: "…" }],
              expiresAt: "2026-07-28T00:05:00.000Z",
              confirmRoute: `/api/v1/interactions/${SMOKE_ID}/invoke`,
            },
          });
        }

        if (invokeMode === "confirm-then-ok" && body.data.confirmationToken !== "ctk_test") {
          return Response.json(
            {
              status: "rejected",
              invocationId: "inv_1",
              error: { code: "confirmation_invalid", message: "Bad token." },
            },
            { status: 400 },
          );
        }

        const input = body.data.input as { message?: unknown };

        return Response.json({
          status: "ok",
          invocationId: "inv_1",
          output: { echo: input.message, pong: true },
        });
      }

      if (pathname === `/api/v1/interactions/${encodeURIComponent(SMOKE_ID)}/archive`) {
        controlPlaneCalls.push("archive");
        const body = (await request.json()) as { confirmed?: unknown };

        if (body.confirmed !== true) {
          return Response.json(
            {
              status: "rejected",
              error: {
                code: "confirmation_required",
                message: "This lifecycle change requires confirmed: true.",
              },
            },
            { status: 409 },
          );
        }

        return Response.json({
          interaction: {
            interactionId: SMOKE_ID,
            availabilityStatus: "archived",
            visibility: "tenant",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
  controlPlaneUrl = `http://127.0.0.1:${controlPlane.port}`;
});

beforeEach(() => {
  controlPlaneCalls.length = 0;
  publishMode = "ok";
  invokeMode = "ok";
  invokeAttempts = 0;
});

afterAll(() => {
  backend.stop(true);
  controlPlane.stop(true);
});

async function runDoctorCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; report: DoctorReport; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCreateTidegate(["doctor", "--json", ...args], {
    env,
    stderr: (line) => stderr.push(line),
    stdout: (line) => stdout.push(line),
  });

  const report = JSON.parse(stdout.join("\n")) as DoctorReport;

  return { exitCode, report, stderr };
}

function fullWiringArgs(extra: string[] = []): string[] {
  return [
    "--catalog-url",
    `${backendUrl}/api/action-catalog`,
    "--actions-url",
    `${backendUrl}/api/actions`,
    ...extra,
  ];
}

function e2eArgs(extra: string[] = []): string[] {
  return fullWiringArgs([
    "--secret",
    BRIDGE_SECRET,
    "--e2e",
    "--api-base-url",
    `${controlPlaneUrl}/api/v1`,
    "--token",
    API_TOKEN,
    ...extra,
  ]);
}

function stageById(report: DoctorReport, id: string): DoctorStage {
  const stage = report.stages.find((candidate) => candidate.id === id);

  if (stage === undefined) {
    throw new Error(`Missing stage ${id} in ${JSON.stringify(report)}`);
  }

  return stage;
}

describe("runTidegateDoctor against a scaffolded backend", () => {
  test("all wiring stages pass with the correct secret", async () => {
    const { exitCode, report } = await runDoctorCli(
      fullWiringArgs(["--secret", BRIDGE_SECRET]),
    );

    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(stageById(report, "catalog-fetch").status).toBe("pass");
    expect(stageById(report, "catalog-schema").status).toBe("pass");
    expect(stageById(report, "catalog-schema").detail).toContain(
      "diagnostics.ping",
    );
    expect(stageById(report, "catalog-governance").status).toBe("pass");
    expect(stageById(report, "bridge-auth-reject").status).toBe("pass");
    expect(stageById(report, "bridge-allowlist").status).toBe("pass");
    expect(stageById(report, "bridge-execute").status).toBe("pass");
  });

  test("reads the bridge secret from the environment", async () => {
    const { exitCode, report } = await runDoctorCli(fullWiringArgs(), {
      TIDEGATE_ACTION_BRIDGE_SECRET: BRIDGE_SECRET,
    });

    expect(exitCode).toBe(0);
    expect(stageById(report, "bridge-execute").status).toBe("pass");
  });

  test("a wrong secret fails the authenticated stages but not the reject stage", async () => {
    const { exitCode, report } = await runDoctorCli(
      fullWiringArgs(["--secret", "wrong"]),
    );

    expect(exitCode).toBe(1);
    expect(stageById(report, "bridge-auth-reject").status).toBe("pass");
    expect(stageById(report, "bridge-allowlist").status).toBe("fail");
    expect(stageById(report, "bridge-allowlist").detail).toContain(
      "TIDEGATE_ACTION_BRIDGE_SECRET",
    );
  });

  test("a bare 401 without the contract body is not accepted as a handler rejection", async () => {
    const { exitCode, report } = await runDoctorCli([
      "--catalog-url",
      `${backendUrl}/api/action-catalog`,
      "--actions-url",
      `${backendUrl}/api/actions-proxy401`,
      "--secret",
      BRIDGE_SECRET,
    ]);

    expect(exitCode).toBe(1);
    expect(stageById(report, "bridge-auth-reject").status).toBe("fail");
    expect(stageById(report, "bridge-auth-reject").detail).toContain("proxy");
  });

  test("a ping that does not echo the server-derived tenant fails the execute stage", async () => {
    const { exitCode, report } = await runDoctorCli([
      "--catalog-url",
      `${backendUrl}/api/action-catalog-noecho`,
      "--actions-url",
      `${backendUrl}/api/actions-noecho`,
      "--secret",
      BRIDGE_SECRET,
    ]);

    expect(exitCode).toBe(1);
    expect(stageById(report, "bridge-execute").status).toBe("fail");
    expect(stageById(report, "bridge-execute").detail).toContain("ctx.auth");
  });

  test("without an actions URL the bridge stages are skipped and the summary says unverified", async () => {
    const stdout: string[] = [];
    const exitCode = await runCreateTidegate(
      ["doctor", "--catalog-url", `${backendUrl}/api/action-catalog`],
      { env: {}, stdout: (line) => stdout.push(line) },
    );

    expect(exitCode).toBe(0);
    const output = stdout.join("\n");
    expect(output).toContain("not fully verified");
    expect(output).not.toContain("looks healthy");
  });

  test("an unreachable catalog is the first red line and stops the later stages", async () => {
    const { exitCode, report } = await runDoctorCli([
      "--catalog-url",
      "http://127.0.0.1:9/api/action-catalog",
      "--actions-url",
      `${backendUrl}/api/actions`,
      "--secret",
      BRIDGE_SECRET,
      "--e2e",
      "--api-base-url",
      `${controlPlaneUrl}/api/v1`,
      "--token",
      API_TOKEN,
    ]);

    expect(exitCode).toBe(1);
    expect(stageById(report, "catalog-fetch").status).toBe("fail");
    expect(stageById(report, "bridge").status).toBe("skip");
    expect(stageById(report, "e2e").status).toBe("skip");
    expect(controlPlaneCalls).toEqual([]);
  });

  test("a catalog answering 200 with HTML is diagnosed as non-JSON, not unreachable", async () => {
    const { report } = await runDoctorCli([
      "--catalog-url",
      `${backendUrl}/api/catalog-html`,
    ]);

    expect(stageById(report, "catalog-fetch").status).toBe("fail");
    expect(stageById(report, "catalog-fetch").detail).toContain("not JSON");
  });

  test("a catalog without diagnostics.ping warns the execute stage and skips e2e", async () => {
    const { report } = await runDoctorCli([
      "--catalog-url",
      `${backendUrl}/api/action-catalog-noping`,
      "--actions-url",
      `${backendUrl}/api/actions`,
      "--secret",
      BRIDGE_SECRET,
      "--e2e",
      "--api-base-url",
      `${controlPlaneUrl}/api/v1`,
      "--token",
      API_TOKEN,
    ]);

    expect(stageById(report, "bridge-execute").status).toBe("warn");
    expect(stageById(report, "e2e").status).toBe("skip");
    expect(controlPlaneCalls).toEqual([]);
  });

  test("--e2e publishes, invokes via the returned route, and archives the smoke interaction", async () => {
    const { exitCode, report } = await runDoctorCli(e2eArgs());

    expect(exitCode).toBe(0);
    expect(stageById(report, "e2e-publish").status).toBe("pass");
    expect(stageById(report, "e2e-publish").detail).toContain(SMOKE_ID);
    expect(stageById(report, "e2e-publish").detail).toContain(
      "generated by the Tidegate agent",
    );
    expect(stageById(report, "e2e-invoke").status).toBe("pass");
    expect(stageById(report, "e2e-archive").status).toBe("pass");
    expect(controlPlaneCalls).toEqual(["publish", "invoke", "archive"]);
  });

  test("--e2e handles the confirmation round-trip by re-POSTing the identical body plus the token", async () => {
    invokeMode = "confirm-then-ok";

    const { exitCode, report } = await runDoctorCli(e2eArgs());

    expect(exitCode).toBe(0);
    expect(stageById(report, "e2e-invoke").status).toBe("pass");
    expect(invokeAttempts).toBe(2);
  });

  test("--e2e still archives when the invoke fails", async () => {
    invokeMode = "rejected";

    const { exitCode, report } = await runDoctorCli(e2eArgs());

    expect(exitCode).toBe(1);
    expect(stageById(report, "e2e-invoke").status).toBe("fail");
    expect(stageById(report, "e2e-invoke").detail).toContain(
      "action_not_registered",
    );
    expect(stageById(report, "e2e-archive").status).toBe("pass");
    expect(controlPlaneCalls).toEqual(["publish", "invoke", "archive"]);
  });

  test("--e2e fails cleanly when the publish API returns 2xx without a contract body", async () => {
    publishMode = "empty-body";

    const { exitCode, report } = await runDoctorCli(e2eArgs());

    expect(exitCode).toBe(1);
    expect(stageById(report, "e2e-publish").status).toBe("fail");
    expect(stageById(report, "e2e-publish").detail).toContain("publish contract");
    expect(controlPlaneCalls).toEqual(["publish"]);
  });

  test("--e2e never archives an interaction id it did not request", async () => {
    publishMode = "other-id";

    const { exitCode, report } = await runDoctorCli(e2eArgs());

    expect(exitCode).toBe(1);
    expect(stageById(report, "e2e-publish").status).toBe("fail");
    expect(stageById(report, "e2e-publish").detail).toContain(
      "ix.diagnostics.unexpected",
    );
    expect(controlPlaneCalls).toEqual(["publish"]);
  });

  test("--e2e with a bad token reports the publish rejection", async () => {
    const { exitCode, report } = await runDoctorCli(
      fullWiringArgs([
        "--secret",
        BRIDGE_SECRET,
        "--e2e",
        "--api-base-url",
        `${controlPlaneUrl}/api/v1`,
        "--token",
        "bad_token",
      ]),
    );

    expect(exitCode).toBe(1);
    expect(stageById(report, "e2e-publish").status).toBe("fail");
    expect(stageById(report, "e2e-publish").detail).toContain("auth_required");
  });

  test("human output marks the healthy summary only when everything passed", async () => {
    const stdout: string[] = [];
    const exitCode = await runCreateTidegate(
      ["doctor", ...fullWiringArgs(["--secret", BRIDGE_SECRET])],
      { env: {}, stdout: (line) => stdout.push(line) },
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("Tidegate wiring looks healthy.");
  });
});
