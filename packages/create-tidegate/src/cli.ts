import { resolve } from "node:path";

import {
  DEFAULT_SMOKE_INTERACTION_ID,
  SMOKE_INTERACTION_ID_PREFIX,
  runTidegateDoctor,
  type DoctorConfig,
  type DoctorFetch,
  type DoctorReport,
  type DoctorStage,
  type DoctorVisibility,
} from "./doctor.ts";
import { registerTidegateActionBackend } from "./register.ts";
import {
  generateBridgeSecret,
  scaffoldTidegateIntegration,
  type ScaffoldResult,
} from "./scaffold.ts";

export type CreateTidegateCliOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: DoctorFetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  generateSecret?: () => string;
};

class CreateTidegateCliUsageError extends Error {
  override name = "CreateTidegateCliUsageError";
}

export async function runCreateTidegate(
  argv: string[],
  {
    cwd = process.cwd(),
    env = process.env,
    fetchImpl = globalThis.fetch,
    stdout = (line) => console.log(line),
    stderr = (line) => console.error(line),
    generateSecret = generateBridgeSecret,
  }: CreateTidegateCliOptions = {},
): Promise<number> {
  try {
    const [command] = argv;

    if (command === "--help" || command === "help") {
      stdout(usage());
      return 0;
    }

    // `init` is optional in the advertised usage: a bare invocation or one
    // that starts directly with options scaffolds.
    if (command === undefined || command === "init" || command.startsWith("--")) {
      const args = command === "init" ? argv.slice(1) : argv;

      return await runInit(args, { cwd, generateSecret, stderr, stdout });
    }

    if (command === "doctor") {
      return await runDoctor(argv.slice(1), { env, fetchImpl, stdout });
    }

    if (command === "register") {
      return await runRegister(argv.slice(1), { env, fetchImpl, stdout });
    }

    throw new CreateTidegateCliUsageError(usage());
  } catch (error) {
    if (error instanceof CreateTidegateCliUsageError) {
      stderr(error.message);
      return 2;
    }

    stderr(
      JSON.stringify(
        {
          ok: false,
          error: {
            code: "cli_error",
            message: error instanceof Error ? error.message : "CLI command failed.",
          },
        },
        null,
        2,
      ),
    );

    return 1;
  }
}

const INIT_VALUE_OPTIONS = new Set(["catalog-id", "dir"]);
const INIT_BOOLEAN_OPTIONS = new Set(["help"]);

async function runInit(
  args: string[],
  {
    cwd,
    generateSecret,
    stderr,
    stdout,
  }: {
    cwd: string;
    generateSecret: () => string;
    stderr: (line: string) => void;
    stdout: (line: string) => void;
  },
): Promise<number> {
  const parsed = parseOptions(args, {
    booleanOptions: INIT_BOOLEAN_OPTIONS,
    valueOptions: INIT_VALUE_OPTIONS,
  });

  if (hasOption(parsed, "help")) {
    stdout(initUsage());
    return 0;
  }

  if (parsed.positionals.length > 0) {
    throw new CreateTidegateCliUsageError(initUsage());
  }

  const catalogId = option(parsed, "catalog-id")?.trim();

  if (catalogId !== undefined && catalogId.length === 0) {
    throw new CreateTidegateCliUsageError(
      "--catalog-id cannot be empty: it is the identifier your catalog manifest advertises to Tidegate.",
    );
  }

  const dirOption = option(parsed, "dir");
  const targetDir = dirOption === undefined ? cwd : resolve(cwd, dirOption);

  const result = await scaffoldTidegateIntegration({
    catalogId,
    cwd: targetDir,
    generateSecret,
  });

  if (!result.ok) {
    stderr(result.message);
    return 1;
  }

  printInitSummary(result, stdout);

  return 0;
}

const DOCTOR_VALUE_OPTIONS = new Set([
  "actions-url",
  "api-base-url",
  "api-key",
  "catalog-url",
  "interaction-id",
  "secret",
  "token",
  "visibility",
]);
const DOCTOR_BOOLEAN_OPTIONS = new Set(["e2e", "help", "json"]);
const DOCTOR_VISIBILITIES: readonly DoctorVisibility[] = [
  "user",
  "tenant",
  "organization",
  "app",
];

const REGISTER_VALUE_OPTIONS = new Set([
  "actions-url",
  "api-base-url",
  "api-key",
  "catalog-url",
  "secret",
  "token",
]);
const REGISTER_BOOLEAN_OPTIONS = new Set(["help", "json"]);

async function runRegister(
  args: string[],
  {
    env,
    fetchImpl,
    stdout,
  }: {
    env: Record<string, string | undefined>;
    fetchImpl: DoctorFetch;
    stdout: (line: string) => void;
  },
): Promise<number> {
  const parsed = parseOptions(args, {
    booleanOptions: REGISTER_BOOLEAN_OPTIONS,
    valueOptions: REGISTER_VALUE_OPTIONS,
  });

  if (hasOption(parsed, "help")) {
    stdout(registerUsage());
    return 0;
  }

  if (parsed.positionals.length > 0) {
    throw new CreateTidegateCliUsageError(registerUsage());
  }

  const catalogUrl =
    option(parsed, "catalog-url") ?? env.TIDEGATE_ACTION_CATALOG_URL;
  const actionsUrl =
    option(parsed, "actions-url") ?? env.TIDEGATE_ACTION_ENDPOINT_URL;
  const apiBaseUrl =
    option(parsed, "api-base-url") ??
    env.TIDEGATE_INTERACTIONS_API_BASE_URL ??
    env.TIDEGATE_API_BASE_URL;
  const token =
    option(parsed, "token") ??
    option(parsed, "api-key") ??
    env.TIDEGATE_API_TOKEN ??
    env.TIDEGATE_API_KEY;

  if (catalogUrl === undefined || actionsUrl === undefined) {
    throw new CreateTidegateCliUsageError(
      `register needs your backend URLs: pass --catalog-url and --actions-url (or set TIDEGATE_ACTION_CATALOG_URL and TIDEGATE_ACTION_ENDPOINT_URL).\n\n${registerUsage()}`,
    );
  }

  if (apiBaseUrl === undefined || token === undefined) {
    throw new CreateTidegateCliUsageError(
      `register needs the Tidegate API: pass --api-base-url and --token (or --api-key), or set TIDEGATE_API_BASE_URL (or TIDEGATE_INTERACTIONS_API_BASE_URL) and TIDEGATE_API_TOKEN (or TIDEGATE_API_KEY).\n\n${registerUsage()}`,
    );
  }

  const report = await registerTidegateActionBackend(
    {
      actionsUrl,
      apiBaseUrl,
      bridgeSecret: option(parsed, "secret") ?? env.TIDEGATE_ACTION_BRIDGE_SECRET,
      catalogUrl,
      token,
    },
    { fetchImpl },
  );

  if (hasOption(parsed, "json")) {
    stdout(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    stdout(`Action backend registered with Tidegate (PUT ${report.url}).`);
    stdout(`  catalog: ${catalogUrl}`);
    stdout(`  actions: ${actionsUrl}`);
  } else {
    stdout(
      `Action backend registration failed (${report.error?.code}): ${report.error?.message}`,
    );
  }

  return report.ok ? 0 : 1;
}

async function runDoctor(
  args: string[],
  {
    env,
    fetchImpl,
    stdout,
  }: {
    env: Record<string, string | undefined>;
    fetchImpl: DoctorFetch;
    stdout: (line: string) => void;
  },
): Promise<number> {
  const parsed = parseOptions(args, {
    booleanOptions: DOCTOR_BOOLEAN_OPTIONS,
    valueOptions: DOCTOR_VALUE_OPTIONS,
  });

  if (hasOption(parsed, "help")) {
    stdout(doctorUsage());
    return 0;
  }

  if (parsed.positionals.length > 0) {
    throw new CreateTidegateCliUsageError(doctorUsage());
  }

  const catalogUrl =
    option(parsed, "catalog-url") ?? env.TIDEGATE_ACTION_CATALOG_URL;

  if (catalogUrl === undefined) {
    throw new CreateTidegateCliUsageError(
      `Missing catalog URL. Pass --catalog-url or set TIDEGATE_ACTION_CATALOG_URL.\n\n${doctorUsage()}`,
    );
  }

  const config: DoctorConfig = {
    actionsUrl: option(parsed, "actions-url") ?? env.TIDEGATE_ACTION_ENDPOINT_URL,
    bridgeSecret: option(parsed, "secret") ?? env.TIDEGATE_ACTION_BRIDGE_SECRET,
    catalogUrl,
  };

  if (hasOption(parsed, "e2e")) {
    const apiBaseUrl =
      option(parsed, "api-base-url") ??
      env.TIDEGATE_INTERACTIONS_API_BASE_URL ??
      env.TIDEGATE_API_BASE_URL;
    const token =
      option(parsed, "token") ??
      option(parsed, "api-key") ??
      env.TIDEGATE_API_TOKEN ??
      env.TIDEGATE_API_KEY;

    if (apiBaseUrl === undefined || token === undefined) {
      throw new CreateTidegateCliUsageError(
        `--e2e needs the Tidegate API: pass --api-base-url and --token (or --api-key), or set TIDEGATE_API_BASE_URL (or TIDEGATE_INTERACTIONS_API_BASE_URL) and TIDEGATE_API_TOKEN (or TIDEGATE_API_KEY).\n\n${doctorUsage()}`,
      );
    }

    const visibility = option(parsed, "visibility") ?? "tenant";

    if (!isDoctorVisibility(visibility)) {
      throw new CreateTidegateCliUsageError(
        `Invalid --visibility "${visibility}". Use one of: ${DOCTOR_VISIBILITIES.join(", ")}.`,
      );
    }

    const interactionId =
      option(parsed, "interaction-id") ?? DEFAULT_SMOKE_INTERACTION_ID;

    if (!interactionId.startsWith(SMOKE_INTERACTION_ID_PREFIX)) {
      throw new CreateTidegateCliUsageError(
        `--interaction-id must stay in the diagnostic namespace ("${SMOKE_INTERACTION_ID_PREFIX}*"); got "${interactionId}". Doctor archives this interaction after the check and must never touch a real one.`,
      );
    }

    config.e2e = { apiBaseUrl, interactionId, token, visibility };
  }

  const report = await runTidegateDoctor(config, { fetchImpl });

  if (hasOption(parsed, "json")) {
    stdout(JSON.stringify(report, null, 2));
  } else {
    printDoctorReport(report, stdout);
  }

  return report.ok ? 0 : 1;
}

function printInitSummary(
  result: Extract<ScaffoldResult, { ok: true }>,
  stdout: (line: string) => void,
): void {
  const lines: string[] = [];

  lines.push(
    `Tidegate integration scaffolded (catalog id: ${result.catalogId} — what your manifest advertises to Tidegate).`,
  );
  lines.push("");
  lines.push("Created:");

  for (const file of result.createdFiles) {
    lines.push(`  ${file}`);
  }

  lines.push("");
  lines.push("Environment:");

  if (result.envFile.created) {
    lines.push(
      `  ${result.envFile.relativePath} created with a generated TIDEGATE_ACTION_BRIDGE_SECRET (file mode 600).`,
    );
  } else if (result.envFile.addedKeys.length > 0) {
    lines.push(
      `  ${result.envFile.relativePath}: appended a generated TIDEGATE_ACTION_BRIDGE_SECRET.`,
    );
  } else if (result.envFile.emptySecret) {
    lines.push(
      `  ${result.envFile.relativePath}: TIDEGATE_ACTION_BRIDGE_SECRET is present but EMPTY — set a real secret before registering the backend.`,
    );
  } else {
    lines.push(
      `  ${result.envFile.relativePath}: TIDEGATE_ACTION_BRIDGE_SECRET already set, left untouched.`,
    );
  }

  if (!result.envFile.gitignored) {
    lines.push(
      `  Warning: ${result.envFile.relativePath} does not appear to be covered by .gitignore — add it before committing.`,
    );
  }

  lines.push("");
  lines.push("Next steps:");

  let step = 1;

  if (result.missingRuntimeDeps.length > 0) {
    lines.push(
      `  ${step}. Install the runtime dependencies: ${result.packageManager} add ${result.missingRuntimeDeps.join(" ")}`,
    );
    step += 1;
  }

  lines.push(
    `  ${step}. Register this backend in the Tidegate console: catalog URL ` +
      `<your-base-url>/api/action-catalog, action endpoint <your-base-url>/api/actions, ` +
      `and the TIDEGATE_ACTION_BRIDGE_SECRET value from ${result.envFile.relativePath}.`,
  );
  step += 1;
  lines.push(
    `  ${step}. Verify the wiring (doctor reads its own environment, not ${result.envFile.relativePath}):`,
  );
  lines.push(
    `     bunx create-tidegate doctor --catalog-url <your-base-url>/api/action-catalog \\`,
  );
  lines.push(
    `       --actions-url <your-base-url>/api/actions --secret <TIDEGATE_ACTION_BRIDGE_SECRET from ${result.envFile.relativePath}>`,
  );
  step += 1;
  lines.push(
    `  ${step}. Replace the example.saveNote action with your first real domain operation (keep diagnostics.ping).`,
  );
  step += 1;
  lines.push(
    `  ${step}. Ask the Tidegate agent for your first interaction — interactions are generated for you, not written by hand.`,
  );

  for (const line of lines) {
    stdout(line);
  }
}

const STAGE_MARKERS: Record<DoctorStage["status"], string> = {
  fail: "✗",
  pass: "✓",
  skip: "-",
  warn: "!",
};

function printDoctorReport(
  report: DoctorReport,
  stdout: (line: string) => void,
): void {
  for (const stage of report.stages) {
    stdout(`${STAGE_MARKERS[stage.status]} ${stage.title}`);

    if (stage.detail !== undefined) {
      stdout(`    ${sanitizeForTerminal(stage.detail)}`);
    }
  }

  const failed = report.stages.filter((stage) => stage.status === "fail");
  const skipped = report.stages.filter((stage) => stage.status === "skip");
  const warned = report.stages.filter((stage) => stage.status === "warn");

  stdout("");

  if (failed.length > 0) {
    stdout(
      `Tidegate wiring is broken at: ${failed.map((stage) => stage.title).join("; ")}.`,
    );

    return;
  }

  if (skipped.length > 0 || warned.length > 0) {
    const parts: string[] = [];

    if (skipped.length > 0) {
      parts.push(`skipped: ${skipped.map((stage) => stage.title).join("; ")}`);
    }

    if (warned.length > 0) {
      parts.push(`warnings: ${warned.map((stage) => stage.title).join("; ")}`);
    }

    stdout(`No stage failed, but the wiring is not fully verified — ${parts.join(" — ")}.`);

    return;
  }

  stdout("Tidegate wiring looks healthy.");
}

// Stage details embed remote-controlled strings (error messages, action ids,
// zod issues). Strip control characters so a hostile backend cannot inject
// terminal escape sequences into the report.
function sanitizeForTerminal(value: string): string {
  let sanitized = "";

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    sanitized += (code < 0x20 && char !== "\n" && char !== "\t") || code === 0x7f ? " " : char;
  }

  return sanitized;
}

type ParsedOptions = {
  options: Map<string, string[]>;
  positionals: string[];
};

function parseOptions(
  args: string[],
  {
    booleanOptions,
    valueOptions,
  }: {
    booleanOptions: Set<string>;
    valueOptions: Set<string>;
  },
): ParsedOptions {
  const options = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    // Split on the FIRST "=" only: values may themselves contain "=".
    const body = arg.slice(2);
    const equalsIndex = body.indexOf("=");
    const rawName = equalsIndex === -1 ? body : body.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : body.slice(equalsIndex + 1);
    const name = rawName.replaceAll("_", "-");

    if (booleanOptions.has(name)) {
      if (inlineValue !== undefined) {
        throw new CreateTidegateCliUsageError(`--${name} takes no value.`);
      }

      addOption(options, name, "true");
      continue;
    }

    if (!valueOptions.has(name)) {
      throw new CreateTidegateCliUsageError(`Unknown option --${name}.`);
    }

    if (inlineValue !== undefined) {
      addOption(options, name, inlineValue);
      continue;
    }

    const value = args[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new CreateTidegateCliUsageError(`Missing value for --${name}.`);
    }

    addOption(options, name, value);
    index += 1;
  }

  return { options, positionals };
}

function addOption(
  options: Map<string, string[]>,
  name: string,
  value: string,
): void {
  const existing = options.get(name);

  if (existing === undefined) {
    options.set(name, [value]);
    return;
  }

  existing.push(value);
}

function option(parsed: ParsedOptions, name: string): string | undefined {
  return parsed.options.get(name)?.at(-1);
}

function hasOption(parsed: ParsedOptions, name: string): boolean {
  return parsed.options.has(name);
}

function isDoctorVisibility(value: string): value is DoctorVisibility {
  return (DOCTOR_VISIBILITIES as readonly string[]).includes(value);
}

function usage(): string {
  return [
    "create-tidegate — scaffold a Tidegate customer backend integration and verify its wiring.",
    "Non-interactive: no prompts, never overwrites existing files. Safe to run from scripts and AI agents.",
    "",
    "Usage:",
    "  create-tidegate [init] [--dir <path>] [--catalog-id <id>]",
    "  create-tidegate doctor [--catalog-url <url>] [--actions-url <url>] [--secret <value>] [--e2e] [--api-base-url <url>] [--token <token>] [--json]",
    "  create-tidegate register --catalog-url <url> --actions-url <url> [--secret <value>] --api-base-url <url> --token <token> [--json]",
    "  create-tidegate init --help | doctor --help | register --help    Full per-command options.",
    "",
    "Commands:",
    "  init (default when the first argument is an option or absent)",
    "    Scaffolds into an existing Next.js App Router project: a typed action",
    "    catalog (tidegate/actions.ts), the protected executable bridge route",
    "    (app/api/actions/route.ts), the public non-executable manifest route",
    "    (app/api/action-catalog/route.ts), and .env.local with a generated",
    "    TIDEGATE_ACTION_BRIDGE_SECRET. Uses the src/ layout when the project has one.",
    "  doctor",
    "    Verifies the wiring layer by layer and stops at the first broken one.",
    "    With --e2e it also publishes, invokes, and archives an ephemeral diagnostic",
    "    interaction (ix.diagnostics.*) — a smoke test of the system, not an",
    "    authoring example: real interactions are generated by the Tidegate agent.",
    "  register",
    "    Registers (or updates) this backend as the per-organization action backend",
    "    of the API key's organization on Tidegate — one call, like a webhook",
    "    registration. Uses the same connection flags as doctor. The API key needs",
    "    the tidegate:action-backend:manage scope.",
    "",
    "Exit codes: 0 success / no stage failed; 1 operation or stage failed; 2 usage error.",
    "Machine-readable output: `doctor --json` prints the full stage report as JSON on stdout.",
  ].join("\n");
}

function initUsage(): string {
  return [
    "Usage:",
    "  create-tidegate init [--dir <path>] [--catalog-id <id>]",
    "  (`init` may be omitted: `create-tidegate [options]` runs init.)",
    "",
    "Options (values may be inline: --catalog-id=<id>):",
    "  --dir <path>       Target project directory. Default: current directory.",
    "  --catalog-id <id>  Identifier the catalog manifest advertises to Tidegate.",
    "                     Default: the project's unscoped package name, falling",
    "                     back to the directory name.",
    "  --help             Print this help and exit 0.",
    "",
    "Behavior contract (safe for automation):",
    "  - Non-interactive; no prompts, no network access.",
    "  - Requires an existing Next.js project (package.json with a `next`",
    "    dependency). Pages-only projects are rejected; App Router directories",
    "    are created when absent, and the src/ layout is used when present.",
    "  - Never overwrites: on any conflict it lists the conflicting files, writes",
    "    nothing, and exits 1. .env.local is appended; existing keys are preserved.",
    "  - stdout: summary of created files and next steps. stderr: failure reason.",
    "",
    "Exit codes: 0 scaffolded; 1 scaffold failed (reason on stderr); 2 usage error.",
    "After init: install the runtime deps if the summary asks for it, start the dev",
    "server, then run `create-tidegate doctor` to verify the wiring.",
  ].join("\n");
}

function registerUsage(): string {
  return [
    "Usage:",
    "  create-tidegate register --catalog-url <url> --actions-url <url> [--secret <value>]",
    "                           --api-base-url <url> --token <token> | --api-key <key>",
    "                           [--json]",
    "",
    "Registers this backend as the per-organization action backend of the API",
    "key's organization on Tidegate (PUT <api-base-url>/action-backend).",
    "Idempotent: re-running updates the registration in place. Omitting --secret",
    "on an update keeps the secret already registered; the first registration",
    "requires it. Tidegate never echoes the secret back.",
    "",
    "Options (connection options fall back to the environment variable in",
    "parentheses):",
    "  --catalog-url <url>    GET endpoint of the action-catalog manifest. Required",
    "                         (TIDEGATE_ACTION_CATALOG_URL).",
    "  --actions-url <url>    POST endpoint of the action bridge. Required",
    "                         (TIDEGATE_ACTION_ENDPOINT_URL).",
    "  --secret <value>       Bridge secret Tidegate will use to call the bridge",
    "                         (TIDEGATE_ACTION_BRIDGE_SECRET). Required on first registration.",
    "  --api-base-url <url>   Tidegate API base URL. Required",
    "                         (TIDEGATE_INTERACTIONS_API_BASE_URL or TIDEGATE_API_BASE_URL).",
    "  --token <token>        Tidegate ORG API key with the tidegate:action-backend:manage",
    "                         scope. Required (TIDEGATE_API_TOKEN or TIDEGATE_API_KEY).",
    "                         --api-key is an alias.",
    "  --json                 Print the registration report as JSON on stdout.",
    "  --help                 Print this help and exit 0.",
    "",
    "URLs must be https (http is accepted only for localhost, for local dev).",
    "Exit codes: 0 registered; 1 registration rejected or unreachable; 2 usage error.",
  ].join("\n");
}

function doctorUsage(): string {
  return [
    "Usage:",
    "  create-tidegate doctor [--catalog-url <url>] [--actions-url <url>] [--secret <value>]",
    "                         [--e2e] [--api-base-url <url>] [--token <token> | --api-key <key>]",
    "                         [--interaction-id <ix.diagnostics.*>] [--visibility user|tenant|organization|app]",
    "                         [--json]",
    "",
    "Options (connection options fall back to the environment variable in",
    "parentheses; doctor reads its own process environment — it does NOT load",
    "the project's .env.local):",
    "  --catalog-url <url>    GET endpoint of the action-catalog manifest. Required",
    "                         (TIDEGATE_ACTION_CATALOG_URL).",
    "  --actions-url <url>    POST endpoint of the action bridge",
    "                         (TIDEGATE_ACTION_ENDPOINT_URL). Omitted: bridge stages skip.",
    "  --secret <value>       Bridge secret used for the authenticated bridge checks",
    "                         (TIDEGATE_ACTION_BRIDGE_SECRET). Omitted: those stages skip.",
    "  --e2e                  Also publish, invoke, and archive an ephemeral diagnostic",
    "                         interaction through the Tidegate public API.",
    "  --api-base-url <url>   Tidegate API base URL, required with --e2e",
    "                         (TIDEGATE_INTERACTIONS_API_BASE_URL or TIDEGATE_API_BASE_URL).",
    "  --token <token>        Tidegate API credential, required with --e2e",
    "                         (TIDEGATE_API_TOKEN or TIDEGATE_API_KEY). --api-key is an alias.",
    "  --interaction-id <id>  --e2e only (ignored otherwise). Smoke interaction id;",
    "                         must start with \"ix.diagnostics.\". Default:",
    "                         ix.diagnostics.echo. Archived after the check.",
    "  --visibility <v>       --e2e only (ignored otherwise). Smoke interaction",
    "                         visibility: user|tenant|organization|app. Default: tenant.",
    "  --json                 Print the full report as JSON on stdout (recommended for",
    "                         agents/scripts): { ok: boolean, stages: [{ id, title,",
    "                         status: \"pass\"|\"fail\"|\"warn\"|\"skip\", detail? }] }.",
    "  --help                 Print this help and exit 0.",
    "",
    "Stages run in three layers:",
    "  catalog: catalog-fetch → catalog-schema → catalog-governance",
    "  bridge:  bridge-auth-reject → bridge-allowlist → bridge-execute",
    "           (read-only diagnostics.ping with tenant echo)",
    "  [--e2e]  e2e-publish → e2e-invoke → e2e-archive",
    "Fail-stop applies between layers: a failure skips the later layers, reported",
    "as aggregate \"bridge\"/\"e2e\" stages with status \"skip\". Within a layer the",
    "remaining probes still run. e2e-archive is always attempted once publish",
    "succeeded, even after an invoke failure.",
    "",
    "Exit codes: 0 no stage failed (warn/skip still mean \"not fully verified\");",
    "1 a stage failed; 2 usage error. Doctor performs no writes on your backend:",
    "the only action it executes is the read-only diagnostics.ping.",
  ].join("\n");
}
