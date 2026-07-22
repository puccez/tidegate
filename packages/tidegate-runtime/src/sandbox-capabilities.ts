import { posix } from "node:path";
import {
  TidegateActionCatalogManifestV1Schema,
  type TidegateActionCatalogManifestV1,
} from "@tidegate/contracts";
import {
  generateTidegateCapabilitiesClient,
  TIDEGATE_CAPABILITIES_GENERATED_FILENAME,
  type GeneratedTidegateCapabilitiesClient,
} from "./capability-codegen.ts";

export const TIDEGATE_SANDBOX_CAPABILITIES_DEFAULT_PATH =
  TIDEGATE_CAPABILITIES_GENERATED_FILENAME;

export type TidegateSandboxTextWorkspace = {
  writeTextFile: (args: {
    path: string;
    content: string;
  }) => Promise<unknown> | unknown;
};

export type PrepareTidegateSandboxCapabilitiesOptions = {
  sandbox: TidegateSandboxTextWorkspace;
  manifest: unknown;
  path?: string;
};

export type PreparedTidegateSandboxCapabilities =
  GeneratedTidegateCapabilitiesClient & {
    path: string;
    importSpecifier: string;
    actionIds: string[];
    manifest: TidegateActionCatalogManifestV1;
  };

export async function prepareTidegateSandboxCapabilities({
  sandbox,
  manifest,
  path = TIDEGATE_SANDBOX_CAPABILITIES_DEFAULT_PATH,
}: PrepareTidegateSandboxCapabilitiesOptions): Promise<PreparedTidegateSandboxCapabilities> {
  const parsedManifest = TidegateActionCatalogManifestV1Schema.parse(manifest);
  const generated = generateTidegateCapabilitiesClient(parsedManifest);
  const generatedPath = normalizeSandboxGeneratedPath(path);

  await sandbox.writeTextFile({
    path: generatedPath,
    content: generated.source,
  });

  return {
    ...generated,
    path: generatedPath,
    importSpecifier: toImportSpecifier(generatedPath),
    actionIds: Object.keys(parsedManifest.actions).sort((left, right) =>
      left.localeCompare(right),
    ),
    manifest: parsedManifest,
  };
}

function normalizeSandboxGeneratedPath(path: string): string {
  const trimmedPath = path.trim();

  if (trimmedPath.length === 0) {
    throw new Error("Tidegate sandbox capability path cannot be empty.");
  }

  if (trimmedPath.includes("\0")) {
    throw new Error("Tidegate sandbox capability path cannot contain NUL bytes.");
  }

  const normalizedPath = posix.normalize(trimmedPath.replaceAll("\\", "/"));

  if (
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    posix.isAbsolute(normalizedPath)
  ) {
    throw new Error(
      "Tidegate sandbox capability path must stay inside the sandbox workspace.",
    );
  }

  return normalizedPath;
}

function toImportSpecifier(path: string): string {
  const withoutTypeScriptExtension = path.replace(/\.tsx?$/u, "");

  if (
    withoutTypeScriptExtension.startsWith("./") ||
    withoutTypeScriptExtension.startsWith("../")
  ) {
    return withoutTypeScriptExtension;
  }

  return `./${withoutTypeScriptExtension}`;
}
