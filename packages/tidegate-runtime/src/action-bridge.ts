import { z } from "zod";
import {
  TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER,
  TIDEGATE_ACTION_AUTH_CONTEXT_HEADER,
  TIDEGATE_ACTION_INTERACTION_ID_HEADER,
  TIDEGATE_ACTION_BRIDGE_SECRET_HEADER,
  TidegateActionInvokeRequestSchema,
  TidegateActionInvokeResponseSchema,
  TidegateAuthContextSchema,
  type TidegateActionErrorCode,
  type InvokeInteractionErrorCode,
} from "@tidegate/contracts";
import type {
  ActionEffect,
  InferRuntimeSchema,
  RuntimeAction,
  RuntimeActionAuditPolicy,
  RuntimeActionExecuteArgs,
  RuntimeSchema,
  RuntimeSchemaParseResult,
  RuntimeTenantScope,
} from "./action-catalog.ts";

export type TidegateActionBridgeFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

type BridgeRuntimeStatus = "rejected" | "failed";

type TidegateActionBridgeHeadersInit = ConstructorParameters<typeof Headers>[0];

type AdditionalHeaders<TInput> =
  | TidegateActionBridgeHeadersInit
  | ((
      args: RuntimeActionExecuteArgs<TInput>,
    ) => TidegateActionBridgeHeadersInit | Promise<TidegateActionBridgeHeadersInit>);

export type CreateTidegateActionBridgeActionOptions<
  TInputSchema extends RuntimeSchema,
  TOutputSchema extends RuntimeSchema,
> = {
  id: string;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  effects: ActionEffect;
  endpoint: string | URL;
  actionBridgeSecret?: string;
  fetchImpl?: TidegateActionBridgeFetch;
  headers?: AdditionalHeaders<InferRuntimeSchema<TInputSchema>>;
  requiredPermissions?: string[];
  tenantScope?: RuntimeTenantScope;
  audit?: RuntimeActionAuditPolicy;
};

const ACTION_ERROR_TO_INVOKE_ERROR: Record<
  TidegateActionErrorCode,
  InvokeInteractionErrorCode
> = {
  invalid_request: "invalid_request",
  auth_required: "auth_required",
  permission_denied: "permission_denied",
  action_not_found: "action_not_registered",
  action_not_allowed: "action_not_allowed",
  action_input_invalid: "action_input_invalid",
  action_output_invalid: "action_output_invalid",
  action_failed: "interaction_failed",
};

export class TidegateActionBridgeRuntimeError extends Error {
  override name = "TidegateActionBridgeRuntimeError";
  readonly code: InvokeInteractionErrorCode;
  readonly status: BridgeRuntimeStatus;
  readonly details?: unknown;

  constructor(
    code: InvokeInteractionErrorCode,
    message: string,
    status: BridgeRuntimeStatus,
    details?: unknown,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createTidegateActionBridgeAction<
  TInputSchema extends RuntimeSchema,
  TOutputSchema extends RuntimeSchema,
>({
  actionBridgeSecret = process.env.TIDEGATE_ACTION_BRIDGE_SECRET,
  endpoint,
  fetchImpl = globalThis.fetch,
  headers,
  ...action
}: CreateTidegateActionBridgeActionOptions<
  TInputSchema,
  TOutputSchema
>): RuntimeAction<TInputSchema, TOutputSchema> {
  const normalizedEndpoint = normalizeEndpoint(endpoint);

  if (!actionBridgeSecret) {
    throw new TidegateActionBridgeRuntimeError(
      "auth_required",
      "TIDEGATE_ACTION_BRIDGE_SECRET is not configured for the Tidegate action bridge runtime action.",
      "failed",
    );
  }

  return {
    ...action,
    async execute(args) {
      const inputResult = action.inputSchema.safeParse(
        args.input,
      ) as RuntimeSchemaParseResult<InferRuntimeSchema<TInputSchema>>;

      if (!inputResult.success) {
        throw new TidegateActionBridgeRuntimeError(
          "action_input_invalid",
          "Action bridge input does not match the registered schema.",
          "failed",
          inputResult.error,
        );
      }

      const auth = TidegateAuthContextSchema.parse(args.auth);
      const requestHeaders = await createBridgeHeaders({
        actionBridgeSecret,
        args: {
          ...args,
          input: inputResult.data,
        },
        headers,
      });
      const requestBody = TidegateActionInvokeRequestSchema.parse({
        actionId: action.id,
        input: inputResult.data,
        invocationId: args.invocationId,
      });
      const response = await fetchBridgeResponse({
        body: requestBody,
        endpoint: normalizedEndpoint,
        fetchImpl,
        headers: requestHeaders,
        signal: args.signal,
      });
      const parsedResponse = TidegateActionInvokeResponseSchema.safeParse(response);

      if (!parsedResponse.success) {
        throw new TidegateActionBridgeRuntimeError(
          "interaction_failed",
          "The Tidegate action bridge returned an invalid response body.",
          "failed",
          parsedResponse.error,
        );
      }

      if (parsedResponse.data.status !== "ok") {
        throw new TidegateActionBridgeRuntimeError(
          ACTION_ERROR_TO_INVOKE_ERROR[parsedResponse.data.error.code],
          parsedResponse.data.error.message,
          parsedResponse.data.status,
          parsedResponse.data.error,
        );
      }

      const outputResult = action.outputSchema.safeParse(
        parsedResponse.data.output,
      ) as RuntimeSchemaParseResult<InferRuntimeSchema<TOutputSchema>>;

      if (!outputResult.success) {
        throw new TidegateActionBridgeRuntimeError(
          "action_output_invalid",
          "Action bridge output does not match the registered schema.",
          "failed",
          outputResult.error,
        );
      }

      return outputResult.data;
    },
  };
}

function normalizeEndpoint(endpoint: string | URL): string {
  const normalized = String(endpoint).trim();

  if (normalized.length === 0) {
    throw new TidegateActionBridgeRuntimeError(
      "invalid_request",
      "Tidegate action bridge endpoint cannot be empty.",
      "failed",
    );
  }

  return normalized;
}

async function createBridgeHeaders<TInput>({
  actionBridgeSecret,
  args,
  headers,
}: {
  actionBridgeSecret: string;
  args: RuntimeActionExecuteArgs<TInput>;
  headers?: AdditionalHeaders<TInput>;
}): Promise<Headers> {
  const additionalHeaders =
    typeof headers === "function" ? await headers(args) : headers;
  const requestHeaders = new Headers(additionalHeaders);
  const auth = TidegateAuthContextSchema.parse(args.auth);

  requestHeaders.set("accept", "application/json");
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set(TIDEGATE_ACTION_BRIDGE_SECRET_HEADER, actionBridgeSecret);
  requestHeaders.set(TIDEGATE_ACTION_AUTH_CONTEXT_HEADER, JSON.stringify(auth));
  requestHeaders.set(
    TIDEGATE_ACTION_ALLOWED_ACTIONS_HEADER,
    JSON.stringify(args.interaction.allowedActionIds),
  );
  requestHeaders.set(TIDEGATE_ACTION_INTERACTION_ID_HEADER, args.interaction.id);

  return requestHeaders;
}

async function fetchBridgeResponse({
  body,
  endpoint,
  fetchImpl,
  headers,
  signal,
}: {
  body: z.infer<typeof TidegateActionInvokeRequestSchema>;
  endpoint: string;
  fetchImpl: TidegateActionBridgeFetch;
  headers: Headers;
  signal: AbortSignal;
}): Promise<unknown> {
  let response: Response;

  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new TidegateActionBridgeRuntimeError(
        "interaction_timeout",
        "The Tidegate action bridge request was aborted.",
        "failed",
        error,
      );
    }

    throw new TidegateActionBridgeRuntimeError(
      "interaction_failed",
      "The Tidegate action bridge request failed before receiving a response.",
      "failed",
      error,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new TidegateActionBridgeRuntimeError(
      codeForInvalidBridgeResponse(response.status),
      `The Tidegate action bridge returned HTTP ${response.status} without a valid JSON body.`,
      response.status >= 500 ? "failed" : "rejected",
      error,
    );
  }
}

function codeForInvalidBridgeResponse(
  status: number,
): InvokeInteractionErrorCode {
  if (status === 401) {
    return "auth_required";
  }

  if (status === 403) {
    return "permission_denied";
  }

  if (status === 404) {
    return "action_not_registered";
  }

  return "interaction_failed";
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}
