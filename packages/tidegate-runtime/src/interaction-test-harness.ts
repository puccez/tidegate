import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PublishInteractionRequestSchema,
  type PublishInteractionRequest,
  type TidegateActionCatalogManifestV1,
} from "@tidegate/contracts";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import {
  generateTidegateCapabilitiesClient,
  TIDEGATE_CAPABILITIES_GENERATED_FILENAME,
} from "./capability-codegen.ts";
import { transpileGeneratedInteractionSource } from "./generated-interaction-source-policy.ts";

const DEFAULT_TEST_EXECUTION_TIMEOUT_MS = 30_000;
const DEFAULT_TEST_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_TEST_ACTION_CALLS_PER_ACTION = 1;
const TEST_HARNESS_WORKSPACE_PREFIX = "tidegate-interaction-test-";
const INTERACTION_MODULE_FILENAME = "interaction.generated.mjs";
const CAPABILITIES_MODULE_FILENAME = "tidegate-capabilities.generated.mjs";

export type InteractionTestHarnessDiagnosticCode =
  | "invalid_options"
  | "file_read_failed"
  | "json_parse_failed"
  | "publish_request_invalid"
  | "capability_not_declared"
  | "capability_mock_missing"
  | "capability_mock_failed"
  | "capability_call_limit_exceeded"
  | "capability_timeout"
  | "interaction_load_failed"
  | "interaction_missing_default_export"
  | "interaction_failed"
  | "interaction_timeout"
  | "interaction_aborted";

export type InteractionTestHarnessDiagnostic = {
  code: InteractionTestHarnessDiagnosticCode;
  severity: "error";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  actionId?: string;
  testName?: string;
  stack?: string;
};

export type InteractionTestHarnessActionCall = {
  actionId: string;
  input: unknown;
};

export type InteractionTestHarnessCapabilityCall = {
  actionId: string;
  input: unknown;
  /** Zero-based index across all capability calls in this invocation. */
  callIndex: number;
  invocationId: string;
  auth: RuntimeAuthContext;
  signal: AbortSignal;
};

export type InteractionTestHarnessCapabilityMock = (
  input: unknown,
  call: InteractionTestHarnessCapabilityCall,
) => Promise<unknown> | unknown;

type SourceInput =
  | {
      source: string;
      sourcePath?: never;
    }
  | {
      sourcePath: string;
      source?: never;
    };

type PublishRequestInput =
  | {
      publishRequest: unknown;
      publishRequestPath?: never;
    }
  | {
      publishRequestPath: string;
      publishRequest?: never;
    };

export type CreateInteractionTestHarnessOptions = SourceInput &
  PublishRequestInput & {
    auth?: RuntimeAuthContext;
    capabilities?: Record<string, InteractionTestHarnessCapabilityMock>;
    cwd?: string;
    timeoutMs?: number;
  };

export type InteractionTestHarnessInvokeOptions = {
  auth?: RuntimeAuthContext;
  invocationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type InteractionTestHarness = {
  readonly publishRequest: PublishInteractionRequest;
  readonly declaredActionIds: readonly string[];
  invoke: (
    input: unknown,
    options?: InteractionTestHarnessInvokeOptions,
  ) => Promise<unknown>;
  actionCalls: () => InteractionTestHarnessActionCall[];
  resetActionCalls: () => void;
};

type InteractionRunner = (
  input: unknown,
  ctx: {
    auth: RuntimeAuthContext;
    signal: AbortSignal;
    capabilities: unknown;
  },
) => Promise<unknown> | unknown;

type GeneratedCapabilitiesModule = {
  createTidegateCapabilities: (actions: {
    call(actionId: string, input: unknown): Promise<unknown>;
  }) => unknown;
};

type InteractionModule = {
  default?: unknown;
};

type ResolvedSource = {
  source: string;
  sourceFile: string;
};

type ResolvedPublishRequest = {
  publishRequest: PublishInteractionRequest;
  publishRequestFile?: string;
};

type HarnessRuntime = {
  capabilitiesModule: GeneratedCapabilitiesModule;
  interactionModulePath: string;
  runner: InteractionRunner;
  sourceFile: string;
};

export class InteractionTestHarnessError extends Error {
  readonly code: InteractionTestHarnessDiagnosticCode;
  readonly diagnostics: InteractionTestHarnessDiagnostic[];

  constructor({
    cause,
    code,
    diagnostics,
    message,
  }: {
    cause?: unknown;
    code: InteractionTestHarnessDiagnosticCode;
    diagnostics: InteractionTestHarnessDiagnostic[];
    message: string;
  }) {
    super(message);
    this.name = "InteractionTestHarnessError";
    this.code = code;
    this.diagnostics = diagnostics;

    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export async function createInteractionTestHarness(
  options: CreateInteractionTestHarnessOptions,
): Promise<InteractionTestHarness> {
  const cwd = options.cwd ?? process.cwd();
  const resolvedSource = await resolveSourceInput(options, cwd);
  const resolvedPublishRequest = await resolvePublishRequestInput(
    options,
    cwd,
    resolvedSource.source,
  );
  const publishRequest = resolvedPublishRequest.publishRequest;
  const declaredActionIds = publishRequest.requestedAllowedActions.map(
    (action) => action.id,
  );
  assertUniqueActionIds(declaredActionIds, resolvedPublishRequest.publishRequestFile);
  assertMocksAreDeclared({
    declaredActionIds,
    capabilities: options.capabilities ?? {},
    publishRequestFile: resolvedPublishRequest.publishRequestFile,
  });

  const runtime = await loadHarnessRuntime({
    declaredActionIds,
    publishRequest,
    source: resolvedSource.source,
    sourceFile: resolvedSource.sourceFile,
  });
  const calls: InteractionTestHarnessActionCall[] = [];

  return {
    publishRequest,
    declaredActionIds,
    actionCalls() {
      return calls.map((call) => ({
        actionId: call.actionId,
        input: cloneForRecord(call.input),
      }));
    },
    resetActionCalls() {
      calls.length = 0;
    },
    async invoke(
      input: unknown,
      invokeOptions: InteractionTestHarnessInvokeOptions = {},
    ): Promise<unknown> {
      const invocationId =
        invokeOptions.invocationId ??
        `interaction-test:${createStableInvocationId(input)}`;
      const auth = invokeOptions.auth ?? options.auth ?? defaultHarnessAuth();
      const abortController = new AbortController();
      const externalSignal = invokeOptions.signal;
      const timeoutMs =
        invokeOptions.timeoutMs ??
        options.timeoutMs ??
        publishRequest.timeout?.executionMs ??
        DEFAULT_TEST_EXECUTION_TIMEOUT_MS;
      const timeout = validatePositiveInteger(
        timeoutMs,
        "Interaction test harness timeoutMs must be a positive integer.",
      );
      const perActionTimeoutMs =
        publishRequest.timeout?.perActionMs ?? DEFAULT_TEST_ACTION_TIMEOUT_MS;
      // Mirror the publish handler's effective timeout default: an action with
      // no requested maxCalls contributes one call to the invocation budget.
      const maxActionCalls =
        publishRequest.timeout?.maxActionCalls ??
        Math.max(
          declaredActionIds.length,
          publishRequest.requestedAllowedActions.reduce(
            (total, action) =>
              total + (action.maxCalls ?? DEFAULT_TEST_ACTION_CALLS_PER_ACTION),
            0,
          ),
          1,
        );
      const invocationCalls: InteractionTestHarnessActionCall[] = [];
      const perActionCounts = new Map<string, number>();
      const actionCaller = {
        call: async (actionId: string, actionInput: unknown) => {
          const callSite = new Error();
          const actionCall: InteractionTestHarnessActionCall = {
            actionId,
            input: cloneForRecord(actionInput),
          };
          // Record attempted calls before validation so failed tests can inspect
          // exactly what the source tried to do.
          calls.push(actionCall);
          invocationCalls.push(actionCall);

          if (!declaredActionIds.includes(actionId)) {
            throw harnessError({
              actionId,
              cause: callSite,
              code: "capability_not_declared",
              message: `Interaction source attempted to call undeclared capability "${actionId}". Declared capabilities: ${formatActionIds(
                declaredActionIds,
              )}.`,
              sourceFile: runtime.sourceFile,
              sourceModulePath: runtime.interactionModulePath,
            });
          }

          if (invocationCalls.length > maxActionCalls) {
            throw harnessError({
              actionId,
              cause: callSite,
              code: "capability_call_limit_exceeded",
              message: `Interaction exceeded the maxActionCalls limit of ${maxActionCalls}.`,
              sourceFile: runtime.sourceFile,
              sourceModulePath: runtime.interactionModulePath,
            });
          }

          const actionLimit = publishRequest.requestedAllowedActions.find(
            (action) => action.id === actionId,
          );
          const callsForAction = (perActionCounts.get(actionId) ?? 0) + 1;
          perActionCounts.set(actionId, callsForAction);

          if (
            actionLimit?.maxCalls !== undefined &&
            callsForAction > actionLimit.maxCalls
          ) {
            throw harnessError({
              actionId,
              cause: callSite,
              code: "capability_call_limit_exceeded",
              message: `Interaction exceeded the maxCalls limit of ${actionLimit.maxCalls} for capability "${actionId}".`,
              sourceFile: runtime.sourceFile,
              sourceModulePath: runtime.interactionModulePath,
            });
          }

          const mock = options.capabilities?.[actionId];

          if (mock === undefined) {
            throw harnessError({
              actionId,
              cause: callSite,
              code: "capability_mock_missing",
              message: `No mock was provided for capability "${actionId}". Add a capabilities["${actionId}"] mock to createInteractionTestHarness(...).`,
              sourceFile: runtime.sourceFile,
              sourceModulePath: runtime.interactionModulePath,
            });
          }

          try {
            return await promiseWithTimeout({
              actionId,
              code: "capability_timeout",
              message: `Mock for capability "${actionId}" exceeded its ${actionLimit?.timeoutMs ?? perActionTimeoutMs}ms timeout.`,
              promise: Promise.resolve(
                mock(actionInput, {
                  actionId,
                  auth,
                  callIndex: invocationCalls.length - 1,
                  input: actionInput,
                  invocationId,
                  signal: abortController.signal,
                }),
              ),
              sourceFile: runtime.sourceFile,
              sourceModulePath: runtime.interactionModulePath,
              timeoutMs: actionLimit?.timeoutMs ?? perActionTimeoutMs,
            });
          } catch (error) {
            if (isInteractionTestHarnessError(error)) {
              throw error;
            }

            throw harnessError({
              actionId,
              cause: error,
              code: "capability_mock_failed",
              message: `Mock for capability "${actionId}" failed: ${errorMessage(
                error,
              )}`,
              sourceFile: runtime.sourceFile,
              sourceModulePath: runtime.interactionModulePath,
            });
          }
        },
      };
      const generatedCapabilities =
        runtime.capabilitiesModule.createTidegateCapabilities(actionCaller);
      const capabilities = wrapCapabilitiesForDiagnostics({
        declaredActionIds,
        sourceFile: runtime.sourceFile,
        sourceModulePath: runtime.interactionModulePath,
        value: generatedCapabilities,
      });
      const ctx = {
        auth,
        signal: abortController.signal,
        capabilities,
      };

      let removeAbortListener: (() => void) | undefined;

      try {
        const interactionPromise = Promise.resolve(runtime.runner(input, ctx));
        const result = await promiseWithInvocationTimeout({
          abortController,
          externalSignal,
          message: `Interaction exceeded its ${timeout}ms test harness timeout.`,
          promise: interactionPromise,
          sourceFile: runtime.sourceFile,
          sourceModulePath: runtime.interactionModulePath,
          timeoutMs: timeout,
          onAbortListenerRegistered(remove) {
            removeAbortListener = remove;
          },
        });

        return result;
      } catch (error) {
        if (isInteractionTestHarnessError(error)) {
          throw error;
        }

        throw harnessError({
          cause: error,
          code: "interaction_failed",
          message: `Interaction invocation failed: ${errorMessage(error)}`,
          sourceFile: runtime.sourceFile,
          sourceModulePath: runtime.interactionModulePath,
        });
      } finally {
        abortController.abort();
        removeAbortListener?.();
      }
    },
  };
}

export function isInteractionTestHarnessError(
  error: unknown,
): error is InteractionTestHarnessError {
  return error instanceof InteractionTestHarnessError;
}

export function toInteractionTestHarnessDiagnostics(
  error: unknown,
  options: { testName?: string } = {},
): InteractionTestHarnessDiagnostic[] {
  const diagnostics = isInteractionTestHarnessError(error)
    ? error.diagnostics
    : [
        {
          code: "interaction_failed" as const,
          severity: "error" as const,
          message: errorMessage(error),
          stack: errorStack(error),
        },
      ];

  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    ...(options.testName === undefined ? {} : { testName: options.testName }),
  }));
}

async function resolveSourceInput(
  options: CreateInteractionTestHarnessOptions,
  cwd: string,
): Promise<ResolvedSource> {
  const hasSource = typeof options.source === "string";
  const hasSourcePath = typeof options.sourcePath === "string";

  if (hasSource === hasSourcePath) {
    throw harnessError({
      code: "invalid_options",
      message:
        "createInteractionTestHarness requires exactly one of source or sourcePath.",
    });
  }

  if (hasSource) {
    return {
      source: options.source,
      sourceFile: "<interaction source>",
    };
  }

  if (typeof options.sourcePath !== "string") {
    throw harnessError({
      code: "invalid_options",
      message:
        "createInteractionTestHarness requires exactly one of source or sourcePath.",
    });
  }

  const sourcePath = resolveHarnessPath(cwd, options.sourcePath);

  try {
    return {
      source: await readFile(sourcePath, "utf8"),
      sourceFile: sourcePath,
    };
  } catch (error) {
    throw harnessError({
      cause: error,
      code: "file_read_failed",
      file: sourcePath,
      message: `Could not read interaction source file "${sourcePath}": ${errorMessage(
        error,
      )}`,
    });
  }
}

async function resolvePublishRequestInput(
  options: CreateInteractionTestHarnessOptions,
  cwd: string,
  source: string,
): Promise<ResolvedPublishRequest> {
  const hasPublishRequest = options.publishRequest !== undefined;
  const hasPublishRequestPath = typeof options.publishRequestPath === "string";

  if (hasPublishRequest === hasPublishRequestPath) {
    throw harnessError({
      code: "invalid_options",
      message:
        "createInteractionTestHarness requires exactly one of publishRequest or publishRequestPath.",
    });
  }

  if (hasPublishRequest) {
    return {
      publishRequest: parseHarnessPublishRequest({
        raw: options.publishRequest,
        source,
      }),
    };
  }

  if (typeof options.publishRequestPath !== "string") {
    throw harnessError({
      code: "invalid_options",
      message:
        "createInteractionTestHarness requires exactly one of publishRequest or publishRequestPath.",
    });
  }

  const publishRequestPath = resolveHarnessPath(cwd, options.publishRequestPath);
  let rawText: string;

  try {
    rawText = await readFile(publishRequestPath, "utf8");
  } catch (error) {
    throw harnessError({
      cause: error,
      code: "file_read_failed",
      file: publishRequestPath,
      message: `Could not read publish request file "${publishRequestPath}": ${errorMessage(
        error,
      )}`,
    });
  }

  let raw: unknown;

  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw harnessError({
      cause: error,
      code: "json_parse_failed",
      file: publishRequestPath,
      message: `Publish request file "${publishRequestPath}" is not valid JSON: ${errorMessage(
        error,
      )}`,
    });
  }

  return {
    publishRequest: parseHarnessPublishRequest({
      file: publishRequestPath,
      raw,
      source,
    }),
    publishRequestFile: publishRequestPath,
  };
}

function parseHarnessPublishRequest({
  file,
  raw,
  source,
}: {
  file?: string;
  raw: unknown;
  source: string;
}): PublishInteractionRequest {
  if (!isRecord(raw)) {
    throw harnessError({
      code: "publish_request_invalid",
      file,
      message: "Publish request must be a JSON object.",
    });
  }

  const parsed = PublishInteractionRequestSchema.safeParse({
    ...raw,
    source,
  });

  if (!parsed.success) {
    throw harnessError({
      code: "publish_request_invalid",
      file,
      message: `Publish request is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    });
  }

  return parsed.data;
}

async function loadHarnessRuntime({
  declaredActionIds,
  publishRequest,
  source,
  sourceFile,
}: {
  declaredActionIds: string[];
  publishRequest: PublishInteractionRequest;
  source: string;
  sourceFile: string;
}): Promise<HarnessRuntime> {
  const workspace = await mkdtemp(
    join(tmpdir(), TEST_HARNESS_WORKSPACE_PREFIX),
  );
  const interactionModulePath = join(workspace, INTERACTION_MODULE_FILENAME);
  const capabilitiesModulePath = join(workspace, CAPABILITIES_MODULE_FILENAME);

  try {
    const generated = generateTidegateCapabilitiesClient(
      createHarnessCapabilityManifest(publishRequest, declaredActionIds),
    );

    await writeFile(
      capabilitiesModulePath,
      transpileGeneratedInteractionSource(generated.source),
      "utf8",
    );
    await writeFile(
      join(workspace, TIDEGATE_CAPABILITIES_GENERATED_FILENAME),
      generated.source,
      "utf8",
    );
    await writeFile(
      interactionModulePath,
      transpileGeneratedInteractionSource(source),
      "utf8",
    );

    const capabilitiesModule = await importModule<GeneratedCapabilitiesModule>(
      capabilitiesModulePath,
      isGeneratedCapabilitiesModule,
      "interaction_load_failed",
      `Generated capabilities module did not export createTidegateCapabilities.`,
      sourceFile,
    );
    const interactionModule = await importModule<InteractionModule>(
      interactionModulePath,
      isInteractionModule,
      "interaction_load_failed",
      "Interaction module could not be imported.",
      sourceFile,
    );

    if (typeof interactionModule.default !== "function") {
      throw harnessError({
        code: "interaction_missing_default_export",
        file: sourceFile,
        message: "Interaction source must default export a run function.",
      });
    }

    return {
      capabilitiesModule,
      interactionModulePath,
      runner: interactionModule.default as InteractionRunner,
      sourceFile,
    };
  } catch (error) {
    if (isInteractionTestHarnessError(error)) {
      throw error;
    }

    throw harnessError({
      cause: error,
      code: "interaction_load_failed",
      message: `Interaction source could not be loaded: ${errorMessage(error)}`,
      sourceFile,
      sourceModulePath: interactionModulePath,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function importModule<TModule>(
  modulePath: string,
  isExpectedModule: (value: unknown) => value is TModule,
  code: InteractionTestHarnessDiagnosticCode,
  invalidModuleMessage: string,
  sourceFile: string,
): Promise<TModule> {
  let imported: unknown;

  try {
    imported = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw harnessError({
      cause: error,
      code,
      message: `Could not import interaction test module "${modulePath}": ${errorMessage(
        error,
      )}`,
      sourceFile,
      sourceModulePath: modulePath,
    });
  }

  if (!isExpectedModule(imported)) {
    throw harnessError({
      code,
      file: sourceFile,
      message: invalidModuleMessage,
    });
  }

  return imported;
}

function createHarnessCapabilityManifest(
  publishRequest: PublishInteractionRequest,
  declaredActionIds: string[],
): TidegateActionCatalogManifestV1 {
  return {
    schemaVersion: "tidegate.actionCatalog.v1",
    catalogId: `${publishRequest.requestedInteractionId}.test-harness`,
    version: "local-test",
    actions: Object.fromEntries(
      declaredActionIds.map((actionId) => [
        actionId,
        {
          description: `Interaction test capability ${actionId}.`,
          input: {},
          output: {},
          effects: "external" as const,
          requiredPermissions: [],
          audit: {
            required: true,
            redactPaths: [],
          },
        },
      ]),
    ),
  };
}

function assertUniqueActionIds(actionIds: string[], file?: string) {
  const seen = new Set<string>();

  for (const actionId of actionIds) {
    if (seen.has(actionId)) {
      throw harnessError({
        actionId,
        code: "publish_request_invalid",
        file,
        message: `Publish request declares capability "${actionId}" more than once.`,
      });
    }

    seen.add(actionId);
  }
}

function assertMocksAreDeclared({
  capabilities,
  declaredActionIds,
  publishRequestFile,
}: {
  capabilities: Record<string, InteractionTestHarnessCapabilityMock>;
  declaredActionIds: string[];
  publishRequestFile?: string;
}) {
  const declared = new Set(declaredActionIds);

  for (const actionId of Object.keys(capabilities)) {
    if (!declared.has(actionId)) {
      throw harnessError({
        actionId,
        code: "capability_not_declared",
        file: publishRequestFile,
        message: `Capability mock "${actionId}" is not declared by requestedAllowedActions. Declared capabilities: ${formatActionIds(
          declaredActionIds,
        )}.`,
      });
    }
  }
}

function wrapCapabilitiesForDiagnostics({
  declaredActionIds,
  sourceFile,
  sourceModulePath,
  value,
}: {
  declaredActionIds: string[];
  sourceFile: string;
  sourceModulePath: string;
  value: unknown;
}): unknown {
  const declared = new Set(declaredActionIds);

  function wrap(node: unknown, path: string[]): unknown {
    if (typeof node !== "object" || node === null) {
      return node;
    }

    // The generated capabilities client currently emits plain nested object
    // literals. Keep this wrapper aligned if codegen starts using prototypes.
    return new Proxy(node as Record<PropertyKey, unknown>, {
      get(target, property, receiver) {
        if (typeof property === "symbol") {
          return Reflect.get(target, property, receiver);
        }

        if (property === "then" || property === "toJSON") {
          return Reflect.get(target, property, receiver);
        }

        if (!Object.prototype.hasOwnProperty.call(target, property)) {
          const callSite = new Error();
          const capabilityPath = [...path, property].join(".");
          const hasDeclaredDescendant = declaredActionIds.some((actionId) =>
            actionId.startsWith(`${capabilityPath}.`),
          );
          const label = hasDeclaredDescendant
            ? `capability namespace "${capabilityPath}"`
            : `capability "${capabilityPath}"`;

          throw harnessError({
            actionId: capabilityPath,
            cause: callSite,
            code: "capability_not_declared",
            message: `Interaction source attempted to read undeclared ${label}. Declared capabilities: ${formatActionIds(
              declaredActionIds,
            )}.`,
            sourceFile,
            sourceModulePath,
          });
        }

        const child = Reflect.get(target, property, receiver);
        const childPath = [...path, property];

        if (
          typeof child === "function" &&
          !declared.has(childPath.join("."))
        ) {
          throw harnessError({
            actionId: childPath.join("."),
            code: "capability_not_declared",
            message: `Generated capability function "${childPath.join(
              ".",
            )}" is not declared. Declared capabilities: ${formatActionIds(
              declaredActionIds,
            )}.`,
            sourceFile,
          });
        }

        return wrap(child, childPath);
      },
    });
  }

  return wrap(value, []);
}

async function promiseWithInvocationTimeout({
  abortController,
  externalSignal,
  message,
  onAbortListenerRegistered,
  promise,
  sourceFile,
  sourceModulePath,
  timeoutMs,
}: {
  abortController: AbortController;
  externalSignal?: AbortSignal;
  message: string;
  onAbortListenerRegistered: (remove: () => void) => void;
  promise: Promise<unknown>;
  sourceFile: string;
  sourceModulePath: string;
  timeoutMs: number;
}): Promise<unknown> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => {
    // The timeout branch can win the race while user code keeps running.
    // Observe late rejections so test runners do not report unhandled noise.
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(
        harnessError({
          code: "interaction_timeout",
          message,
          sourceFile,
          sourceModulePath,
        }),
      );
    }, timeoutMs);
  });
  let abort: Promise<never> | undefined;

  if (externalSignal !== undefined) {
    abort = new Promise<never>((_, reject) => {
      const onAbort = () => {
        abortController.abort(externalSignal.reason);
        reject(
          harnessError({
            code: "interaction_aborted",
            message: "Interaction invocation was aborted by the caller signal.",
            sourceFile,
            sourceModulePath,
          }),
        );
      };

      if (externalSignal.aborted) {
        onAbort();
        return;
      }

      externalSignal.addEventListener("abort", onAbort, { once: true });
      onAbortListenerRegistered(() =>
        externalSignal.removeEventListener("abort", onAbort),
      );
    });
  }

  try {
    return await Promise.race(
      abort === undefined ? [promise, timeout] : [promise, timeout, abort],
    );
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function promiseWithTimeout({
  actionId,
  code,
  message,
  promise,
  sourceFile,
  sourceModulePath,
  timeoutMs,
}: {
  actionId: string;
  code: InteractionTestHarnessDiagnosticCode;
  message: string;
  promise: Promise<unknown>;
  sourceFile: string;
  sourceModulePath: string;
  timeoutMs: number;
}): Promise<unknown> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => {
    // The timeout branch can win the race while a mock keeps running.
    // Observe late rejections so test runners do not report unhandled noise.
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        harnessError({
          actionId,
          code,
          message,
          sourceFile,
          sourceModulePath,
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function harnessError({
  actionId,
  cause,
  code,
  file,
  message,
  sourceFile,
  sourceModulePath,
}: {
  actionId?: string;
  cause?: unknown;
  code: InteractionTestHarnessDiagnosticCode;
  file?: string;
  message: string;
  sourceFile?: string;
  sourceModulePath?: string;
}): InteractionTestHarnessError {
  const stackLocation =
    sourceModulePath === undefined
      ? undefined
      : stackLocationForModule(errorStack(cause), sourceModulePath);
  // Line/column are best-effort locations from the transpiled temp module.
  // ts.transpileModule is usually line-preserving for generated interactions,
  // but type-only declarations can shift line numbers.
  const diagnosticFile = file ?? sourceFile;
  const diagnostic: InteractionTestHarnessDiagnostic = {
    code,
    severity: "error",
    message,
    ...(actionId === undefined ? {} : { actionId }),
    ...(diagnosticFile === undefined ? {} : { file: diagnosticFile }),
    ...(stackLocation?.line === undefined ? {} : { line: stackLocation.line }),
    ...(stackLocation?.column === undefined
      ? {}
      : { column: stackLocation.column }),
    ...(errorStack(cause) === undefined ? {} : { stack: errorStack(cause) }),
  };

  return new InteractionTestHarnessError({
    cause,
    code,
    diagnostics: [diagnostic],
    message,
  });
}

function stackLocationForModule(
  stack: string | undefined,
  modulePath: string,
): { line?: number; column?: number } | undefined {
  if (stack === undefined) {
    return undefined;
  }

  for (const line of stack.split("\n")) {
    if (!line.includes(modulePath)) {
      continue;
    }

    const match = /:(\d+):(\d+)\)?$/u.exec(line.trim());

    if (match === null) {
      continue;
    }

    return {
      line: Number(match[1]),
      column: Number(match[2]),
    };
  }

  return undefined;
}

function resolveHarnessPath(cwd: string, path: string): string {
  if (path.trim().length === 0) {
    throw harnessError({
      code: "invalid_options",
      message: "Interaction test harness file paths cannot be empty.",
    });
  }

  if (path.includes("\0")) {
    throw harnessError({
      code: "invalid_options",
      message: "Interaction test harness file paths cannot contain NUL bytes.",
    });
  }

  return isAbsolute(path) ? path : resolve(cwd, path);
}

function validatePositiveInteger(value: number, message: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw harnessError({
      code: "invalid_options",
      message,
    });
  }

  return value;
}

function createStableInvocationId(input: unknown): string {
  try {
    return createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex")
      .slice(0, 12);
  } catch {
    return randomUUID();
  }
}

function defaultHarnessAuth(): RuntimeAuthContext {
  return {
    authMode: "local-dev",
    scopes: [],
    permissions: [],
    authorization: {
      permissions: [],
      resourceGrants: [],
    },
  };
}

function isGeneratedCapabilitiesModule(
  value: unknown,
): value is GeneratedCapabilitiesModule {
  return (
    isRecord(value) &&
    typeof value.createTidegateCapabilities === "function"
  );
}

function isInteractionModule(value: unknown): value is InteractionModule {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatActionIds(actionIds: readonly string[]): string {
  return actionIds.length === 0
    ? "<none>"
    : actionIds.map((actionId) => `"${actionId}"`).join(", ");
}

function cloneForRecord<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
