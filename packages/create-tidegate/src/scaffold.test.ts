import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { scaffoldTidegateIntegration } from "./scaffold.ts";

const GOLDEN_DIR = join(import.meta.dir, "..", "test-fixtures", "golden");
const GOLDEN_SECRET = "tgs_golden_fixture_secret_do_not_use";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

async function createProject({
  dependencies = { next: "16.2.6" },
  layoutDirs = ["app"],
  name = "acme-backend",
}: {
  dependencies?: Record<string, string>;
  layoutDirs?: string[];
  name?: string;
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "create-tidegate-scaffold-"));
  tempDirs.push(dir);

  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name, private: true, dependencies }, null, 2)}\n`,
  );

  for (const layoutDir of layoutDirs) {
    await mkdir(join(dir, layoutDir), { recursive: true });
  }

  return dir;
}

describe("scaffoldTidegateIntegration", () => {
  test("scaffolds the golden output byte for byte", async () => {
    const dir = await createProject();

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.createdFiles.sort()).toEqual([
      "app/api/action-catalog/route.ts",
      "app/api/actions/route.ts",
      "tidegate/actions.ts",
    ]);

    for (const file of result.createdFiles) {
      expect(await readFile(join(dir, file), "utf8")).toBe(
        await readFile(join(GOLDEN_DIR, file), "utf8"),
      );
    }

    expect(await readFile(join(dir, ".env.local"), "utf8")).toBe(
      await readFile(join(GOLDEN_DIR, "env.local"), "utf8"),
    );
  });

  test("uses the src/ layout when the project has src/app", async () => {
    const dir = await createProject({ layoutDirs: ["src/app"] });

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.createdFiles.sort()).toEqual([
      "src/app/api/action-catalog/route.ts",
      "src/app/api/actions/route.ts",
      "src/tidegate/actions.ts",
    ]);

    // The route -> actions relative import has the same depth in both layouts.
    expect(
      await readFile(join(dir, "src/app/api/actions/route.ts"), "utf8"),
    ).toContain('from "../../../tidegate/actions"');
  });

  test("derives the catalog id from a scoped package name", async () => {
    const dir = await createProject({ name: "@acme/backend" });

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.catalogId).toBe("backend");
    expect(
      await readFile(join(dir, "app/api/action-catalog/route.ts"), "utf8"),
    ).toContain('catalogId: "backend"');
  });

  test("honors an explicit catalog id", async () => {
    const dir = await createProject();

    const result = await scaffoldTidegateIntegration({
      catalogId: "acme-books",
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(result.ok && result.catalogId === "acme-books").toBe(true);
  });

  test("refuses to overwrite existing files and writes nothing", async () => {
    const dir = await createProject();
    const existingRoute = join(dir, "app/api/actions/route.ts");
    await mkdir(dirname(existingRoute), { recursive: true });
    await writeFile(existingRoute, "// customer-owned\n");

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.reason).toBe("conflicts");
    expect(result.conflicts).toEqual(["app/api/actions/route.ts"]);
    expect(await readFile(existingRoute, "utf8")).toBe("// customer-owned\n");
    expect(existsSync(join(dir, "tidegate/actions.ts"))).toBe(false);
    expect(existsSync(join(dir, ".env.local"))).toBe(false);
  });

  test("rejects a project without a next dependency", async () => {
    const dir = await createProject({ dependencies: { express: "5.0.0" } });

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(!result.ok && result.reason === "next_dependency_missing").toBe(true);
  });

  test("rejects a Pages Router project", async () => {
    const dir = await createProject({ layoutDirs: ["pages"] });

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(!result.ok && result.reason === "app_router_missing").toBe(true);
  });

  test("rejects a Pages Router project using the src/ layout", async () => {
    const dir = await createProject({ layoutDirs: ["src/pages"] });

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(!result.ok && result.reason === "app_router_missing").toBe(true);
  });

  test("rejects an .env.local that is not a regular file", async () => {
    const dir = await createProject();
    await mkdir(join(dir, ".env.local"));

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(!result.ok && result.reason === "env_file_invalid").toBe(true);
    expect(existsSync(join(dir, "tidegate/actions.ts"))).toBe(false);
  });

  test("preserves an existing bridge secret in .env.local", async () => {
    const dir = await createProject();
    await writeFile(
      join(dir, ".env.local"),
      "TIDEGATE_ACTION_BRIDGE_SECRET=keep_me\nOTHER=1\n",
    );

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.envFile.addedKeys).toEqual([]);
    expect(result.envFile.preservedKeys).toEqual([
      "TIDEGATE_ACTION_BRIDGE_SECRET",
    ]);
    expect(result.envFile.emptySecret).toBe(false);
    expect(await readFile(join(dir, ".env.local"), "utf8")).toBe(
      "TIDEGATE_ACTION_BRIDGE_SECRET=keep_me\nOTHER=1\n",
    );
  });

  test("recognizes the dotenv export form and does not append a shadowing duplicate", async () => {
    const dir = await createProject();
    await writeFile(
      join(dir, ".env.local"),
      "export TIDEGATE_ACTION_BRIDGE_SECRET=keep_me\n",
    );

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.envFile.addedKeys).toEqual([]);
    expect(await readFile(join(dir, ".env.local"), "utf8")).not.toContain(
      GOLDEN_SECRET,
    );
  });

  test("flags an empty bridge secret instead of silently accepting it", async () => {
    const dir = await createProject();
    await writeFile(join(dir, ".env.local"), "TIDEGATE_ACTION_BRIDGE_SECRET=\n");

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.envFile.emptySecret).toBe(true);
    expect(result.envFile.addedKeys).toEqual([]);
  });

  test("appends the tidegate block to an unrelated .env.local", async () => {
    const dir = await createProject();
    await writeFile(join(dir, ".env.local"), "DATABASE_URL=postgres://x\n");

    const result = await scaffoldTidegateIntegration({
      cwd: dir,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(result.ok).toBe(true);

    const contents = await readFile(join(dir, ".env.local"), "utf8");
    expect(contents).toContain("DATABASE_URL=postgres://x");
    expect(contents).toContain(
      `TIDEGATE_ACTION_BRIDGE_SECRET=${GOLDEN_SECRET}`,
    );
  });

  test("reports missing runtime dependencies, counting only production deps", async () => {
    const withBoth = await createProject({
      dependencies: {
        next: "16.2.6",
        "@tidegate/sdk": "0.2.0",
        zod: "4.4.3",
      },
    });
    const withSdkAsDevDep = await createProject();
    await writeFile(
      join(withSdkAsDevDep, "package.json"),
      `${JSON.stringify(
        {
          name: "acme-backend",
          dependencies: { next: "16.2.6" },
          devDependencies: { "@tidegate/sdk": "0.2.0", zod: "4.4.3" },
        },
        null,
        2,
      )}\n`,
    );

    const complete = await scaffoldTidegateIntegration({
      cwd: withBoth,
      generateSecret: () => GOLDEN_SECRET,
    });
    const devOnly = await scaffoldTidegateIntegration({
      cwd: withSdkAsDevDep,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(complete.ok && complete.missingRuntimeDeps).toEqual([]);
    expect(devOnly.ok && devOnly.missingRuntimeDeps).toEqual([
      "@tidegate/sdk",
      "zod",
    ]);
  });

  test("reports whether .env.local is gitignored", async () => {
    const ignored = await createProject();
    await writeFile(join(ignored, ".gitignore"), "node_modules\n.env*\n");
    const notIgnored = await createProject();
    await writeFile(join(notIgnored, ".gitignore"), "node_modules\n");

    const ignoredResult = await scaffoldTidegateIntegration({
      cwd: ignored,
      generateSecret: () => GOLDEN_SECRET,
    });
    const notIgnoredResult = await scaffoldTidegateIntegration({
      cwd: notIgnored,
      generateSecret: () => GOLDEN_SECRET,
    });

    expect(ignoredResult.ok && ignoredResult.envFile.gitignored).toBe(true);
    expect(notIgnoredResult.ok && notIgnoredResult.envFile.gitignored).toBe(
      false,
    );
  });
});
