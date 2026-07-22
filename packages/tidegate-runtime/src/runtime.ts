import {
  TidegateAuthContextSchema,
  InvokeInteractionErrorCodeSchema,
  InvokeInteractionRequestSchema,
  InvokeInteractionResponseSchema,
  legacyPublicInteractionConfirmPath,
  type GeneratedInteractionContractV1,
  type InteractionAvailabilityStatus,
  type InvokeInteractionErrorCode,
  type InvokeInteractionRequest,
  type InvokeInteractionResponse,
  type JsonSchema,
  type PublishedInteractionArtifact,
} from "@tidegate/contracts";
import type {
  AnyRuntimeAction,
  RuntimeAuthContext,
} from "./action-catalog.ts";
import {
  CONFIRMATION_TOKEN_TTL_MS,
  hashConfirmationInput,
  mintConfirmationToken,
  resolveConfirmationSecret,
  verifyConfirmationToken,
  type ConfirmationTokenBinding,
} from "./confirmation-token.ts";
import {
  computeEffectiveCapabilitySet,
  type EffectiveCapabilitySet,
} from "./effective-capabilities.ts";
import {
  createExecutionAuthorityGuard,
  type ExecutionAuthorityGuard,
  type ExecutionAuthorityPorts,
} from "./execution-authority.ts";
import {
  resolveAuthSubject,
  resolveAuthTenant,
} from "./interaction-action-policy.ts";
import type { StaticInteraction } from "./interaction-registry.ts";
import {
  applyConstraints,
  decidePolicy,
  INVOKE_POLICY_DENY_CODES,
  type PolicyConfirmationTokenState,
  type PolicyConstraint,
  type PolicyInteractionHeader,
} from "./policy-engine.ts";
import { validateJsonSchemaValue } from "./json-schema-runtime.ts";
import {
  createPublishedInteractionActionCallToken,
  createPublishedInteractionExecutionPayload,
  type PublishedInteractionExecutionResult,
  type PublishedInteractionExecutor,
  type PublishedInteractionTrustedRuntime,
} from "./published-interaction-executor.ts";

type RuntimeErrorStatus = Extract<
  InvokeInteractionResponse["status"],
  "rejected" | "failed"
>;

type RuntimeErrorWithCode = Error & {
  code?: unknown;
  status?: unknown;
};

type IdempotencyRecord = {
  expiresAtMs: number;
  inputHash: string;
  result: Promise<InvokeInteractionResponse>;
};

type RuntimeInteractionAllowedAction = {
  id: string;
  maxCalls?: number;
  timeoutMs?: number;
};

type RuntimeInteractionPolicy = {
  id: string;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  allowedActions: readonly RuntimeInteractionAllowedAction[];
  effects: GeneratedInteractionContractV1["effects"];
  timeout: GeneratedInteractionContractV1["timeout"];
  confirmation: GeneratedInteractionContractV1["confirmation"];
  status?: InteractionAvailabilityStatus;
};

type RuntimePolicyExecutionContext = {
  auth: RuntimeAuthContext;
  callAction: (actionId: string, input: unknown) => Promise<unknown>;
  /**
   * The per-execution effective capability set (#28): computed once, before
   * execution starts, and consumed by BOTH sandbox capability injection and
   * the trusted action caller's enforcement, so the two cannot diverge.
   */
  effectiveCapabilities: EffectiveCapabilitySet;
  invocationId: string;
  signal: AbortSignal;
};

type RuntimePolicyExecute = (
  ctx: RuntimePolicyExecutionContext,
) => Promise<PublishedInteractionExecutionResult>;

export type PublishedInteractionResolver = (args: {
  interactionId: string;
  request: InvokeInteractionRequest;
  auth: RuntimeAuthContext;
}) =>
  | PublishedInteractionArtifact
  | undefined
  | Promise<PublishedInteractionArtifact | undefined>;

const IDEMPOTENCY_RECORD_TTL_MS = 5 * 60 * 1000;
const MAX_IDEMPOTENCY_RECORDS = 1000;

const REJECTED_ERROR_CODES = new Set<InvokeInteractionErrorCode>([
  "interaction_not_found",
  "interaction_version_mismatch",
  "interaction_unavailable",
  "interaction_revoked",
  "invalid_request",
  "auth_required",
  "tenant_mismatch",
  "permission_denied",
  "idempotency_key_required",
  "confirmation_required",
  "confirmation_invalid",
  "confirmation_expired",
  "confirmation_input_mismatch",
  "action_not_allowed",
  "action_not_registered",
]);

function createInvocationId(request?: InvokeInteractionRequest): string {
  return request?.invocationId ?? crypto.randomUUID();
}

function responseWithError({
  code,
  invocationId,
  message,
  request,
  retryable,
  status,
}: {
  code: InvokeInteractionErrorCode;
  invocationId?: string;
  message: string;
  request?: InvokeInteractionRequest;
  retryable?: boolean;
  status: RuntimeErrorStatus;
}): InvokeInteractionResponse {
  return InvokeInteractionResponseSchema.parse({
    status,
    invocationId: invocationId ?? createInvocationId(request),
    error: {
      code,
      message,
      retryable,
    },
  });
}

function runtimeError(
  code: InvokeInteractionErrorCode,
  message: string,
  status?: RuntimeErrorStatus,
): RuntimeErrorWithCode {
  return Object.assign(new Error(message), {
    code,
    status,
  });
}

function timedOutResponse(
  request: InvokeInteractionRequest,
  invocationId?: string,
): InvokeInteractionResponse {
  return InvokeInteractionResponseSchema.parse({
    status: "timed_out",
    invocationId: invocationId ?? createInvocationId(request),
    error: {
      code: "interaction_timeout",
      message: "The interaction timed out.",
      retryable: false,
    },
  });
}

function normalizeThrownError(error: unknown): {
  code: InvokeInteractionErrorCode;
  status: RuntimeErrorStatus;
} {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return {
      code: "interaction_failed",
      status: "failed",
    };
  }

  const codeResult = InvokeInteractionErrorCodeSchema.safeParse(
    (error as RuntimeErrorWithCode).code,
  );

  if (!codeResult.success) {
    return {
      code: "interaction_failed",
      status: "failed",
    };
  }

  const explicitStatus = (error as RuntimeErrorWithCode).status;

  if (explicitStatus === "rejected" || explicitStatus === "failed") {
    return {
      code: codeResult.data,
      status: explicitStatus,
    };
  }

  return {
    code: codeResult.data,
    status: REJECTED_ERROR_CODES.has(codeResult.data) ? "rejected" : "failed",
  };
}

function buildConfirmationResponse({
  binding,
  interactionId,
  message,
  nowMs,
  request,
  secret,
}: {
  binding: ConfirmationTokenBinding;
  interactionId: string;
  /** Confirmation prompt from the policy engine's `confirm` decision. */
  message: string;
  nowMs: number;
  request: InvokeInteractionRequest;
  secret: string;
}): InvokeInteractionResponse {
  const expiresAtMs = nowMs + CONFIRMATION_TOKEN_TTL_MS;
  const confirmationToken = mintConfirmationToken({
    claims: {
      v: 1,
      ...binding,
      expiresAtMs,
    },
    secret,
  });

  return InvokeInteractionResponseSchema.parse({
    status: "confirmation_required",
    invocationId: createInvocationId(request),
    confirmation: {
      message,
      confirmationToken,
      inputHash: binding.inputHash,
      inputSummary: summarizeInput(request.input),
      expiresAt: new Date(expiresAtMs).toISOString(),
      // Deprecated and advisory only: confirmation is completed by re-POSTing
      // the identical /invoke request with `confirmationToken` added; no
      // dedicated /confirm route exists.
      confirmRoute: legacyPublicInteractionConfirmPath({ interactionId }),
    },
  });
}

function summarizeInput(value: unknown): Array<{ path: string; value: unknown }> {
  if (!isRecord(value)) {
    return [{ path: "/", value }];
  }

  return Object.entries(value).map(([key, item]) => ({
    path: `/${key}`,
    value: item,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>({
  onTimeout,
  operation,
  timeoutMs,
}: {
  onTimeout?: () => void;
  operation: Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(
        runtimeError(
          "interaction_timeout",
          "The interaction exceeded its execution timeout.",
          "failed",
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function authIdempotencyScope(auth: RuntimeAuthContext): string {
  return [resolveAuthTenant(auth), resolveAuthSubject(auth)].join("|");
}

function pruneIdempotencyRecords(
  records: Map<string, IdempotencyRecord>,
  nowMs: number,
) {
  for (const [key, record] of records) {
    if (record.expiresAtMs <= nowMs) {
      records.delete(key);
    }
  }

  while (records.size > MAX_IDEMPOTENCY_RECORDS) {
    const oldestKey = records.keys().next().value;

    if (oldestKey === undefined) {
      return;
    }

    records.delete(oldestKey);
  }
}

function policyFromStaticInteraction(
  interaction: StaticInteraction,
): RuntimeInteractionPolicy {
  return {
    id: interaction.contract.id,
    version: interaction.contract.version,
    inputSchema: interaction.contract.input.schema,
    outputSchema: interaction.contract.output.schema,
    allowedActions: interaction.contract.allowedActions,
    effects: interaction.contract.effects,
    timeout: interaction.contract.timeout,
    confirmation: interaction.contract.confirmation,
  };
}

function policyFromPublishedArtifact(
  artifact: PublishedInteractionArtifact,
): RuntimeInteractionPolicy {
  return {
    id: artifact.id,
    version: artifact.version,
    inputSchema: artifact.inputSchema,
    outputSchema: artifact.outputSchema,
    allowedActions: artifact.allowedActions,
    effects: artifact.effects,
    timeout: artifact.timeout,
    confirmation: artifact.confirmation,
    status: artifact.status,
  };
}

function createTrustedRuntimeActionCaller({
  actions,
  auth,
  constraints,
  effectiveCapabilities,
  guard,
  invocationId,
  now,
  policy,
  policyHeader,
  signal,
}: {
  actions: Map<string, AnyRuntimeAction>;
  auth: RuntimeAuthContext;
  /** Constraints from the envelope policy decision (the action-call budget). */
  constraints: readonly PolicyConstraint[];
  /**
   * The per-execution effective capability set (#28) — the SAME object the
   * sandbox capability injection was derived from. Withheld capabilities
   * fail here with their precomputed structured error (the denied-stub
   * behavior); the live checks below remain as defense in depth.
   */
  effectiveCapabilities: EffectiveCapabilitySet;
  /**
   * Live execution-authority guard (#25). Consulted at this choke point before
   * every action call to produce the live-state snapshot the policy engine
   * reads (revocation + cumulative budget). Enforced DURING execution, so the
   * sandbox path — which routes here via `callAction` — cannot bypass it.
   */
  guard: ExecutionAuthorityGuard;
  invocationId: string;
  now: () => number;
  policy: RuntimeInteractionPolicy;
  policyHeader: PolicyInteractionHeader;
  signal: AbortSignal;
}) {
  const allowedActionsById = new Map(
    policy.allowedActions.map((action) => [action.id, action]),
  );
  const allowedActionIds = [...allowedActionsById.keys()];
  // Constraint enforcement is owned by the policy engine: action calls can
  // only be admitted through the constrained execution context.
  const constrained = applyConstraints(constraints);

  return {
    allowedActionIds,
    call: async (actionId: string, input: unknown) => {
      if (signal.aborted) {
        throw runtimeError(
          "interaction_timeout",
          "This interaction is no longer accepting action calls.",
          "failed",
        );
      }

      const allowedAction = allowedActionsById.get(actionId);

      if (!allowedAction) {
        throw runtimeError(
          "action_not_allowed",
          "This interaction cannot call the requested action.",
          "rejected",
        );
      }

      const budget = constrained.registerActionCall(actionId);

      if (!budget.ok) {
        throw runtimeError("action_not_allowed", budget.message, "rejected");
      }

      // Snapshot gate (#28): the effective set was computed once at
      // execution start from the same engine rules the live checks below
      // apply. A withheld capability is still injected into the sandbox
      // (the declared surface never narrows) but calling it throws the same
      // structured error the live path produces — the denied-stub contract.
      const effectiveCapability =
        effectiveCapabilities.capabilities.get(actionId);

      if (effectiveCapability === undefined) {
        // Fail closed: the set is computed from this policy's allowlist, so
        // a missing entry means the set does not belong to this execution.
        throw runtimeError(
          "action_not_allowed",
          "This interaction cannot call the requested action.",
          "rejected",
        );
      }

      if (effectiveCapability.status === "withheld") {
        throw runtimeError(
          effectiveCapability.code,
          effectiveCapability.message,
          "rejected",
        );
      }

      // Live defense in depth: a granted capability still requires the
      // action to exist in the live catalog at call time, so removal
      // mid-execution fails closed. But what EXECUTES is the snapshotted
      // action ref — the effective set is frozen at execution start, so a
      // catalog entry replaced mid-execution can never swap in a new
      // implementation or new schemas for this execution.
      if (!actions.has(actionId)) {
        throw runtimeError(
          "action_not_registered",
          "This action is not registered.",
          "rejected",
        );
      }

      const action = effectiveCapability.action;

      // #25 live-state seam: consult the execution-authority guard AFTER the
      // static counter / effective-capability gates (so we never debit budget
      // for a call the frozen limits already reject) and right before the final
      // policy decision + effect. The guard attempts the budget debit and the
      // revocation read, folding both into the snapshot the pure engine reads —
      // the single decision stays source of truth (no second scattered check).
      const authorization = await guard.authorizeActionCall({
        actionId,
        now: now(),
      });

      // Finding #2: a refund port that throws must NOT mask the structured
      // rejection it is being called for. Refunding is a best-effort cleanup of
      // an uncharged pre-dispatch debit; if it rejects we log and still throw
      // the intended structured error, so the caller sees the real reason (deny
      // / schema-invalid) rather than an opaque refund failure.
      const settleWithoutMasking = async (): Promise<void> => {
        try {
          await authorization.settle.refundIfUncharged();
        } catch (error) {
          console.warn(
            "execution-authority refund port threw during settle; proceeding with the structured rejection",
            error,
          );
        }
      };

      const decision = decidePolicy({
        kind: "action",
        phase: "invoke",
        auth,
        interaction: policyHeader,
        action,
        allowedAction,
        input,
        liveState: authorization.liveState,
        now: now(),
      });

      if (decision.outcome === "deny") {
        // Refund a debit that never reached an effect. Live denials (revoked /
        // budget) charged nothing, so this is a no-op for them; a
        // permission/effect/tenant deny that rode past a successful debit is
        // refunded here (pre-dispatch, so the refund is safe).
        await settleWithoutMasking();
        throw runtimeError(
          INVOKE_POLICY_DENY_CODES[decision.reason],
          decision.message,
          "rejected",
        );
      }

      const parsedInputResult = action.inputSchema.safeParse(input);

      if (!parsedInputResult.success) {
        await settleWithoutMasking();
        throw runtimeError(
          "action_input_invalid",
          "Action input is invalid.",
          "failed",
        );
      }

      const actionAbortController = new AbortController();
      const abortActionFromInteraction = () => actionAbortController.abort();

      if (signal.aborted) {
        actionAbortController.abort();
      } else {
        signal.addEventListener("abort", abortActionFromInteraction, {
          once: true,
        });
      }

      let result: unknown;

      try {
        result = await withTimeout({
          onTimeout: () => actionAbortController.abort(),
          timeoutMs:
            allowedAction.timeoutMs ??
            policy.timeout.perActionMs ??
            policy.timeout.executionMs,
          operation: action.execute({
            input: parsedInputResult.data,
            auth,
            interaction: {
              id: policy.id,
              version: policy.version,
              allowedActionIds,
            },
            invocationId,
            signal: actionAbortController.signal,
          }),
        });
      } finally {
        signal.removeEventListener("abort", abortActionFromInteraction);
      }

      const parsedOutputResult = action.outputSchema.safeParse(result);

      if (!parsedOutputResult.success) {
        throw runtimeError(
          "action_output_invalid",
          "Action output is invalid.",
          "failed",
        );
      }

      return parsedOutputResult.data;
    },
  };
}

function responseFromExecutionResult({
  invocationId,
  policy,
  request,
  result,
}: {
  invocationId: string;
  policy: RuntimeInteractionPolicy;
  request: InvokeInteractionRequest;
  result: PublishedInteractionExecutionResult;
}): InvokeInteractionResponse {
  switch (result.status) {
    case "timed_out":
      return timedOutResponse(request, invocationId);
    case "rejected":
    case "failed":
      return responseWithError({
        code: result.error.code,
        invocationId,
        message: result.error.message,
        request,
        retryable: result.error.retryable,
        status: result.status,
      });
    case "ok":
      if (!validateJsonSchemaValue(result.output, policy.outputSchema)) {
        return responseWithError({
          code: "output_schema_invalid",
          invocationId,
          message: "Interaction output does not match the contract schema.",
          request,
          retryable: false,
          status: "failed",
        });
      }

      return InvokeInteractionResponseSchema.parse({
        status: "ok",
        invocationId,
        auditId: result.auditId,
        output: result.output,
      });
  }
}

async function invokeWithRuntimePolicy({
  actions,
  auth,
  confirmationSecret,
  execute,
  executionAuthority,
  idempotencyRecords,
  interactionId,
  now,
  policy,
  request,
}: {
  actions: Map<string, AnyRuntimeAction>;
  auth: RuntimeAuthContext;
  confirmationSecret?: string;
  execute: RuntimePolicyExecute;
  /**
   * Optional injected live-state ports (#25): revocation + cumulative budget.
   * When absent the per-invocation guard is a no-op and behavior is identical
   * to today (frozen static limits only).
   */
  executionAuthority?: ExecutionAuthorityPorts;
  idempotencyRecords: Map<string, IdempotencyRecord>;
  interactionId: string;
  now: () => number;
  policy: RuntimeInteractionPolicy;
  request: InvokeInteractionRequest;
}): Promise<InvokeInteractionResponse> {
  // Kernel-supplied confirmation token state (#24 seam): the policy engine
  // never sees token bytes, only whether one was presented and — after the
  // kernel verifies it — the verification result.
  const initialTokenState: PolicyConfirmationTokenState =
    request.confirmationToken === undefined
      ? { presented: false, verified: false }
      : { presented: true, verified: false, failure: null };

  const policyHeader = (
    token: PolicyConfirmationTokenState,
  ): PolicyInteractionHeader => ({
    id: policy.id,
    version: policy.version,
    declaredEffect: policy.effects.declared,
    riskLevel: policy.effects.riskLevel,
    idempotency: policy.effects.idempotency,
    confirmation: {
      required: policy.confirmation.required,
      message: policy.confirmation.message,
      token,
    },
    status: policy.status,
  });

  // Envelope admission (availability, version, idempotency) plus the
  // action-call budget, decided by the single policy engine.
  const envelopeDecision = decidePolicy({
    kind: "envelope",
    phase: "invoke",
    auth,
    interaction: policyHeader(initialTokenState),
    request: {
      interactionVersion: request.interactionVersion,
      idempotencyKey: request.idempotencyKey,
    },
    budget: {
      maxActionCalls: policy.timeout.maxActionCalls,
      allowedActions: policy.allowedActions,
    },
    now: now(),
  });

  if (envelopeDecision.outcome === "deny") {
    return responseWithError({
      code: INVOKE_POLICY_DENY_CODES[envelopeDecision.reason],
      message: envelopeDecision.message,
      request,
      status: "rejected",
    });
  }

  const invocationConstraints =
    envelopeDecision.outcome === "constrain"
      ? envelopeDecision.constraints
      : [];

  // Input-schema validation runs BEFORE the confirmation gate so a token is
  // never minted for schema-invalid input: the signed request is always a
  // schema-valid request.
  if (!validateJsonSchemaValue(request.input, policy.inputSchema)) {
    return responseWithError({
      code: "input_schema_invalid",
      message: "Interaction input does not match the contract schema.",
      request,
      status: "rejected",
    });
  }

  // The idempotency ledger is consulted BEFORE the confirmation gate: a
  // ledger hit means this exact request (same tenant|subject scope,
  // interaction id+version, idempotency key, and input hash) already
  // executed, so the cached result is returned without re-checking the
  // confirmation token. Otherwise an idempotent retry of a completed
  // confirmed invocation would fail with `confirmation_expired` once the
  // token TTL (5 min) passes, even while the idempotency record is still
  // alive. This is safe: no new effect runs on a ledger hit, a key reused
  // with different input is still rejected, and a ledger miss falls through
  // to the full confirmation gate (an expired token with a fresh key is
  // still `confirmation_expired`).
  const ledger =
    (policy.effects.idempotency === "required" ||
      policy.confirmation.required) &&
    request.idempotencyKey
      ? {
          inputHash: hashConfirmationInput(request.input),
          recordKey: [
            authIdempotencyScope(auth),
            policy.id,
            policy.version,
            request.idempotencyKey,
          ].join(":"),
        }
      : undefined;

  if (ledger) {
    pruneIdempotencyRecords(idempotencyRecords, now());
    const existing = idempotencyRecords.get(ledger.recordKey);

    if (existing) {
      if (existing.inputHash !== ledger.inputHash) {
        return responseWithError({
          code: "invalid_request",
          message: "The idempotency key was already used with different input.",
          request,
          status: "rejected",
        });
      }

      return existing.result;
    }
  }

  // Confirmation gate: the policy engine decides (confirm / deny / allow);
  // the kernel owns the #24 mechanics — minting tokens, resolving the HMAC
  // secret, and verifying presented tokens — and reports the verification
  // result back into the engine's decision request.
  const confirmationRequest = (token: PolicyConfirmationTokenState) =>
    decidePolicy({
      kind: "confirmation",
      phase: "invoke",
      auth,
      interaction: policyHeader(token),
      request: { idempotencyKey: request.idempotencyKey },
      now: now(),
    });

  const resolveSecret = ():
    | { ok: true; secret: string }
    | { ok: false; response: InvokeInteractionResponse } => {
    try {
      // `||`, not `??`: an empty-string secret must never be used as an HMAC
      // key (it would be forgeable), so it falls through to env resolution.
      return { ok: true, secret: confirmationSecret || resolveConfirmationSecret() };
    } catch (error) {
      return {
        ok: false,
        response: responseWithError({
          code: "interaction_failed",
          message:
            error instanceof Error
              ? error.message
              : "The confirmation secret is not configured.",
          request,
          retryable: false,
          status: "failed",
        }),
      };
    }
  };

  const confirmationBinding = (): ConfirmationTokenBinding => ({
    interactionId: policy.id,
    interactionVersion: policy.version,
    inputHash: hashConfirmationInput(request.input),
    subject: resolveAuthSubject(auth),
    tenant: resolveAuthTenant(auth),
    sessionId: request.sessionId,
  });

  let confirmationDecision = confirmationRequest(initialTokenState);

  if (
    confirmationDecision.outcome === "allow" &&
    policy.confirmation.required &&
    initialTokenState.presented &&
    request.confirmationToken !== undefined
  ) {
    // Preconditions passed and a token was presented: verify it (kernel-side,
    // #24), then re-consult the engine with the verification result. The
    // engine's confirmation rule keys off `verified`, so a verified re-run
    // does not re-trigger `confirm`.
    const resolvedSecret = resolveSecret();

    if (!resolvedSecret.ok) {
      return resolvedSecret.response;
    }

    const verification = verifyConfirmationToken({
      expected: confirmationBinding(),
      nowMs: now(),
      secret: resolvedSecret.secret,
      token: request.confirmationToken,
    });

    confirmationDecision = confirmationRequest(
      verification.ok
        ? { presented: true, verified: true }
        : { presented: true, verified: false, failure: verification.reason },
    );
  }

  if (confirmationDecision.outcome === "deny") {
    return responseWithError({
      code: INVOKE_POLICY_DENY_CODES[confirmationDecision.reason],
      message: confirmationDecision.message,
      request,
      status: "rejected",
    });
  }

  if (confirmationDecision.outcome === "confirm") {
    const resolvedSecret = resolveSecret();

    if (!resolvedSecret.ok) {
      return resolvedSecret.response;
    }

    return buildConfirmationResponse({
      binding: confirmationBinding(),
      interactionId,
      message: confirmationDecision.confirmation.message,
      nowMs: now(),
      request,
      secret: resolvedSecret.secret,
    });
  }

  // Allowed (confirmation not required, or the token verified): fall through
  // to execution.

  // #28: compute the effective capability set — published allowlist ∩ caller
  // permissions ∩ tenant scope, decided per action by the policy engine —
  // ONCE per execution. The same object drives sandbox capability injection
  // (via the execution context) and call-time enforcement (via the trusted
  // action caller), so injection and enforcement cannot diverge. It can only
  // restrict the published allowlist, never widen it, and the live per-call
  // checks stay in place as defense in depth.
  const effectiveCapabilities = computeEffectiveCapabilitySet({
    actions,
    allowedActions: policy.allowedActions,
    auth,
    interaction: policyHeader(initialTokenState),
    now: now(),
  });

  const runInteraction = async (): Promise<InvokeInteractionResponse> => {
    const invocationId = createInvocationId(request);
    const interactionAbortController = new AbortController();
    // #25: build the per-invocation live-authority guard from the freshly
    // minted invocationId. When no ports are injected the guard is a no-op and
    // the action caller behaves exactly like today.
    const guard = createExecutionAuthorityGuard({
      identity: {
        invocationId,
        interactionId: policy.id,
        interactionVersion: policy.version,
        auth,
      },
      revocation: executionAuthority?.revocation,
      budget: executionAuthority?.budget,
      budgetPolicy: executionAuthority?.budgetPolicy,
      onEvent: executionAuthority?.onEvent,
    });
    const actionCaller = createTrustedRuntimeActionCaller({
      actions,
      auth,
      constraints: invocationConstraints,
      effectiveCapabilities,
      guard,
      invocationId,
      now,
      policy,
      policyHeader: policyHeader(initialTokenState),
      signal: interactionAbortController.signal,
    });

    try {
      const result = await withTimeout({
        onTimeout: () => interactionAbortController.abort(),
        timeoutMs: policy.timeout.executionMs,
        operation: execute({
          auth,
          callAction: actionCaller.call,
          effectiveCapabilities,
          invocationId,
          signal: interactionAbortController.signal,
        }),
      });

      return responseFromExecutionResult({
        invocationId,
        policy,
        request,
        result,
      });
    } catch (error) {
      const normalized = normalizeThrownError(error);

      if (normalized.code === "interaction_timeout") {
        return timedOutResponse(request, invocationId);
      }

      return responseWithError({
        code: normalized.code,
        invocationId,
        message:
          normalized.status === "rejected"
            ? "This interaction is not allowed for the current request."
            : "The interaction failed.",
        request,
        retryable: false,
        status: normalized.status,
      });
    }
  };

  if (ledger) {
    // The lookup above already established a ledger miss; everything between
    // it and here is synchronous, so no concurrent invoke can have written
    // this key in the meantime.
    const pending = runInteraction();
    idempotencyRecords.set(ledger.recordKey, {
      expiresAtMs: now() + IDEMPOTENCY_RECORD_TTL_MS,
      inputHash: ledger.inputHash,
      result: pending,
    });
    return pending;
  }

  return runInteraction();
}

export function createTidegateRuntime({
  actions,
  confirmationSecret,
  executionAuthority,
  interactions,
  now = Date.now,
  publishedInteractionExecutor,
  publishedInteractionResolver,
  publishedInteractions = new Map(),
}: {
  actions: Map<string, AnyRuntimeAction>;
  /**
   * Confirmation-token signing secret. When omitted or empty, resolves
   * `TIDEGATE_CONFIRMATION_SECRET` from the environment at mint/verify time
   * (an empty string is never a valid HMAC key).
   */
  confirmationSecret?: string;
  /**
   * Optional live-state ports (#25) consulted at each action call: a
   * `RevocationChecker` (authority withdrawn mid-run → deny next call) and a
   * `BudgetLedger` (cumulative/shared budget exhausted → deny next call). Both
   * optional; when omitted the runtime enforces only the frozen static limits,
   * exactly as before. The persistent stores are #44 — the app supplies
   * in-memory reference impls today.
   */
  executionAuthority?: ExecutionAuthorityPorts;
  interactions: Map<string, StaticInteraction>;
  /** Injectable clock used by both confirmation expiry and idempotency TTL. */
  now?: () => number;
  publishedInteractionExecutor?: PublishedInteractionExecutor;
  publishedInteractionResolver?: PublishedInteractionResolver;
  publishedInteractions?: Map<string, PublishedInteractionArtifact>;
}) {
  const idempotencyRecords = new Map<string, IdempotencyRecord>();

  return {
    async invokeInteraction(args: {
      interactionId: string;
      request: unknown;
      auth: RuntimeAuthContext;
    }): Promise<InvokeInteractionResponse> {
      const parsedRequest = InvokeInteractionRequestSchema.safeParse(
        args.request,
      );

      if (!parsedRequest.success) {
        return responseWithError({
          code: "invalid_request",
          message: "The interaction request is invalid.",
          status: "rejected",
        });
      }

      const request = parsedRequest.data;
      const parsedAuth = TidegateAuthContextSchema.safeParse(args.auth);

      if (!parsedAuth.success) {
        return responseWithError({
          code: "auth_required",
          message: "A valid server-derived auth context is required.",
          request,
          status: "rejected",
        });
      }

      const auth = parsedAuth.data;
      const artifact =
        publishedInteractions.get(args.interactionId) ??
        (await publishedInteractionResolver?.({
          interactionId: args.interactionId,
          request,
          auth,
        }));

      if (artifact) {
        if (artifact.id !== args.interactionId) {
          return responseWithError({
            code: "interaction_unavailable",
            message:
              "This interaction artifact does not match the requested interaction.",
            request,
            status: "rejected",
          });
        }

        if (!publishedInteractionExecutor) {
          return responseWithError({
            code: "interaction_unavailable",
            message: "This interaction does not have an executor.",
            request,
            status: "rejected",
          });
        }

        const policy = policyFromPublishedArtifact(artifact);

        return invokeWithRuntimePolicy({
          actions,
          auth,
          confirmationSecret,
          execute: async (ctx) => {
            const actionCallToken = createPublishedInteractionActionCallToken(
              ctx.invocationId,
            );
            let actionCallsRevoked = false;
            const trustedRuntime: PublishedInteractionTrustedRuntime = {
              callAction: async (actionRequest) => {
                if (
                  actionCallsRevoked ||
                  ctx.signal.aborted ||
                  actionRequest.invocationId !== ctx.invocationId ||
                  actionRequest.actionCallToken !== actionCallToken
                ) {
                  throw runtimeError(
                    "action_not_allowed",
                    "This action call token is not valid for this invocation.",
                    "rejected",
                  );
                }

                return ctx.callAction(
                  actionRequest.actionId,
                  actionRequest.input,
                );
              },
            };

            try {
              return await publishedInteractionExecutor.execute(
                createPublishedInteractionExecutionPayload({
                  actionCallToken,
                  artifact,
                  auth: ctx.auth,
                  effectiveCapabilities: ctx.effectiveCapabilities,
                  input: request.input,
                  invocationId: ctx.invocationId,
                }),
                trustedRuntime,
              );
            } finally {
              actionCallsRevoked = true;
            }
          },
          executionAuthority,
          idempotencyRecords,
          interactionId: args.interactionId,
          now,
          policy,
          request,
        });
      }

      const interaction = interactions.get(args.interactionId);

      if (interaction) {
        const policy = policyFromStaticInteraction(interaction);

        return invokeWithRuntimePolicy({
          actions,
          auth,
          confirmationSecret,
          execute: async ({ auth: executionAuth, callAction, signal }) => ({
            status: "ok",
            output: await interaction.run(request.input, {
              auth: executionAuth,
              signal,
              actions: {
                call: callAction,
              },
            }),
          }),
          executionAuthority,
          idempotencyRecords,
          interactionId: args.interactionId,
          now,
          policy,
          request,
        });
      }

      return responseWithError({
        code: "interaction_not_found",
        message: "This interaction is not available.",
        request,
        status: "rejected",
      });
    },
  };
}
