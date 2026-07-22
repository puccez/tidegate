import { z } from "zod";
import {
  TidegateAuthContextSchema,
  TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER,
  TIDEGATE_ACTION_AUTH_CONTEXT_HEADER,
  TIDEGATE_ACTION_INTERACTION_ID_HEADER,
  TIDEGATE_ACTION_BRIDGE_SECRET_HEADER,
  TidegateActionCatalogManifestV1Schema,
  TidegateActionIdSchema,
  TidegateActionErrorCodeSchema,
  TidegateActionInvokeRequestSchema,
  TidegateActionInvokeResponseSchema,
  type TidegateAuthContext,
  type TidegateActionAuditPolicy,
  type TidegateActionCatalogManifestV1,
  type TidegateActionEffect,
  type TidegateActionErrorCode,
  type TidegateActionInvokeRequest,
  type TidegateActionInvokeResponse,
  type TidegateActionTenantScope,
  type JsonSchema,
} from "@tidegate/contracts";

export {
  TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER,
  TIDEGATE_ACTION_AUTH_CONTEXT_HEADER,
  TIDEGATE_ACTION_INTERACTION_ID_HEADER,
  TIDEGATE_ACTION_BRIDGE_SECRET_HEADER,
  TidegateActionErrorCodeSchema,
  TidegateActionInvokeRequestSchema,
  TidegateActionInvokeResponseSchema,
};
export type {
  TidegateActionEffect,
  TidegateActionErrorCode,
  TidegateActionInvokeRequest,
  TidegateActionInvokeResponse,
};

export type TidegateActionExecuteArgs<TInput> = {
  input: TInput;
  auth: TidegateAuthContext;
  request: Request;
  signal: AbortSignal;
  /**
   * The runtime invocation id from the invoke request, when present. Use it
   * to correlate downstream calls with the Tidegate execution trace.
   */
  invocationId?: string;
};

export type TidegateActionExecuteContext = Omit<
  TidegateActionExecuteArgs<unknown>,
  "input"
>;

type MaybePromise<T> = Promise<T> | T;

type TidegateActionMetadata = {
  description?: string;
  effects: TidegateActionEffect;
  requiredPermissions?: string[];
  tenantScope?: TidegateActionTenantScope;
  audit?: Partial<TidegateActionAuditPolicy>;
};

export type TidegateActionDefinition<
  TInputSchema extends z.ZodType = z.ZodType,
  TReturnsSchema extends z.ZodType | undefined = z.ZodType | undefined,
  TOutput = TReturnsSchema extends z.ZodType
    ? z.infer<TReturnsSchema>
    : unknown,
> = TidegateActionMetadata & {
  input: TInputSchema;
  returns?: TReturnsSchema;
  /**
   * @deprecated Use `returns` for new actions. `output` remains supported for
   * existing flat action definitions.
   */
  output?: TReturnsSchema;
  execute: (
    args: TidegateActionExecuteArgs<z.infer<TInputSchema>>,
  ) => MaybePromise<TOutput>;
};

export type AnyTidegateActionDefinition = TidegateActionDefinition<any, any>;

export type TidegateActionNormalizedDefinition<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
> = TidegateActionMetadata & {
  input: TInputSchema;
  output: TOutputSchema;
  returns?: TOutputSchema;
  execute: (
    args: TidegateActionExecuteArgs<z.infer<TInputSchema>>,
  ) => MaybePromise<z.infer<TOutputSchema>>;
};

export type TidegateActionBuilderDefinition<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutput = unknown,
> = TidegateActionMetadata & {
  input: TInputSchema;
  returns?: undefined;
  execute: (
    input: z.infer<TInputSchema>,
    ctx: TidegateActionExecuteContext,
  ) => MaybePromise<TOutput>;
};

export type TidegateActionBuilderWithReturnsDefinition<
  TInputSchema extends z.ZodType = z.ZodType,
  TReturnsSchema extends z.ZodType = z.ZodType,
> = TidegateActionMetadata & {
  input: TInputSchema;
  returns: TReturnsSchema;
  execute: (
    input: z.infer<TInputSchema>,
    ctx: TidegateActionExecuteContext,
  ) => MaybePromise<z.infer<TReturnsSchema>>;
};

export type TidegateActionShorthandWithReturnsDefinition<
  TInputSchema extends z.ZodType = z.ZodType,
  TReturnsSchema extends z.ZodType = z.ZodType,
> = TidegateActionBuilderWithReturnsDefinition<TInputSchema, TReturnsSchema>;

export type TidegateActionLegacyShorthandDefinition<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
> = TidegateActionMetadata & {
  /**
   * @deprecated Use `input`.
   */
  inputSchema: TInputSchema;
  /**
   * @deprecated Use `returns`.
   */
  outputSchema: TOutputSchema;
  execute: (
    input: z.infer<TInputSchema>,
    ctx: TidegateActionExecuteContext,
  ) => MaybePromise<z.infer<TOutputSchema>>;
};

export type TidegateActionShorthandDefinition<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
> = TidegateActionLegacyShorthandDefinition<TInputSchema, TOutputSchema>;

export type TidegateActionCatalogNode =
  | AnyTidegateActionDefinition
  | { readonly [segment: string]: TidegateActionCatalogNode };

export type TidegateActionCatalog = {
  readonly [segment: string]: TidegateActionCatalogNode;
};

export type CreateTidegateActionCatalogManifestOptions = {
  catalogId: string;
  version?: string;
};

export type TidegateVerifiedActionRequest = {
  auth: TidegateAuthContext;
  allowedActionIds: string[];
  interactionId?: string;
};

export type TidegateActionRequestVerifier = (
  request: Request,
) => Promise<TidegateVerifiedActionRequest> | TidegateVerifiedActionRequest;

export type CreateTidegateActionHandlerOptions = {
  actionBridgeSecret?: string;
  verifyRequest?: TidegateActionRequestVerifier;
};

export class TidegateActionHandlerError extends Error {
  override name = "TidegateActionHandlerError";
  readonly code: TidegateActionErrorCode;
  readonly httpStatus: number;
  readonly responseStatus: "rejected" | "failed";

  constructor(
    code: TidegateActionErrorCode,
    message: string,
    httpStatus: number,
    responseStatus: "rejected" | "failed" = "rejected",
  ) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.responseStatus = responseStatus;
  }
}

export class TidegateActionCatalogError extends Error {
  override name = "TidegateActionCatalogError";
}

const TIDEGATE_ACTION_DEFINITION_BRAND = Symbol.for(
  "@tidegate/sdk/tidegate-action-definition",
);

export function tidegateAction<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  definition: TidegateActionNormalizedDefinition<TInputSchema, TOutputSchema>,
): TidegateActionDefinition<
  TInputSchema,
  TOutputSchema,
  z.infer<TOutputSchema>
>;
export function tidegateAction<
  TInputSchema extends z.ZodType,
  TOutput,
>(
  definition: TidegateActionBuilderDefinition<TInputSchema, TOutput>,
): TidegateActionDefinition<TInputSchema, undefined, Awaited<TOutput>>;
export function tidegateAction<
  TInputSchema extends z.ZodType,
  TReturnsSchema extends z.ZodType,
>(
  definition: TidegateActionBuilderWithReturnsDefinition<
    TInputSchema,
    TReturnsSchema
  >,
): TidegateActionDefinition<
  TInputSchema,
  TReturnsSchema,
  z.infer<TReturnsSchema>
>;
export function tidegateAction<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  definition: TidegateActionLegacyShorthandDefinition<TInputSchema, TOutputSchema>,
): TidegateActionDefinition<
  TInputSchema,
  TOutputSchema,
  z.infer<TOutputSchema>
>;
export function tidegateAction(
  definition:
    | AnyTidegateActionDefinition
    | TidegateActionBuilderDefinition
    | TidegateActionBuilderWithReturnsDefinition
    | TidegateActionLegacyShorthandDefinition,
): AnyTidegateActionDefinition {
  if (isLegacyShorthandActionDefinition(definition)) {
    const {
      inputSchema,
      outputSchema,
      execute,
      ...metadata
    } = definition;

    return brandTidegateActionDefinition({
      ...metadata,
      input: inputSchema,
      returns: outputSchema,
      output: outputSchema,
      execute: ({ input, auth, request, signal, invocationId }) =>
        execute(input, { auth, request, signal, invocationId }),
    });
  }

  if (isBuilderActionDefinition(definition)) {
    const {
      input,
      returns,
      execute,
      ...metadata
    } = definition;

    return brandTidegateActionDefinition({
      ...metadata,
      input,
      returns,
      execute: ({ input, auth, request, signal, invocationId }) =>
        execute(input, { auth, request, signal, invocationId }),
    });
  }

  return brandTidegateActionDefinition(definition);
}

export function defineTidegateActions<
  TActions extends Record<string, AnyTidegateActionDefinition>,
>(actions: TActions): TActions;
export function defineTidegateActions<
  TActions extends TidegateActionCatalog,
>(actions: TActions): TActions;
export function defineTidegateActions<
  TActions extends TidegateActionCatalog,
>(actions: TActions): TActions {
  flattenTidegateActions(actions);
  return actions;
}

export function createTidegateActionCatalogManifest<
  TActions extends TidegateActionCatalog,
>(
  actions: TActions,
  {
    catalogId,
    version = "1",
  }: CreateTidegateActionCatalogManifestOptions,
): TidegateActionCatalogManifestV1 {
  return TidegateActionCatalogManifestV1Schema.parse({
    schemaVersion: "tidegate.actionCatalog.v1",
    catalogId,
    version,
    actions: Object.fromEntries(
      flattenTidegateActions(actions).map(([actionId, action]) => {
        const returnsSchema = actionReturnsSchema(action);

        return [
          actionId,
          {
            description: action.description ?? actionId,
            input: toJsonSchema(action.input),
            output: returnsSchema ? toJsonSchema(returnsSchema) : {},
            effects: action.effects,
            requiredPermissions: action.requiredPermissions ?? [],
            tenantScope: action.tenantScope,
            audit: {
              required: action.audit?.required ?? action.effects !== "read",
              redactPaths: action.audit?.redactPaths ?? [],
            },
          },
        ];
      }),
    ),
  });
}

export function createTidegateActionHandler<
  TActions extends TidegateActionCatalog,
>(
  actions: TActions,
  {
    actionBridgeSecret = process.env.TIDEGATE_ACTION_BRIDGE_SECRET,
    verifyRequest,
  }: CreateTidegateActionHandlerOptions = {},
) {
  const actionMap = new Map<string, AnyTidegateActionDefinition>(
    flattenTidegateActions(actions),
  );
  const verifier =
    verifyRequest ??
    ((request: Request) =>
      verifyTidegateActionRequest({ request, actionBridgeSecret }));

  return async function POST(request: Request): Promise<Response> {
    let verified: TidegateVerifiedActionRequest;

    try {
      verified = await verifier(request);
    } catch (error) {
      return responseFromError(
        normalizeActionHandlerError(
          error,
          "Tidegate action request verification failed.",
        ),
      );
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return actionErrorResponse({
        code: "invalid_request",
        message: "Request body must be valid JSON.",
        status: "rejected",
        httpStatus: 400,
      });
    }

    const requestResult = TidegateActionInvokeRequestSchema.safeParse(body);

    if (!requestResult.success) {
      return actionErrorResponse({
        code: "invalid_request",
        message: "Request body must include actionId and input only.",
        status: "rejected",
        httpStatus: 400,
      });
    }

    const invokeRequest = requestResult.data;

    if (!verified.allowedActionIds.includes(invokeRequest.actionId)) {
      return actionErrorResponse({
        code: "action_not_allowed",
        message: "The requested Tidegate action is not allowed by this interaction.",
        status: "rejected",
        httpStatus: 403,
        invocationId: invokeRequest.invocationId,
      });
    }

    const action = actionMap.get(invokeRequest.actionId);

    if (!action) {
      return actionErrorResponse({
        code: "action_not_found",
        message: "The requested Tidegate action is not registered.",
        status: "rejected",
        httpStatus: 404,
        invocationId: invokeRequest.invocationId,
      });
    }

    if (!hasRequiredPermissions(verified.auth, action.requiredPermissions ?? [])) {
      return actionErrorResponse({
        code: "permission_denied",
        message: "The Tidegate action request is missing required permissions.",
        status: "rejected",
        httpStatus: 403,
        invocationId: invokeRequest.invocationId,
      });
    }

    const inputResult = action.input.safeParse(invokeRequest.input);

    if (!inputResult.success) {
      return actionErrorResponse({
        code: "action_input_invalid",
        message: "The Tidegate action input does not match the registered schema.",
        status: "rejected",
        httpStatus: 400,
        invocationId: invokeRequest.invocationId,
      });
    }

    let output: unknown;

    try {
      output = await action.execute({
        input: inputResult.data,
        auth: verified.auth,
        request,
        signal: request.signal,
        invocationId: invokeRequest.invocationId,
      });
    } catch (error) {
      // A structured TidegateActionHandlerError thrown by the action keeps
      // its code/status: this is how a backend surfaces auth_required,
      // permission_denied, action_input_invalid... from downstream systems.
      const handlerError = normalizeActionHandlerError(
        error,
        "The Tidegate action failed while executing.",
      );
      return actionErrorResponse({
        code: handlerError.code,
        message: handlerError.message,
        status: handlerError.responseStatus,
        httpStatus: handlerError.httpStatus,
        invocationId: invokeRequest.invocationId,
      });
    }

    const returnsSchema = actionReturnsSchema(action);
    let responseOutput = output;

    if (returnsSchema) {
      const outputResult = returnsSchema.safeParse(output);

      if (!outputResult.success) {
        return actionErrorResponse({
          code: "action_output_invalid",
          message: "The Tidegate action output does not match the registered schema.",
          status: "failed",
          httpStatus: 500,
          invocationId: invokeRequest.invocationId,
        });
      }

      responseOutput = outputResult.data;
    } else if (responseOutput === undefined) {
      responseOutput = null;
    }

    return Response.json(
      TidegateActionInvokeResponseSchema.parse({
        status: "ok",
        invocationId: invokeRequest.invocationId,
        output: responseOutput,
      }),
    );
  };
}

export function verifyTidegateActionRequest({
  actionBridgeSecret = process.env.TIDEGATE_ACTION_BRIDGE_SECRET,
  request,
}: {
  actionBridgeSecret?: string;
  request: Request;
}): TidegateVerifiedActionRequest {
  if (!actionBridgeSecret) {
    throw new TidegateActionHandlerError(
      "auth_required",
      "TIDEGATE_ACTION_BRIDGE_SECRET is not configured.",
      500,
      "failed",
    );
  }

  const headerSecret = request.headers.get(TIDEGATE_ACTION_BRIDGE_SECRET_HEADER);

  if (!headerSecret || !constantTimeEqual(headerSecret, actionBridgeSecret)) {
    throw new TidegateActionHandlerError(
      "auth_required",
      "The Tidegate action request is missing a valid credential.",
      401,
    );
  }

  const authHeader = request.headers.get(TIDEGATE_ACTION_AUTH_CONTEXT_HEADER);
  const allowedActionsHeader = request.headers.get(
    TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER,
  );

  if (!authHeader) {
    throw new TidegateActionHandlerError(
      "invalid_request",
      "The Tidegate action request is missing server-derived auth context.",
      400,
    );
  }

  if (!allowedActionsHeader) {
    throw new TidegateActionHandlerError(
      "invalid_request",
      "The Tidegate action request is missing its interaction action allowlist.",
      400,
    );
  }

  let parsedAuth: unknown;
  let parsedAllowedActions: unknown;

  try {
    parsedAuth = JSON.parse(authHeader);
  } catch {
    throw new TidegateActionHandlerError(
      "invalid_request",
      "The Tidegate action auth context must be valid JSON.",
      400,
    );
  }

  try {
    parsedAllowedActions = JSON.parse(allowedActionsHeader);
  } catch {
    throw new TidegateActionHandlerError(
      "invalid_request",
      "The Tidegate action allowlist must be valid JSON.",
      400,
    );
  }

  const authResult = TidegateAuthContextSchema.safeParse(parsedAuth);
  const allowedActionsResult = z.array(z.string().min(1)).safeParse(
    parsedAllowedActions,
  );

  if (!authResult.success) {
    throw new TidegateActionHandlerError(
      "invalid_request",
      "The Tidegate action auth context is invalid.",
      400,
    );
  }

  if (!allowedActionsResult.success) {
    throw new TidegateActionHandlerError(
      "invalid_request",
      "The Tidegate action allowlist is invalid.",
      400,
    );
  }

  return {
    auth: authResult.data,
    allowedActionIds: allowedActionsResult.data,
    interactionId:
      request.headers.get(TIDEGATE_ACTION_INTERACTION_ID_HEADER) ?? undefined,
  };
}

function responseFromError(error: TidegateActionHandlerError): Response {
  return actionErrorResponse({
    code: error.code,
    message: error.message,
    status: error.responseStatus,
    httpStatus: error.httpStatus,
  });
}

function normalizeActionHandlerError(
  error: unknown,
  fallbackMessage: string,
): TidegateActionHandlerError {
  if (error instanceof TidegateActionHandlerError) {
    return error;
  }

  return new TidegateActionHandlerError(
    "action_failed",
    fallbackMessage,
    500,
    "failed",
  );
}

function actionErrorResponse({
  code,
  httpStatus,
  invocationId,
  message,
  status,
}: {
  code: TidegateActionErrorCode;
  httpStatus: number;
  invocationId?: string;
  message: string;
  status: "rejected" | "failed";
}): Response {
  return Response.json(
    TidegateActionInvokeResponseSchema.parse({
      status,
      invocationId,
      error: {
        code,
        // The bridge response contract requires a non-empty message; a
        // downstream system may legitimately produce an empty one.
        message:
          message.trim().length > 0
            ? message
            : `The Tidegate action failed with error code ${code} and no message.`,
      },
    }),
    { status: httpStatus },
  );
}

function hasRequiredPermissions(
  auth: TidegateAuthContext,
  requiredPermissions: string[],
): boolean {
  if (requiredPermissions.length === 0) {
    return true;
  }

  const permissions = new Set([
    ...(auth.permissions ?? []),
    ...(auth.authorization?.permissions ?? []),
  ]);

  return requiredPermissions.every((permission) => permissions.has(permission));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return diff === 0;
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema) as JsonSchema;
}

function flattenTidegateActions(
  actions: TidegateActionCatalog,
): [string, AnyTidegateActionDefinition][] {
  assertPlainNamespace(actions, "Tidegate action catalog");
  assertStringKeysOnly(actions, "Tidegate action catalog");

  const entries = new Map<string, AnyTidegateActionDefinition>();

  for (const [segment, node] of Object.entries(actions)) {
    collectTidegateActionEntries({
      entries,
      path: [segment],
      node,
    });
  }

  assertNoNamespaceCollisions([...entries.keys()]);

  return [...entries.entries()];
}

function collectTidegateActionEntries({
  entries,
  path,
  node,
}: {
  entries: Map<string, AnyTidegateActionDefinition>;
  path: string[];
  node: TidegateActionCatalogNode;
}) {
  if (isTidegateActionDefinition(node)) {
    if (path.length > 1 && !isBrandedTidegateActionDefinition(node)) {
      throw new TidegateActionCatalogError(
        `Invalid Tidegate action "${path.join(".")}". Wrap input/returns shorthand definitions with tidegateAction(...).`,
      );
    }

    const actionId = path.join(".");
    const actionIdResult = TidegateActionIdSchema.safeParse(actionId);

    if (!actionIdResult.success) {
      throw new TidegateActionCatalogError(
        `Invalid Tidegate action id "${actionId}": ${actionIdResult.error.issues
          .map((issue) => issue.message)
          .join(" ")}`,
      );
    }

    if (entries.has(actionId)) {
      throw new TidegateActionCatalogError(
        `Duplicate Tidegate action id "${actionId}". Use only one definition for each action path.`,
      );
    }

    entries.set(actionId, node);
    return;
  }

  if (isShorthandActionDefinition(node)) {
    throw new TidegateActionCatalogError(
      `Invalid Tidegate action "${path.join(".")}". Wrap input/returns shorthand definitions with tidegateAction(...).`,
    );
  }

  if (!isRecord(node)) {
    throw new TidegateActionCatalogError(
      `Invalid Tidegate action namespace "${path.join(".")}". Expected an action definition or nested namespace.`,
    );
  }

  const namespace = path.join(".");
  assertPlainNamespace(node, `Tidegate action namespace "${namespace}"`);
  assertStringKeysOnly(node, `Tidegate action namespace "${namespace}"`);

  const childEntries = Object.entries(node);

  if (childEntries.length === 0) {
    throw new TidegateActionCatalogError(
      `Invalid Tidegate action namespace "${namespace}". Namespaces must contain at least one action.`,
    );
  }

  for (const [segment, child] of childEntries) {
    collectTidegateActionEntries({
      entries,
      path: [...path, segment],
      node: child,
    });
  }
}

function assertNoNamespaceCollisions(actionIds: string[]) {
  const knownActionIds = new Set(actionIds);

  for (const actionId of actionIds) {
    const segments = actionId.split(".");
    let prefix = "";

    for (const segment of segments.slice(0, -1)) {
      prefix = prefix.length === 0 ? segment : `${prefix}.${segment}`;

      if (knownActionIds.has(prefix)) {
        throw new TidegateActionCatalogError(
          `Tidegate action id "${actionId}" conflicts with "${prefix}". Use either a leaf action or a namespace at each path.`,
        );
      }
    }
  }
}

function isTidegateActionDefinition(
  value: unknown,
): value is AnyTidegateActionDefinition {
  return (
    isRecord(value) &&
    "input" in value &&
    "effects" in value &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

function isShorthandActionDefinition(
  value: unknown,
): value is
  | TidegateActionBuilderDefinition
  | TidegateActionBuilderWithReturnsDefinition
  | TidegateActionLegacyShorthandDefinition {
  return (
    isBuilderActionDefinition(value) ||
    isLegacyShorthandActionDefinition(value)
  );
}

function isBuilderActionDefinition(
  value: unknown,
): value is
  | TidegateActionBuilderDefinition
  | TidegateActionBuilderWithReturnsDefinition {
  return (
    isRecord(value) &&
    "input" in value &&
    !("output" in value) &&
    "effects" in value &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

function isLegacyShorthandActionDefinition(
  value: unknown,
): value is TidegateActionLegacyShorthandDefinition {
  return (
    isRecord(value) &&
    "inputSchema" in value &&
    "outputSchema" in value &&
    "effects" in value &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

function brandTidegateActionDefinition<TAction extends AnyTidegateActionDefinition>(
  action: TAction,
): TAction {
  Object.defineProperty(action, TIDEGATE_ACTION_DEFINITION_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
  });

  return action;
}

function isBrandedTidegateActionDefinition(action: AnyTidegateActionDefinition): boolean {
  return (
    (action as Record<PropertyKey, unknown>)[TIDEGATE_ACTION_DEFINITION_BRAND] ===
    true
  );
}

function actionReturnsSchema(
  action: AnyTidegateActionDefinition,
): z.ZodType | undefined {
  return action.returns ?? action.output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPlainNamespace(
  value: Record<string, unknown>,
  label: string,
) {
  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    throw new TidegateActionCatalogError(
      `${label} must be a plain object with string action ids or namespace keys.`,
    );
  }
}

function assertStringKeysOnly(value: Record<string, unknown>, label: string) {
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    throw new TidegateActionCatalogError(
      `${label} must use string keys only; symbol keys cannot become stable Tidegate action ids.`,
    );
  }
}
