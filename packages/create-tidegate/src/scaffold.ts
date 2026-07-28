import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ENV_BRIDGE_SECRET_KEY,
  actionsModuleTemplate,
  actionsRouteTemplate,
  catalogRouteTemplate,
  detectScaffoldLayout,
  envBlockTemplate,
} from "./templates.ts";

export type ScaffoldFailureReason =
  | "package_json_missing"
  | "package_json_invalid"
  | "next_dependency_missing"
  | "app_router_missing"
  | "env_file_invalid"
  | "conflicts";

export type ScaffoldResult =
  | {
      ok: true;
      catalogId: string;
      createdFiles: string[];
      envFile: {
        relativePath: string;
        created: boolean;
        addedKeys: string[];
        preservedKeys: string[];
        emptySecret: boolean;
        gitignored: boolean;
      };
      packageManager: PackageManager;
      missingRuntimeDeps: string[];
    }
  | {
      ok: false;
      reason: ScaffoldFailureReason;
      message: string;
      conflicts?: string[];
    };

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export type ScaffoldOptions = {
  cwd: string;
  catalogId?: string;
  generateSecret?: () => string;
};

// Runtime imports of the scaffolded files; they must live in the project's
// production dependencies, not devDependencies.
const RUNTIME_DEPS = ["@tidegate/sdk", "zod"] as const;

export function generateBridgeSecret(): string {
  return `tgs_${randomBytes(32).toString("base64url")}`;
}

const ENV_FILE = ".env.local";

export async function scaffoldTidegateIntegration({
  cwd,
  catalogId,
  generateSecret = generateBridgeSecret,
}: ScaffoldOptions): Promise<ScaffoldResult> {
  const packageJsonPath = join(cwd, "package.json");

  if (!existsSync(packageJsonPath)) {
    return {
      ok: false,
      reason: "package_json_missing",
      message:
        "No package.json found. Run create-tidegate inside an existing Next.js App Router project (or pass --dir).",
    };
  }

  let packageJson: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("package.json must contain a JSON object.");
    }

    packageJson = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      reason: "package_json_invalid",
      message: `Could not parse package.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const dependencies = readRecord(packageJson.dependencies);
  const devDependencies = readRecord(packageJson.devDependencies);

  if (!("next" in dependencies) && !("next" in devDependencies)) {
    return {
      ok: false,
      reason: "next_dependency_missing",
      message:
        "This project does not depend on next. create-tidegate currently scaffolds Next.js App Router projects only.",
    };
  }

  const hasRootApp = existsSync(join(cwd, "app"));
  const hasSrcApp = existsSync(join(cwd, "src", "app"));
  const hasSrcDir = existsSync(join(cwd, "src"));
  const layout = detectScaffoldLayout(!hasRootApp && (hasSrcApp || hasSrcDir));

  const hasPagesRouter =
    existsSync(join(cwd, "pages")) || existsSync(join(cwd, "src", "pages"));

  if (hasPagesRouter && !hasRootApp && !hasSrcApp) {
    return {
      ok: false,
      reason: "app_router_missing",
      message:
        "This looks like a Pages Router project. create-tidegate requires the App Router (an app/ or src/app/ directory).",
    };
  }

  const envPath = join(cwd, ENV_FILE);

  if (existsSync(envPath) && !statSync(envPath).isFile()) {
    return {
      ok: false,
      reason: "env_file_invalid",
      message: `${ENV_FILE} exists but is not a regular file. Move it aside, then run create-tidegate again.`,
    };
  }

  const resolvedCatalogId = catalogId ?? defaultCatalogId(packageJson, cwd);

  const files: { relativePath: string; contents: string }[] = [
    {
      relativePath: join(layout.actionsDir, "actions.ts"),
      contents: actionsModuleTemplate(),
    },
    {
      relativePath: join(layout.appDir, "api", "actions", "route.ts"),
      contents: actionsRouteTemplate(),
    },
    {
      relativePath: join(layout.appDir, "api", "action-catalog", "route.ts"),
      contents: catalogRouteTemplate(resolvedCatalogId),
    },
  ];

  const conflicts = files
    .map((file) => file.relativePath)
    .filter((relativePath) => existsSync(join(cwd, relativePath)));

  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: "conflicts",
      conflicts,
      message: `Refusing to overwrite existing files:\n${conflicts
        .map((conflict) => `  ${conflict}`)
        .join("\n")}\nRemove or move them, then run create-tidegate again.`,
    };
  }

  for (const file of files) {
    const absolutePath = join(cwd, file.relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.contents, "utf8");
  }

  const envFile = await upsertEnvFile({ cwd, envPath, generateSecret });

  return {
    ok: true,
    catalogId: resolvedCatalogId,
    createdFiles: files.map((file) => file.relativePath),
    envFile: { ...envFile, gitignored: isEnvFileGitignored(cwd) },
    packageManager: detectPackageManager(cwd),
    missingRuntimeDeps: RUNTIME_DEPS.filter((dep) => !(dep in dependencies)),
  };
}

async function upsertEnvFile({
  cwd,
  envPath,
  generateSecret,
}: {
  cwd: string;
  envPath: string;
  generateSecret: () => string;
}): Promise<{
  relativePath: string;
  created: boolean;
  addedKeys: string[];
  preservedKeys: string[];
  emptySecret: boolean;
}> {
  if (!existsSync(envPath)) {
    // The file holds a live credential: restrict it to the owner.
    await writeFile(envPath, envBlockTemplate(generateSecret()), {
      encoding: "utf8",
      mode: 0o600,
    });

    return {
      relativePath: ENV_FILE,
      created: true,
      addedKeys: [ENV_BRIDGE_SECRET_KEY],
      preservedKeys: [],
      emptySecret: false,
    };
  }

  const existing = await readFile(envPath, "utf8");
  const secretValue = envFileKeyValue(existing, ENV_BRIDGE_SECRET_KEY);

  if (secretValue !== undefined) {
    // The key exists (possibly empty). Never append a duplicate definition:
    // dotenv precedence would silently shadow the value already registered
    // in the Tidegate console.
    return {
      relativePath: ENV_FILE,
      created: false,
      addedKeys: [],
      preservedKeys: [ENV_BRIDGE_SECRET_KEY],
      emptySecret: secretValue.trim().length === 0,
    };
  }

  const separator = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  await writeFile(
    envPath,
    `${existing}${separator}\n${envBlockTemplate(generateSecret())}`,
    "utf8",
  );

  return {
    relativePath: ENV_FILE,
    created: false,
    addedKeys: [ENV_BRIDGE_SECRET_KEY],
    preservedKeys: [],
    emptySecret: false,
  };
}

// Matches both `KEY=value` and dotenv's `export KEY=value` form; returns the
// raw value when the key is defined, undefined otherwise.
function envFileKeyValue(contents: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`);

  for (const line of contents.split("\n")) {
    const match = pattern.exec(line);

    if (match !== null) {
      return match[1] ?? "";
    }
  }

  return undefined;
}

function isEnvFileGitignored(cwd: string): boolean {
  const gitignorePath = join(cwd, ".gitignore");

  if (!existsSync(gitignorePath)) {
    return false;
  }

  let contents: string;

  try {
    contents = readFileSync(gitignorePath, "utf8");
  } catch {
    return false;
  }

  const patterns = contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  // Heuristic over the common dotenv ignore spellings; a bespoke glob engine
  // is not worth it for a warning.
  return patterns.some((pattern) =>
    [".env.local", ".env*", ".env.*", "*.local", ".env*.local"].includes(
      pattern.replace(/^\//, ""),
    ),
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function defaultCatalogId(
  packageJson: Record<string, unknown>,
  cwd: string,
): string {
  const name = packageJson.name;

  if (typeof name === "string" && name.length > 0) {
    // Strip a scope: "@acme/backend" -> "backend".
    const unscoped = name.startsWith("@") ? name.split("/")[1] : name;

    if (unscoped !== undefined && unscoped.length > 0) {
      return unscoped;
    }
  }

  const dirName = cwd.split("/").filter(Boolean).at(-1);

  return dirName !== undefined && dirName.length > 0 ? dirName : "backend";
}

function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) {
    return "bun";
  }

  if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (existsSync(join(cwd, "yarn.lock"))) {
    return "yarn";
  }

  return "npm";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const ENV_FILE_RELATIVE_PATH = ENV_FILE;
