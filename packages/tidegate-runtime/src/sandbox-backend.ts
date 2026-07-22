import { posix } from "node:path";
import {
  TIDEGATE_SANDBOX_CAPABILITIES_DEFAULT_PATH,
  type TidegateSandboxTextWorkspace,
} from "./sandbox-capabilities.ts";
import type {
  PublishedInteractionExecutionPayload,
  PublishedInteractionExecutionResult,
  PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor.ts";

/** Workspace file the orchestrator writes the transpiled interaction into. */
export const SANDBOX_INTERACTION_SOURCE_PATH = "interaction.generated.mjs";

/** Workspace file the orchestrator writes the sandbox runner into. */
export const SANDBOX_RUNNER_SOURCE_PATH = "tidegate-runner.mjs";

/**
 * The exact order the orchestrator writes workspace files in. Every backend's
 * workspace must observe this order; the conformance suite asserts it so an
 * alternative workspace implementation cannot silently reorder.
 */
export const SANDBOX_WORKSPACE_WRITE_ORDER: readonly string[] = [
  SANDBOX_INTERACTION_SOURCE_PATH,
  TIDEGATE_SANDBOX_CAPABILITIES_DEFAULT_PATH,
  SANDBOX_RUNNER_SOURCE_PATH,
];

export type PublishedInteractionSandboxWorkspace =
  TidegateSandboxTextWorkspace & {
    readonly rootPath: string;
    cleanup: () => Promise<void>;
  };

export type PublishedInteractionSandboxWorkspaceFactory = {
  createWorkspace: (
    payload: PublishedInteractionExecutionPayload,
  ) => Promise<PublishedInteractionSandboxWorkspace>;
};

export type PublishedInteractionSandboxProviderExecuteRequest = {
  workspace: PublishedInteractionSandboxWorkspace;
  runnerPath: string;
  payload: PublishedInteractionExecutionPayload;
  runtime: PublishedInteractionTrustedRuntime;
};

export type PublishedInteractionSandboxProvider = {
  execute: (
    request: PublishedInteractionSandboxProviderExecuteRequest,
  ) => Promise<PublishedInteractionExecutionResult>;
};

/**
 * A sandbox backend is the single swappable unit behind the published-
 * interaction execution seam: a workspace factory paired with the provider
 * that executes the prepared workspace. Selecting the pair as one unit
 * prevents mismatched pairings (for example a local tmpdir workspace handed
 * to a remote provider).
 *
 * Invariants every backend MUST uphold (`sandbox-backend-conformance.ts` is
 * the executable contract):
 *
 * - The backend runs the runner source the orchestrator wrote into the
 *   workspace unchanged and speaks the NDJSON protocol defined by
 *   `SandboxStdinMessage` / `SandboxStdoutMessage`.
 * - The orchestrator (`SandboxedPublishedInteractionExecutor`) owns source
 *   policy, transpile, capability manifests, tracing spans, action-call
 *   mediation, timeout, and result normalization. Backends move bytes and
 *   MUST NOT emit, reorder, or suppress tracing spans.
 * - The security posture is never weakened: no ambient network for generated
 *   code, no dynamic code generation from strings, stripped host globals,
 *   and workspace paths that cannot escape the workspace root.
 */
export type SandboxBackend = {
  readonly workspaceFactory: PublishedInteractionSandboxWorkspaceFactory;
  readonly provider: PublishedInteractionSandboxProvider;
};

/**
 * Normalizes a sandbox workspace-relative path and fails closed on anything
 * that could escape the workspace root (traversal, absolute paths, NUL).
 * Every workspace implementation must route writes through this guard.
 */
export function normalizeSandboxWorkspacePath(path: string): string {
  const trimmedPath = path.trim();

  if (trimmedPath.length === 0 || trimmedPath.includes("\0")) {
    throw new Error("Sandbox workspace paths must be non-empty text paths.");
  }

  const normalizedPath = posix.normalize(trimmedPath.replaceAll("\\", "/"));

  if (
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    posix.isAbsolute(normalizedPath)
  ) {
    throw new Error("Sandbox workspace paths must stay inside the workspace.");
  }

  return normalizedPath;
}
