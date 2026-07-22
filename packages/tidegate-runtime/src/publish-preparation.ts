import { createHash } from "node:crypto";
import {
  PublishInteractionRequestSchema,
  type EffectClass,
  type IdempotencyPolicy,
  type InteractionAuditPolicy,
  type InteractionConfirmation,
  type InteractionDraftProvenance,
  type InteractionOwner,
  type InteractionPolicySnapshot,
  type InteractionTimeout,
  type JsonSchema,
  type PublishedInteractionProvenance,
  type PublishInteractionProvenanceEvidence,
  type PublishInteractionRequest,
} from "@tidegate/contracts";
import type {
  AnyRuntimeAction,
  RuntimeAuthContext,
  RuntimeTenantScope,
} from "./action-catalog.ts";
import {
  decidePolicy,
  PUBLISH_POLICY_DENY_CODES,
} from "./policy-engine.ts";
import {
  publishGateDiagnostics,
  publishedProvenanceFromEvidence,
  type InteractionProvenanceActionCatalogMetadata,
  type PublishGateDiagnostic,
} from "./interaction-provenance.ts";
import {
  runPublishTypecheckGate,
  type PublishTypecheckDiagnostic,
} from "./publish-typecheck.ts";

const DEFAULT_ACTION_CALLS_PER_ACTION = 1;
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
const DEFAULT_PER_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_DESTRUCTIVE_CONFIRMATION_MESSAGE =
  "Confirm this interaction before continuing.";

const VALID_JSON_SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const RESERVED_ID_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export type PublishActionCatalogMetadata =
  InteractionProvenanceActionCatalogMetadata;

export type ResolvedPublishActionCatalog = {
  actionCatalog: Map<string, AnyRuntimeAction>;
  actionCatalogMetadata: PublishActionCatalogMetadata;
};

export type PublishIntentActionCatalogResolver =
  () => Promise<ResolvedPublishActionCatalog>;

export type PublishDiagnostic = PublishTypecheckDiagnostic | PublishGateDiagnostic;

export type PublishErrorCode =
  | "auth_required"
  | "permission_denied"
  | "invalid_request"
  | "interaction_conflict"
  | "interaction_failed";

export type PublishValidationError = Error & {
  code: PublishErrorCode;
  status: number;
  diagnostics?: PublishDiagnostic[];
};

export type PublishIdempotencyPolicyAdjustment = {
  code: "idempotency_required_for_effectful_actions";
  message: string;
  severity: "info";
};

export function publishError({
  code,
  diagnostics,
  message,
  status,
}: {
  code: PublishErrorCode;
  diagnostics?: PublishDiagnostic[];
  message: string;
  status: number;
}): PublishValidationError {
  return Object.assign(new Error(message), {
    code,
    diagnostics,
    status,
  });
}

export function publishRequestWithRequiredIdempotencyForAllowedActions({
  actionEffects,
  request,
}: {
  actionEffects: EffectClass[];
  request: PublishInteractionRequest;
}): {
  adjustments: PublishIdempotencyPolicyAdjustment[];
  request: PublishInteractionRequest;
} {
  const effectiveIdempotency = effectiveIdempotencyPolicy(
    request.effects.declared,
    request.effects.idempotency,
    actionEffects,
  );

  if (
    effectiveIdempotency !== "required" ||
    request.effects.idempotency === "required"
  ) {
    return {
      adjustments: [],
      request,
    };
  }

  return {
    adjustments: [
      {
        code: "idempotency_required_for_effectful_actions",
        message:
          "Set effects.idempotency to 'required' because this workspace declares effectful behavior or allows non-read actions.",
        severity: "info",
      },
    ],
    request: {
      ...request,
      effects: {
        ...request.effects,
        idempotency: "required",
      },
    },
  };
}

export function parsePublishRequest(body: unknown): PublishInteractionRequest {
  const parsedRequest = PublishInteractionRequestSchema.safeParse(body);

  if (!parsedRequest.success) {
    throw publishError({
      code: "invalid_request",
      message: "The publish request body is invalid.",
      status: 400,
    });
  }

  const request = parsedRequest.data;

  if (!isValidInteractionId(request.requestedInteractionId)) {
    throw publishError({
      code: "invalid_request",
      message: "The requested interaction id is invalid.",
      status: 400,
    });
  }

  if (request.source.trim().length === 0) {
    throw publishError({
      code: "invalid_request",
      message: "Interaction source is required.",
      status: 400,
    });
  }

  assertJsonSchemaIsPublishable("input", request.input);
  assertJsonSchemaIsPublishable("output", request.output);

  return request;
}

export async function preparePublishIntent({
  auth,
  body,
  resolveActionCatalog,
  source,
}: {
  auth: RuntimeAuthContext;
  body: unknown;
  resolveActionCatalog: PublishIntentActionCatalogResolver;
  source?: string;
}) {
  const publishRequest = parsePublishRequest(
    source === undefined ? body : publishRequestBodyWithSource({ body, source }),
  );
  const resolvedActionCatalog = await resolveActionCatalog();
  const prepared = await preparePublishedArtifact({
    actionCatalog: resolvedActionCatalog.actionCatalog,
    actionCatalogMetadata: resolvedActionCatalog.actionCatalogMetadata,
    auth,
    request: publishRequest,
  });

  return {
    ...prepared,
    publishRequest,
  };
}

async function preparePublishedArtifact({
  actionCatalog,
  actionCatalogMetadata,
  auth,
  request,
}: {
  actionCatalog: Map<string, AnyRuntimeAction>;
  actionCatalogMetadata: PublishActionCatalogMetadata;
  auth: RuntimeAuthContext;
  request: PublishInteractionRequest;
}) {
  const owner = ownerFromAuth(auth);
  const allowedActions = resolveAllowedActions({
    actionCatalog,
    auth,
    request,
  });
  const effectiveIdempotency = effectiveIdempotencyPolicy(
    request.effects.declared,
    request.effects.idempotency,
    allowedActions.map(({ action }) => action.effects),
  );

  if (
    effectiveIdempotency === "required" &&
    request.effects.idempotency !== "required"
  ) {
    throw publishError({
      code: "invalid_request",
      message:
        "This interaction must declare required idempotency for its allowed actions.",
      status: 400,
    });
  }

  const typecheckResult = await runPublishTypecheckGate({
    actionCatalogMetadata,
    actions: allowedActions.map(({ action }) => action),
    inputSchema: request.input,
    outputSchema: request.output,
    source: request.source,
  });

  if (!typecheckResult.ok) {
    throw publishError({
      code: "invalid_request",
      diagnostics: typecheckResult.diagnostics,
      message: "Interaction source failed publish typecheck.",
      status: 400,
    });
  }

  const preparedSourceHash = sourceHash(request.source);
  const provenance = publishedProvenanceFromPublishRequest({
    actionCatalogMetadata,
    request,
    sourceHash: preparedSourceHash,
  });

  return {
    owner,
    artifact: {
      id: request.requestedInteractionId,
      visibility: request.visibility,
      sourceHash: preparedSourceHash,
      source: request.source,
      actionCatalogId: actionCatalogMetadata.id,
      actionCatalogVersion: actionCatalogMetadata.version,
      allowedActions: allowedActions.map(({ action, requested }) => ({
        id: requested.id,
        reason: action.description,
        maxCalls: requested.maxCalls,
        timeoutMs: requested.timeoutMs,
      })),
      inputSchema: request.input,
      outputSchema: request.output,
      effects: request.effects,
      timeout: effectiveTimeout(request, allowedActions.length),
      confirmation: effectiveConfirmation(request),
      audit: effectiveAudit(request, allowedActions.map(({ action }) => action)),
      policy: policySnapshot(allowedActions.map(({ action }) => action)),
      ...(provenance === undefined ? {} : { provenance }),
    },
  };
}

function publishRequestBodyWithSource({
  body,
  source,
}: {
  body: unknown;
  source: string;
}) {
  if (!isRecord(body)) {
    throw publishError({
      code: "invalid_request",
      message: "The publish request body must be a JSON object.",
      status: 400,
    });
  }

  return {
    ...body,
    source,
  };
}

export function assertPublishGateGreen({
  actionCatalogMetadata,
  evidence,
  publishRequest,
  requireActionCatalogEvidence = false,
  requirePreview = false,
  sourceHash: expectedSourceHash,
}: {
  actionCatalogMetadata: PublishActionCatalogMetadata;
  evidence: PublishInteractionProvenanceEvidence | InteractionDraftProvenance | undefined;
  publishRequest: PublishInteractionRequest;
  requireActionCatalogEvidence?: boolean;
  requirePreview?: boolean;
  sourceHash: string;
}): PublishedInteractionProvenance {
  const diagnostics = publishGateDiagnostics({
    actionCatalogMetadata,
    evidence,
    publishRequest,
    requireActionCatalogEvidence,
    requirePreview,
    sourceHash: expectedSourceHash,
  });

  if (diagnostics.length > 0) {
    throw publishError({
      code: "invalid_request",
      diagnostics,
      message: "Interaction publish requires current green tests.",
      status: 400,
    });
  }

  return publishedProvenanceFromEvidence({
    actionCatalogMetadata,
    evidence: evidence as PublishInteractionProvenanceEvidence,
    sourceHash: expectedSourceHash,
  });
}

function publishedProvenanceFromPublishRequest({
  actionCatalogMetadata,
  request,
  sourceHash: preparedSourceHash,
}: {
  actionCatalogMetadata: PublishActionCatalogMetadata;
  request: PublishInteractionRequest;
  sourceHash: string;
}): PublishedInteractionProvenance | undefined {
  if (request.requireGreenTests === true) {
    return assertPublishGateGreen({
      actionCatalogMetadata,
      evidence: request.provenance,
      publishRequest: request,
      sourceHash: preparedSourceHash,
    });
  }

  if (request.provenance === undefined) {
    return undefined;
  }

  const diagnostics = publishGateDiagnostics({
    actionCatalogMetadata,
    evidence: request.provenance,
    publishRequest: request,
    sourceHash: preparedSourceHash,
  });

  return diagnostics.length === 0
    ? publishedProvenanceFromEvidence({
        actionCatalogMetadata,
        evidence: request.provenance,
        sourceHash: preparedSourceHash,
      })
    : undefined;
}

function resolveAllowedActions({
  actionCatalog,
  auth,
  request,
}: {
  actionCatalog: Map<string, AnyRuntimeAction>;
  auth: RuntimeAuthContext;
  request: PublishInteractionRequest;
}) {
  const seenActionIds = new Set<string>();

  return request.requestedAllowedActions.map((requested) => {
    if (seenActionIds.has(requested.id)) {
      throw publishError({
        code: "invalid_request",
        message: `Action "${requested.id}" is listed more than once.`,
        status: 400,
      });
    }

    seenActionIds.add(requested.id);

    const action = actionCatalog.get(requested.id);

    if (action === undefined) {
      throw publishError({
        code: "invalid_request",
        message: `Action "${requested.id}" is not in the effective action catalog.`,
        status: 400,
      });
    }

    // Publish-time admissibility is decided by the same policy engine as
    // invoke-time execution (`phase: "publish"`): effect ceiling, grants
    // (with wildcard matching — deliberately divergent from the invoke
    // phase's exact permission match), and tenant scope. The header is
    // synthetic: nothing is published yet, so there is no version or
    // availability status.
    const decision = decidePolicy({
      kind: "action",
      phase: "publish",
      auth,
      interaction: {
        id: request.requestedInteractionId,
        version: "unpublished",
        declaredEffect: request.effects.declared,
        riskLevel: request.effects.riskLevel,
        idempotency: request.effects.idempotency,
        confirmation: {
          required: false,
          message: null,
          token: { presented: false, verified: false },
        },
      },
      action,
      allowedAction: { id: requested.id, maxCalls: requested.maxCalls },
      input: undefined,
      // Reserved field; no publish rule reads the clock in this slice.
      now: 0,
    });

    if (decision.outcome === "deny") {
      const mapped = PUBLISH_POLICY_DENY_CODES[decision.reason];

      throw publishError({
        code: mapped.code,
        message: decision.message,
        status: mapped.status,
      });
    }

    return {
      requested,
      action,
    };
  });
}

function effectiveTimeout(
  request: PublishInteractionRequest,
  actionCount: number,
): InteractionTimeout {
  if (request.timeout !== undefined) {
    return request.timeout;
  }

  const maxActionCalls = request.requestedAllowedActions.reduce(
    (total, action) => total + (action.maxCalls ?? DEFAULT_ACTION_CALLS_PER_ACTION),
    0,
  );

  return {
    executionMs: DEFAULT_EXECUTION_TIMEOUT_MS,
    perActionMs: DEFAULT_PER_ACTION_TIMEOUT_MS,
    maxActionCalls: Math.max(maxActionCalls, actionCount, 1),
  };
}

function effectiveConfirmation(
  request: PublishInteractionRequest,
): InteractionConfirmation {
  const policyRequiresConfirmation =
    request.effects.declared === "destructive" || request.effects.riskLevel === "high";

  if (!policyRequiresConfirmation) {
    return request.confirmation ?? {
      required: false,
      message: null,
    };
  }

  return {
    required: true,
    message:
      request.confirmation?.message ?? DEFAULT_DESTRUCTIVE_CONFIRMATION_MESSAGE,
  };
}

function effectiveAudit(
  request: PublishInteractionRequest,
  actions: AnyRuntimeAction[],
): InteractionAuditPolicy {
  const redactPaths = uniqueStrings([
    ...(request.audit?.redactPaths ?? []),
    ...actions.flatMap((action) => action.audit?.redactPaths ?? []),
  ]);

  return {
    required:
      request.audit?.required ??
      actions.some((action) => action.audit?.required ?? action.effects !== "read"),
    redactPaths,
  };
}

function policySnapshot(
  actions: AnyRuntimeAction[],
): InteractionPolicySnapshot | undefined {
  const requiredPermissions = uniqueStrings(
    actions.flatMap((action) => action.requiredPermissions ?? []),
  );
  const tenantScopes = actions
    .map((action) => action.tenantScope)
    .filter(
      (tenantScope): tenantScope is RuntimeTenantScope =>
        tenantScope?.fromAuth !== undefined,
    );
  const firstTenantScope = tenantScopes[0];

  if (tenantScopes.some((tenantScope) => tenantScope.fromAuth !== firstTenantScope?.fromAuth)) {
    throw publishError({
      code: "invalid_request",
      message: "Requested actions require incompatible tenant scopes.",
      status: 400,
    });
  }

  if (requiredPermissions.length === 0 && firstTenantScope === undefined) {
    return undefined;
  }

  return {
    requiredPermissions,
    tenantScope:
      firstTenantScope?.fromAuth === undefined
        ? undefined
        : { fromAuth: firstTenantScope.fromAuth },
  };
}

function effectiveIdempotencyPolicy(
  declaredEffect: EffectClass,
  declaredPolicy: IdempotencyPolicy,
  actionEffects: EffectClass[],
): IdempotencyPolicy {
  if (
    declaredPolicy === "required" ||
    declaredEffect !== "read" ||
    actionEffects.some((effect) => effect !== "read")
  ) {
    return "required";
  }

  return declaredPolicy;
}

export function ownerFromAuth(auth: RuntimeAuthContext): InteractionOwner {
  return {
    tenantId: firstPresent(auth.tenantId, auth.salonId),
    organizationId: firstPresent(auth.organizationId, auth.orgId),
    userId: firstPresent(
      auth.userId,
      auth.workosUserId,
      auth.subjectType === "user" ? auth.subjectId : undefined,
    ),
  };
}

export function sourceHash(source: string) {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

export function isPublishValidationError(
  error: unknown,
): error is PublishValidationError {
  return (
    error instanceof Error &&
    typeof (error as Partial<PublishValidationError>).code === "string" &&
    typeof (error as Partial<PublishValidationError>).status === "number"
  );
}

function isValidInteractionId(interactionId: string) {
  const segments = interactionId.split(".");

  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment) &&
        !RESERVED_ID_SEGMENTS.has(segment),
    )
  );
}

function assertJsonSchemaIsPublishable(label: "input" | "output", schema: JsonSchema) {
  const issues = collectJsonSchemaIssues(schema, label);

  if (issues.length > 0) {
    throw publishError({
      code: "invalid_request",
      message: `${label} schema is invalid: ${issues[0]}`,
      status: 400,
    });
  }
}

function collectJsonSchemaIssues(schema: unknown, path: string): string[] {
  if (!isRecord(schema)) {
    return [`${path} must be a JSON Schema object.`];
  }

  const issues: string[] = [];

  if (typeof schema.$ref === "string") {
    issues.push(`${path} uses unsupported $ref.`);
  }

  if ("type" in schema && !schemaTypeIsValid(schema.type)) {
    issues.push(`${path}.type is unsupported.`);
  }

  if ("required" in schema && !stringArrayIsValid(schema.required)) {
    issues.push(`${path}.required must be an array of strings.`);
  }

  if ("properties" in schema) {
    if (!isRecord(schema.properties)) {
      issues.push(`${path}.properties must be an object.`);
    } else {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        issues.push(
          ...collectJsonSchemaIssues(propertySchema, `${path}.properties.${key}`),
        );
      }
    }
  }

  if ("items" in schema) {
    if (Array.isArray(schema.items)) {
      for (const [index, itemSchema] of schema.items.entries()) {
        issues.push(...collectJsonSchemaIssues(itemSchema, `${path}.items.${index}`));
      }
    } else if (isRecord(schema.items)) {
      issues.push(...collectJsonSchemaIssues(schema.items, `${path}.items`));
    } else {
      issues.push(`${path}.items must be a schema object or array of schemas.`);
    }
  }

  for (const unionKey of ["anyOf", "oneOf", "allOf"] as const) {
    if (!(unionKey in schema)) {
      continue;
    }

    const unionSchemas = schema[unionKey];

    if (!Array.isArray(unionSchemas)) {
      issues.push(`${path}.${unionKey} must be an array of schemas.`);
      continue;
    }

    for (const [index, itemSchema] of unionSchemas.entries()) {
      issues.push(
        ...collectJsonSchemaIssues(itemSchema, `${path}.${unionKey}.${index}`),
      );
    }
  }

  if (
    "additionalProperties" in schema &&
    typeof schema.additionalProperties !== "boolean" &&
    !isRecord(schema.additionalProperties)
  ) {
    issues.push(`${path}.additionalProperties must be a boolean or schema object.`);
  }

  if (isRecord(schema.additionalProperties)) {
    issues.push(
      ...collectJsonSchemaIssues(
        schema.additionalProperties,
        `${path}.additionalProperties`,
      ),
    );
  }

  return issues;
}

function schemaTypeIsValid(type: unknown) {
  if (typeof type === "string") {
    return VALID_JSON_SCHEMA_TYPES.has(type);
  }

  return (
    Array.isArray(type) &&
    type.length > 0 &&
    type.every(
      (item): item is string =>
        typeof item === "string" && VALID_JSON_SCHEMA_TYPES.has(item),
    )
  );
}

function stringArrayIsValid(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function firstPresent(...values: Array<string | undefined>) {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
