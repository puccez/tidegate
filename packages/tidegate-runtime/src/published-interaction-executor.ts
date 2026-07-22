import type {
  InteractionTimeout,
  InvokeInteractionErrorCode,
  InvokeInteractionRequest,
  PublishedInteractionArtifact,
} from "@tidegate/contracts";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import type { EffectiveCapabilitySet } from "./effective-capabilities.ts";

export type DeepReadonly<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? T
  : T extends (...args: any[]) => unknown
    ? T
    : T extends readonly (infer TItem)[]
      ? readonly DeepReadonly<TItem>[]
      : T extends object
        ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
        : T;

export type PublishedInteractionArtifactSource =
  | {
      kind: "source_snapshot";
      id: string;
      version: string;
      sourceHash: string;
      source: string;
      actionCatalogId: string;
      actionCatalogVersion: string;
    }
  | {
      kind: "artifact_reference";
      id: string;
      version: string;
      sourceHash: string;
      actionCatalogId: string;
      actionCatalogVersion: string;
    };

export type PublishedInteractionGeneratedCapabilityMetadata = {
  schemaVersion: "tidegate.generatedCapabilities.v1";
  actionCatalogId: string;
  actionCatalogVersion: string;
  actionIds: readonly string[];
};

export type PublishedInteractionActionCallToken = string & {
  readonly __brand: "PublishedInteractionActionCallToken";
};

export type PublishedInteractionExecutionPayload = DeepReadonly<{
  artifact: PublishedInteractionArtifactSource;
  input: InvokeInteractionRequest["input"];
  auth: RuntimeAuthContext;
  capabilities: PublishedInteractionGeneratedCapabilityMetadata;
  allowedActionIds: string[];
  invocationId: string;
  timeout: InteractionTimeout;
  actionCallToken: PublishedInteractionActionCallToken;
}>;

export type PublishedInteractionExecutorSuccessResult = {
  status: "ok";
  output: unknown;
  auditId?: string;
};

export type PublishedInteractionExecutorFailureResult = {
  status: "rejected" | "failed";
  error: {
    code: InvokeInteractionErrorCode;
    message: string;
    retryable?: boolean;
  };
  auditId?: string;
};

export type PublishedInteractionExecutorTimedOutResult = {
  status: "timed_out";
  error: {
    code: "interaction_timeout";
    message: string;
    retryable?: boolean;
  };
  auditId?: string;
};

export type PublishedInteractionExecutionResult =
  | PublishedInteractionExecutorSuccessResult
  | PublishedInteractionExecutorFailureResult
  | PublishedInteractionExecutorTimedOutResult;

export type PublishedInteractionTrustedActionCallRequest = {
  invocationId: string;
  actionCallToken: PublishedInteractionActionCallToken;
  actionId: string;
  input: unknown;
};

export type PublishedInteractionTrustedRuntime = {
  callAction: (
    request: PublishedInteractionTrustedActionCallRequest,
  ) => Promise<unknown>;
};

export interface PublishedInteractionExecutor {
  execute(
    payload: PublishedInteractionExecutionPayload,
    runtime: PublishedInteractionTrustedRuntime,
  ): Promise<PublishedInteractionExecutionResult>;
}

export type FakePublishedInteractionExecutorHandler = (args: {
  payload: PublishedInteractionExecutionPayload;
  runtime: PublishedInteractionTrustedRuntime;
  executionIndex: number;
}) => PublishedInteractionExecutionResult | Promise<PublishedInteractionExecutionResult>;

export class FakePublishedInteractionExecutor
  implements PublishedInteractionExecutor
{
  readonly executions: PublishedInteractionExecutionPayload[] = [];
  private readonly handler: FakePublishedInteractionExecutorHandler;

  constructor(
    handler: FakePublishedInteractionExecutorHandler = async ({
      payload,
    }) => ({
      status: "ok",
      output: payload.input,
    }),
  ) {
    this.handler = handler;
  }

  async execute(
    payload: PublishedInteractionExecutionPayload,
    runtime: PublishedInteractionTrustedRuntime,
  ): Promise<PublishedInteractionExecutionResult> {
    const executionIndex = this.executions.length;
    this.executions.push(payload);

    return this.handler({
      payload,
      runtime,
      executionIndex,
    });
  }
}

export function createFakePublishedInteractionExecutor(
  handler?: FakePublishedInteractionExecutorHandler,
): FakePublishedInteractionExecutor {
  return new FakePublishedInteractionExecutor(handler);
}

export function createPublishedInteractionActionCallToken(
  invocationId: string,
): PublishedInteractionActionCallToken {
  return `tidegate-action-call:${invocationId}:${crypto.randomUUID()}` as PublishedInteractionActionCallToken;
}

export function createPublishedInteractionExecutionPayload({
  actionCallToken,
  artifact,
  artifactSource,
  auth,
  effectiveCapabilities,
  input,
  invocationId,
}: {
  actionCallToken: PublishedInteractionActionCallToken;
  artifact: PublishedInteractionArtifact;
  artifactSource?: PublishedInteractionArtifactSource;
  auth: RuntimeAuthContext;
  /**
   * The per-execution effective capability set (#28). When provided (the
   * runtime invoke path always does), BOTH `capabilities.actionIds` and
   * `allowedActionIds` are derived from its declared surface — the same
   * object the trusted action caller enforces against — so injection and
   * enforcement cannot diverge and `capabilitiesMatchAllowedActions` cannot
   * trip. The declared surface must equal the artifact allowlist exactly
   * (withheld actions keep their slot as denied stubs; the set can only
   * restrict what a call is allowed to do, never reshape the surface).
   */
  effectiveCapabilities?: EffectiveCapabilitySet;
  input: InvokeInteractionRequest["input"];
  invocationId: string;
}): PublishedInteractionExecutionPayload {
  const allowedActionIds =
    effectiveCapabilities === undefined
      ? artifact.allowedActions.map((action) => action.id)
      : effectiveCapabilityIdsForArtifact(effectiveCapabilities, artifact);
  const executionArtifactSource =
    artifactSource ?? createArtifactSourceSnapshot(artifact);
  assertArtifactSourceMatchesArtifact(executionArtifactSource, artifact);
  const payload = {
    artifact: executionArtifactSource,
    input,
    auth,
    capabilities: {
      schemaVersion: "tidegate.generatedCapabilities.v1" as const,
      actionCatalogId: artifact.actionCatalogId,
      actionCatalogVersion: artifact.actionCatalogVersion,
      actionIds: allowedActionIds,
    },
    allowedActionIds,
    invocationId,
    timeout: artifact.timeout,
    actionCallToken,
  };

  return immutableClone(payload);
}

/**
 * Fails closed when the effective set does not belong to this artifact: the
 * set must have been computed for the same interaction id/version and its
 * declared surface must be exactly the artifact allowlist — never widened
 * (an unpublished capability can never be injected) and never narrowed (a
 * declared-but-denied action keeps its slot as a denied stub; dropping it
 * would change generated code's failure mode from the structured
 * `permission_denied` to a missing-property `interaction_failed`).
 */
function effectiveCapabilityIdsForArtifact(
  effectiveCapabilities: EffectiveCapabilitySet,
  artifact: PublishedInteractionArtifact,
): string[] {
  const artifactActionIds = artifact.allowedActions.map((action) => action.id);

  if (
    effectiveCapabilities.interactionId !== artifact.id ||
    effectiveCapabilities.interactionVersion !== artifact.version ||
    effectiveCapabilities.declaredActionIds.length !==
      artifactActionIds.length ||
    effectiveCapabilities.declaredActionIds.some(
      (actionId, index) => actionId !== artifactActionIds[index],
    )
  ) {
    throw new Error(
      "Published interaction execution payload requires an effective capability set computed for this artifact's published allowlist.",
    );
  }

  return [...effectiveCapabilities.declaredActionIds];
}

function createArtifactSourceSnapshot(
  artifact: PublishedInteractionArtifact,
): PublishedInteractionArtifactSource {
  return {
    kind: "source_snapshot",
    id: artifact.id,
    version: artifact.version,
    sourceHash: artifact.sourceHash,
    source: artifact.source,
    actionCatalogId: artifact.actionCatalogId,
    actionCatalogVersion: artifact.actionCatalogVersion,
  };
}

function assertArtifactSourceMatchesArtifact(
  artifactSource: PublishedInteractionArtifactSource,
  artifact: PublishedInteractionArtifact,
) {
  if (
    artifactSource.id !== artifact.id ||
    artifactSource.version !== artifact.version ||
    artifactSource.sourceHash !== artifact.sourceHash ||
    artifactSource.actionCatalogId !== artifact.actionCatalogId ||
    artifactSource.actionCatalogVersion !== artifact.actionCatalogVersion
  ) {
    throw new Error(
      "Published interaction executor artifact source must match the immutable artifact identity.",
    );
  }
}

function immutableClone<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value)) as DeepReadonly<T>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  for (const key of Reflect.ownKeys(value)) {
    const item = (value as Record<PropertyKey, unknown>)[key];
    deepFreeze(item);
  }

  return Object.freeze(value);
}
