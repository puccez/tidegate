import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Readable } from "node:stream";
import {
  TidegateActionCatalogManifestV1Schema,
  type JsonSchema,
  type TidegateActionCatalogManifestV1,
} from "@tidegate/contracts";
import type { AnyRuntimeAction } from "./action-catalog.ts";
import {
  generateTidegateCapabilitiesClient,
  jsonSchemaToTypeScriptType,
  TIDEGATE_CAPABILITIES_GENERATED_FILENAME,
  type GeneratedTidegateCapabilitiesClient,
} from "./capability-codegen.ts";
import {
  collectGeneratedInteractionPublishSourcePolicyFindings,
  type GeneratedInteractionSourcePolicyFinding,
} from "./generated-interaction-source-policy.ts";

export type PublishTypecheckActionCatalogMetadata = {
  id: string;
  version: string;
};

export type PublishTypecheckDiagnosticCode =
  | "manifest_invalid"
  | "action_schema_missing"
  | "capability_generation_failed"
  | "import_disallowed"
  | "raw_action_bypass"
  | "source_policy_disallowed"
  | "unsafe_any"
  | "missing_default_run"
  | "invalid_default_run"
  | "typecheck_failed"
  | "checker_failed";

export type PublishTypecheckDiagnostic = {
  code: PublishTypecheckDiagnosticCode;
  message: string;
  severity: "error";
  file?: string;
  line?: number;
  column?: number;
  specifier?: string;
  actionId?: string;
  typescriptCode?: string;
};

export type PublishTypecheckCheckerOptions = {
  command?: string;
  baseArgs?: string[];
  timeoutMs?: number;
};

export type ResolvePublishTypecheckActionCatalogManifestInput = {
  actionCatalogMetadata: PublishTypecheckActionCatalogMetadata;
  actions: AnyRuntimeAction[];
};

export type ResolvePublishTypecheckActionCatalogManifestSuccess = {
  ok: true;
  manifest: TidegateActionCatalogManifestV1;
  diagnostics: [];
};

export type ResolvePublishTypecheckActionCatalogManifestFailure = {
  ok: false;
  diagnostics: PublishTypecheckDiagnostic[];
};

export type ResolvePublishTypecheckActionCatalogManifestResult =
  | ResolvePublishTypecheckActionCatalogManifestSuccess
  | ResolvePublishTypecheckActionCatalogManifestFailure;

export type PublishTypecheckGateInput =
  ResolvePublishTypecheckActionCatalogManifestInput & {
    source: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    checker?: PublishTypecheckCheckerOptions;
  };

export type PublishTypecheckGateSuccess = {
  ok: true;
  manifest: TidegateActionCatalogManifestV1;
  generated: GeneratedTidegateCapabilitiesClient;
  diagnostics: [];
};

export type PublishTypecheckGateFailure = {
  ok: false;
  manifest?: TidegateActionCatalogManifestV1;
  generated?: GeneratedTidegateCapabilitiesClient;
  diagnostics: PublishTypecheckDiagnostic[];
};

export type PublishTypecheckGateResult =
  | PublishTypecheckGateSuccess
  | PublishTypecheckGateFailure;

type SourceTransformResult =
  | {
      ok: true;
      source: string;
    }
  | {
      ok: false;
      diagnostics: PublishTypecheckDiagnostic[];
    };

type CheckerResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const SUBMITTED_SOURCE_FILENAME = "submitted-source.ts";
const SUBMITTED_SOURCE_ORIGINAL_FILENAME = "submitted-source.original.ts";
const SUBMITTED_SOURCE_PREFIX_LINES = 1;
const DEFAULT_CHECKER_TIMEOUT_MS = 30_000;
const DEFAULT_CHECKER_BASE_ARGS = [
  "tsc",
  "--noEmit",
  "--strict",
  "--module",
  "ESNext",
  "--moduleResolution",
  "bundler",
  "--target",
  "ESNext",
  "--lib",
  "ESNext",
  "--skipLibCheck",
  "--allowImportingTsExtensions",
  "--pretty",
  "false",
  "--noErrorTruncation",
];

export function resolvePublishTypecheckActionCatalogManifest({
  actionCatalogMetadata,
  actions,
}: ResolvePublishTypecheckActionCatalogManifestInput): ResolvePublishTypecheckActionCatalogManifestResult {
  const diagnostics: PublishTypecheckDiagnostic[] = [];
  const manifestActions: TidegateActionCatalogManifestV1["actions"] = {};

  for (const action of actions) {
    const input = action.inputSchema.jsonSchema;
    const output = action.outputSchema.jsonSchema;

    if (input === undefined || output === undefined) {
      diagnostics.push({
        code: "action_schema_missing",
        severity: "error",
        actionId: action.id,
        message: `Action "${action.id}" must expose JSON Schema input and output metadata before generated source can be typechecked.`,
      });
      continue;
    }

    manifestActions[action.id] = {
      description: action.description,
      input,
      output,
      effects: action.effects,
      requiredPermissions: action.requiredPermissions ?? [],
      tenantScope:
        action.tenantScope?.fromAuth === undefined
          ? undefined
          : { fromAuth: action.tenantScope.fromAuth },
      audit: {
        required: action.audit?.required ?? action.effects !== "read",
        redactPaths: action.audit?.redactPaths ?? [],
      },
    };
  }

  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics,
    };
  }

  const parsedManifest = TidegateActionCatalogManifestV1Schema.safeParse({
    schemaVersion: "tidegate.actionCatalog.v1",
    catalogId: actionCatalogMetadata.id,
    version: actionCatalogMetadata.version,
    actions: manifestActions,
  });

  if (!parsedManifest.success) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "manifest_invalid",
          severity: "error",
          message: `The effective action catalog manifest is invalid: ${formatZodIssues(parsedManifest.error)}`,
        },
      ],
    };
  }

  return {
    ok: true,
    manifest: parsedManifest.data,
    diagnostics: [],
  };
}

export async function runPublishTypecheckGate({
  actionCatalogMetadata,
  actions,
  checker,
  inputSchema,
  outputSchema,
  source,
}: PublishTypecheckGateInput): Promise<PublishTypecheckGateResult> {
  const manifestResult = resolvePublishTypecheckActionCatalogManifest({
    actionCatalogMetadata,
    actions,
  });

  if (!manifestResult.ok) {
    return manifestResult;
  }

  const lintDiagnostics = collectGeneratedInteractionPublishSourcePolicyFindings(
    source,
  ).map((finding) => sourcePolicyDiagnostic(source, finding));

  if (lintDiagnostics.length > 0) {
    return {
      ok: false,
      manifest: manifestResult.manifest,
      diagnostics: lintDiagnostics,
    };
  }

  let generated: GeneratedTidegateCapabilitiesClient;

  try {
    generated = withInteractionRunnerTypes(
      generateTidegateCapabilitiesClient(manifestResult.manifest),
      inputSchema,
      outputSchema,
    );
  } catch (error) {
    return {
      ok: false,
      manifest: manifestResult.manifest,
      diagnostics: [
        {
          code: "capability_generation_failed",
          severity: "error",
          message: errorMessage(error),
        },
      ],
    };
  }

  const transformedSource = transformSubmittedSourceForTypecheck(source);

  if (!transformedSource.ok) {
    return {
      ok: false,
      manifest: manifestResult.manifest,
      generated,
      diagnostics: transformedSource.diagnostics,
    };
  }

  const workspace = await mkdtemp(join(tmpdir(), "tidegate-publish-check-"));

  try {
    await writeFile(join(workspace, generated.filename), generated.source, "utf8");
    await writeFile(
      join(workspace, SUBMITTED_SOURCE_ORIGINAL_FILENAME),
      source,
      "utf8",
    );
    await writeFile(
      join(workspace, SUBMITTED_SOURCE_FILENAME),
      transformedSource.source,
      "utf8",
    );

    const checkerResult = await runTypeScriptChecker({
      checker,
      entrypoint: SUBMITTED_SOURCE_FILENAME,
      workspace,
    });

    if (checkerResult.timedOut) {
      return {
        ok: false,
        manifest: manifestResult.manifest,
        generated,
        diagnostics: [
          {
            code: "checker_failed",
            severity: "error",
            message: "The TypeScript publish checker timed out.",
          },
        ],
      };
    }

    if (checkerResult.exitCode !== 0) {
      return {
        ok: false,
        manifest: manifestResult.manifest,
        generated,
        diagnostics: parseTypeScriptDiagnostics({
          output: `${checkerResult.stderr}\n${checkerResult.stdout}`,
          workspace,
        }),
      };
    }

    return {
      ok: true,
      manifest: manifestResult.manifest,
      generated,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      manifest: manifestResult.manifest,
      generated,
      diagnostics: [
        {
          code: "checker_failed",
          severity: "error",
          message: errorMessage(error),
        },
      ],
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function withInteractionRunnerTypes(
  generated: GeneratedTidegateCapabilitiesClient,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): GeneratedTidegateCapabilitiesClient {
  return {
    filename: generated.filename,
    source: [
      generated.source.trimEnd(),
      "",
      `export type TidegateGeneratedInteractionInput = ${jsonSchemaToTypeScriptType(inputSchema)};`,
      `export type TidegateGeneratedInteractionOutput = ${jsonSchemaToTypeScriptType(outputSchema)};`,
      "",
      "export type TidegateGeneratedInteractionRunner = (",
      "  input: TidegateGeneratedInteractionInput,",
      "  ctx: TidegateGeneratedInteractionContext,",
      ") =>",
      "  | TidegateGeneratedInteractionOutput",
      "  | Promise<TidegateGeneratedInteractionOutput>;",
      "",
    ].join("\n"),
  };
}

function sourcePolicyDiagnostic(
  source: string,
  finding: GeneratedInteractionSourcePolicyFinding,
): PublishTypecheckDiagnostic {
  const location = locationForIndex(source, finding.index);

  return {
    code: finding.code,
    severity: "error",
    file: SUBMITTED_SOURCE_ORIGINAL_FILENAME,
    line: location.line,
    column: location.column,
    message: finding.message,
    ...(finding.specifier === undefined ? {} : { specifier: finding.specifier }),
  };
}

function transformSubmittedSourceForTypecheck(
  source: string,
): SourceTransformResult {
  const normalizedSource = source.replace(/\r\n?/g, "\n");
  const functionMatch =
    /export\s+default\s+(async\s+)?function(?:\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*\(([^)]*)\)/m.exec(
      normalizedSource,
    );

  if (functionMatch) {
    const name = functionMatch[2];
    const params = functionMatch[3] ?? "";

    if (name !== undefined && name !== "run") {
      return invalidDefaultRun(
        source,
        functionMatch.index,
        "The default exported function must be named run.",
      );
    }

    const paramCount = countTopLevelParameters(params);

    if (paramCount < 2) {
      return invalidDefaultRun(
        source,
        functionMatch.index,
        "The default exported run function must accept input and ctx parameters.",
      );
    }

    const asyncKeyword = functionMatch[1] ?? "";
    const functionName = name === undefined ? "" : ` ${name}`;
    const replacement = `const __tidegate_default: TidegateGeneratedInteractionRunner = ${asyncKeyword}function${functionName}(${params})`;
    const transformed = replaceMatch(normalizedSource, functionMatch, replacement);

    return {
      ok: true,
      source: withRunnerImport(`${transformed}\n\nexport default __tidegate_default;\n`),
    };
  }

  const arrowMatch =
    /export\s+default\s+(async\s+)?(\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/m.exec(
      normalizedSource,
    );

  if (arrowMatch) {
    const params = arrowMatch[2] ?? "";
    const paramCount = countTopLevelParameters(
      params.startsWith("(") && params.endsWith(")")
        ? params.slice(1, -1)
        : params,
    );

    if (paramCount < 2) {
      return invalidDefaultRun(
        source,
        arrowMatch.index,
        "The default exported run function must accept input and ctx parameters.",
      );
    }

    const asyncKeyword = arrowMatch[1] ?? "";
    const replacement = `const __tidegate_default: TidegateGeneratedInteractionRunner = ${asyncKeyword}${params} =>`;
    const transformed = replaceMatch(normalizedSource, arrowMatch, replacement);

    return {
      ok: true,
      source: withRunnerImport(`${transformed}\n\nexport default __tidegate_default;\n`),
    };
  }

  const referenceMatch =
    /export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;/m.exec(normalizedSource);

  if (referenceMatch) {
    const name = referenceMatch[1];

    if (name !== "run") {
      return invalidDefaultRun(
        source,
        referenceMatch.index,
        "The default export must be the run function.",
      );
    }

    const transformed = replaceMatch(normalizedSource, referenceMatch, "");

    return {
      ok: true,
      source: withRunnerImport(
        [
          transformed,
          "",
          "const __tidegate_default: TidegateGeneratedInteractionRunner = run;",
          "export default __tidegate_default;",
          "",
        ].join("\n"),
      ),
    };
  }

  return {
    ok: false,
    diagnostics: [
      {
        code: "missing_default_run",
        severity: "error",
        file: SUBMITTED_SOURCE_ORIGINAL_FILENAME,
        line: 1,
        column: 1,
        message:
          "Generated interaction source must default export a run(input, ctx) function.",
      },
    ],
  };
}

function withRunnerImport(source: string) {
  return [
    `import type { TidegateGeneratedInteractionRunner } from "./tidegate-capabilities.generated";`,
    source,
  ].join("\n");
}

function invalidDefaultRun(
  source: string,
  index: number,
  message: string,
): SourceTransformResult {
  const location = locationForIndex(source, index);

  return {
    ok: false,
    diagnostics: [
      {
        code: "invalid_default_run",
        severity: "error",
        file: SUBMITTED_SOURCE_ORIGINAL_FILENAME,
        line: location.line,
        column: location.column,
        message,
      },
    ],
  };
}

function replaceMatch(
  source: string,
  match: RegExpExecArray,
  replacement: string,
) {
  return `${source.slice(0, match.index)}${replacement}${source.slice(
    match.index + match[0].length,
  )}`;
}

function countTopLevelParameters(params: string) {
  const trimmed = params.trim();

  if (trimmed.length === 0) {
    return 0;
  }

  let count = 1;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (const character of trimmed) {
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }

    if (character === "(" || character === "{" || character === "[") {
      depth += 1;
      continue;
    }

    if (character === ")" || character === "}" || character === "]") {
      depth = Math.max(depth - 1, 0);
      continue;
    }

    if (character === "," && depth === 0) {
      count += 1;
    }
  }

  return count;
}

async function runTypeScriptChecker({
  checker,
  entrypoint,
  workspace,
}: {
  checker: PublishTypecheckCheckerOptions | undefined;
  entrypoint: string;
  workspace: string;
}): Promise<CheckerResult> {
  const command = checker?.command ?? "bunx";
  const args = [...(checker?.baseArgs ?? DEFAULT_CHECKER_BASE_ARGS), entrypoint];
  const timeoutMs = checker?.timeoutMs ?? DEFAULT_CHECKER_TIMEOUT_MS;
  const child = spawn(command, args, {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      }),
      streamToString(child.stdout),
      streamToString(child.stderr),
    ]);

    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseTypeScriptDiagnostics({
  output,
  workspace,
}: {
  output: string;
  workspace: string;
}): PublishTypecheckDiagnostic[] {
  const diagnostics: PublishTypecheckDiagnostic[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm;

  for (const match of output.matchAll(pattern)) {
    const rawFile = match[1] ?? SUBMITTED_SOURCE_FILENAME;
    const line = Number(match[2]);
    const column = Number(match[3]);
    const typescriptCode = match[4];
    const message = match[5] ?? "TypeScript check failed.";

    diagnostics.push({
      code: "typecheck_failed",
      severity: "error",
      file: remapTypecheckDiagnosticFile(rawFile, workspace),
      line: remapTypecheckDiagnosticLine(rawFile, workspace, line),
      column: Number.isFinite(column) ? column : undefined,
      typescriptCode,
      message,
    });
  }

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  return [
    {
      code: "typecheck_failed",
      severity: "error",
      file: SUBMITTED_SOURCE_FILENAME,
      message: output.trim() || "TypeScript check failed.",
    },
  ];
}

function remapTypecheckDiagnosticFile(rawFile: string, workspace: string) {
  const file = normalizeDiagnosticFile(rawFile, workspace);

  return file === SUBMITTED_SOURCE_FILENAME
    ? SUBMITTED_SOURCE_ORIGINAL_FILENAME
    : file;
}

function remapTypecheckDiagnosticLine(
  rawFile: string,
  workspace: string,
  line: number,
) {
  if (!Number.isFinite(line)) {
    return undefined;
  }

  return normalizeDiagnosticFile(rawFile, workspace) === SUBMITTED_SOURCE_FILENAME
    ? Math.max(line - SUBMITTED_SOURCE_PREFIX_LINES, 1)
    : line;
}

function normalizeDiagnosticFile(rawFile: string, workspace: string) {
  if (!rawFile.startsWith(workspace)) {
    return rawFile;
  }

  return relative(workspace, rawFile);
}

function locationForIndex(source: string, index: number | undefined) {
  const safeIndex = index ?? 0;
  const prefix = source.slice(0, safeIndex);
  const lines = prefix.split(/\n/);
  const lastLine = lines[lines.length - 1] ?? "";

  return {
    line: lines.length,
    column: lastLine.length + 1,
  };
}

function streamToString(stream: Readable | null): Promise<string> {
  if (stream === null) {
    return Promise.resolve("");
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function formatZodIssues(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues
      .map((issue) => {
        if (!isRecord(issue)) {
          return String(issue);
        }

        const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
        const message =
          typeof issue.message === "string" ? issue.message : String(issue);

        return path.length > 0 ? `${path}: ${message}` : message;
      })
      .join("; ");
  }

  return errorMessage(error);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
