import { describe, expect, test } from "bun:test";
import { runCreateTidegate } from "./cli.ts";
import { registerTidegateActionBackend } from "./register.ts";

const config = {
  apiBaseUrl: "https://tidegate.example/api/v1/",
  token: "org_api_key",
  catalogUrl: "https://backend.example/api/action-catalog",
  actionsUrl: "https://backend.example/api/actions",
  bridgeSecret: "bridge_secret",
};

describe("registerTidegateActionBackend", () => {
  test("PUTs the backend registration with the org API key", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const report = await registerTidegateActionBackend(config, {
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({
          status: "ok",
          registration: {
            organizationId: "org_acme",
            actionCatalogUrl: config.catalogUrl,
            actionEndpointUrl: config.actionsUrl,
            hasActionBridgeSecret: true,
          },
        });
      },
    });

    expect(report.ok).toBe(true);
    expect(report.registration).toMatchObject({ organizationId: "org_acme" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://tidegate.example/api/v1/action-backend");
    expect(requests[0]!.init?.method).toBe("PUT");
    expect(requests[0]!.init?.headers).toMatchObject({
      authorization: "Bearer org_api_key",
    });
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      actionCatalogUrl: config.catalogUrl,
      actionEndpointUrl: config.actionsUrl,
      actionBridgeSecret: config.bridgeSecret,
    });
  });

  test("omits the secret from the payload when not provided", async () => {
    let sentBody: unknown;
    const { bridgeSecret: _bridgeSecret, ...withoutSecret } = config;

    await registerTidegateActionBackend(withoutSecret, {
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(String(init?.body));
        return Response.json({ status: "ok", registration: {} });
      },
    });

    expect(sentBody).toEqual({
      actionCatalogUrl: config.catalogUrl,
      actionEndpointUrl: config.actionsUrl,
    });
  });

  test("maps a rejection envelope into the report", async () => {
    const report = await registerTidegateActionBackend(config, {
      fetchImpl: async () =>
        Response.json(
          {
            status: "rejected",
            error: {
              code: "action_bridge_secret_required",
              message: "actionBridgeSecret is required.",
            },
          },
          { status: 400 },
        ),
    });

    expect(report).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "action_bridge_secret_required" },
    });
  });
});

describe("create-tidegate register (CLI)", () => {
  test("registers using flags and prints a summary", async () => {
    const lines: string[] = [];
    const exitCode = await runCreateTidegate(
      [
        "register",
        "--catalog-url",
        config.catalogUrl,
        "--actions-url",
        config.actionsUrl,
        "--secret",
        config.bridgeSecret,
        "--api-base-url",
        "https://tidegate.example/api/v1",
        "--token",
        config.token,
      ],
      {
        env: {},
        fetchImpl: async () =>
          Response.json({ status: "ok", registration: {} }),
        stdout: (line) => lines.push(line),
      },
    );

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("Action backend registered");
  });

  test("fails with a usage error when the Tidegate API connection is missing", async () => {
    const errors: string[] = [];
    const exitCode = await runCreateTidegate(
      ["register", "--catalog-url", config.catalogUrl, "--actions-url", config.actionsUrl],
      {
        env: {},
        fetchImpl: async () => {
          throw new Error("must not fetch");
        },
        stderr: (line) => errors.push(line),
      },
    );

    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain("register needs the Tidegate API");
  });
});
