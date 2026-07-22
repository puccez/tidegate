// Generates the publishable variant of a workspace package into dist-pkg/.
//
// The source package.json stays untouched (exports -> src, private: true as a
// guard against accidental publishes): this script emits JS + d.ts with tsc
// and writes into dist-pkg/ a transformed package.json (exports -> dist, no
// ./fixtures subpath, workspace:* resolved to the real version). Publish from
// the generated dir:
//
//   bun run build:pack            # inside the package
//   cd dist-pkg && npm pack       # or npm publish
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

type PackageJson = {
  name: string;
  version: string;
  description?: string;
  license?: string;
  dependencies?: Record<string, string>;
  exports?: Record<string, string>;
};

const packageDir = resolve(process.argv[2] ?? ".");
const workspaceRoot = resolve(packageDir, "../..");
const distPkgDir = join(packageDir, "dist-pkg");

const manifest = readManifest(packageDir);
if (!manifest.exports) {
  throw new Error(`${manifest.name}: no exports field in package.json`);
}
// The license comes from the source package.json and the LICENSE file must
// exist: no fallback — a public package without a license is not generated.
if (!manifest.license || manifest.license === "UNLICENSED") {
  throw new Error(
    `${manifest.name}: license field missing or UNLICENSED in package.json`,
  );
}
if (!existsSync(join(packageDir, "LICENSE"))) {
  throw new Error(`${manifest.name}: LICENSE file missing in the package`);
}

rmSync(distPkgDir, { recursive: true, force: true });

const tsc = spawnSync(
  "bunx",
  ["tsc", "-p", join(packageDir, "tsconfig.build.json")],
  { stdio: "inherit" },
);
if (tsc.status !== 0) {
  throw new Error(`${manifest.name}: tsc emit failed`);
}
mkdirSync(distPkgDir, { recursive: true });

// rewriteRelativeImportExtensions rewrites .ts -> .js only in the emitted JS;
// declarations keep the original specifier, which would not resolve in the
// tarball (only .js/.d.ts). Realign the d.ts files to the same .js specifier.
rewriteDeclarationExtensions(join(distPkgDir, "dist"));

const publishedExports: Record<string, { types: string; default: string }> =
  {};
for (const [subpath, target] of Object.entries(manifest.exports)) {
  // ./fixtures is workspace test support, not public API.
  if (subpath === "./fixtures") continue;
  if (typeof target !== "string" || !/^\.\/src\/.+\.ts$/.test(target)) {
    throw new Error(
      `${manifest.name}: export "${subpath}" -> ${JSON.stringify(target)} ` +
        'not supported: expected a "./src/**/*.ts" string specifier',
    );
  }
  const entry = target.slice("./src/".length, -".ts".length);
  publishedExports[subpath] = {
    types: `./dist/${entry}.d.ts`,
    default: `./dist/${entry}.js`,
  };
}
const rootExport = publishedExports["."];
if (!rootExport) {
  throw new Error(`${manifest.name}: missing the "." export in package.json`);
}

const dependencies: Record<string, string> = {};
for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
  dependencies[dep] = range.startsWith("workspace:")
    ? resolveWorkspaceVersion(dep)
    : range;
}

const published = {
  name: manifest.name,
  version: manifest.version,
  description: manifest.description ?? "",
  type: "module",
  license: manifest.license,
  repository: {
    type: "git",
    url: "git+https://github.com/puccez/tidegate.git",
    directory: `packages/${basename(packageDir)}`,
  },
  sideEffects: false,
  // Top-level main/types for legacy tooling that does not read exports.
  main: rootExport.default,
  types: rootExport.types,
  exports: publishedExports,
  files: ["dist"],
  ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
  publishConfig: { access: "public" },
};

writeFileSync(
  join(distPkgDir, "package.json"),
  `${JSON.stringify(published, null, 2)}\n`,
);

const readme = join(packageDir, "README.md");
if (existsSync(readme)) {
  copyFileSync(readme, join(distPkgDir, "README.md"));
}
copyFileSync(join(packageDir, "LICENSE"), join(distPkgDir, "LICENSE"));

console.log(
  `${manifest.name}@${manifest.version} ready in ${distPkgDir} — ` +
    "verify with `cd dist-pkg && npm pack`",
);

function readManifest(dir: string): PackageJson {
  return JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ) as PackageJson;
}

function resolveWorkspaceVersion(dep: string): string {
  const unscoped = dep.replace(/^@tidegate\//, "tidegate-");
  const target = readManifest(join(workspaceRoot, "packages", unscoped));
  return target.version;
}

function rewriteDeclarationExtensions(distDir: string): void {
  // Covers `from "./x.ts"` and `import("./x.ts")`; ".d.ts" is left alone.
  const relativeTsSpecifier = /((?:from\s+|import\()\s*")(\.\.?\/[^"]+?)(?<!\.d)\.ts(")/g;
  const residualTsSpecifier = /(?:from\s+|import\()\s*"\.\.?\/[^"]+?(?<!\.d)\.ts"/;
  for (const entry of readdirSync(distDir, { recursive: true })) {
    const name = String(entry);
    if (!name.endsWith(".d.ts")) continue;
    const path = join(distDir, name);
    const source = readFileSync(path, "utf8");
    const rewritten = source.replace(relativeTsSpecifier, "$1$2.js$3");
    if (rewritten !== source) writeFileSync(path, rewritten);
    // Postcondition: no residual .ts specifier may reach the tarball.
    if (residualTsSpecifier.test(rewritten)) {
      throw new Error(
        `${name}: residual .ts specifier after rewriting the d.ts files`,
      );
    }
  }
}
