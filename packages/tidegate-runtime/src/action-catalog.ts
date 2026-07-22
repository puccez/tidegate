import type { JsonSchema, TidegateAuthContext } from "@tidegate/contracts";

export type RuntimeAuthContext = TidegateAuthContext;

export type ActionEffect = "read" | "write" | "external" | "destructive";

export type RuntimeSchemaParseResult<TData> =
  | {
      success: true;
      data: TData;
    }
  | {
      success: false;
      error: unknown;
    };

export type RuntimeSchema<TData = unknown> = {
  safeParse: (value: unknown) => RuntimeSchemaParseResult<TData>;
  jsonSchema?: JsonSchema;
};

export type InferRuntimeSchema<TSchema> =
  TSchema extends RuntimeSchema<infer TData> ? TData : never;

export type RuntimeTenantScope = {
  tenantId?: string;
  salonId?: string;
  fromAuth?: "tenantId" | "organizationId" | "orgId" | "salonId";
};

export type RuntimeActionAuditPolicy = {
  required: boolean;
  redactPaths: string[];
};

export type RuntimeActionExecutionContext = {
  id: string;
  version: string;
  allowedActionIds: string[];
};

export type RuntimeActionExecuteArgs<TInput> = {
  input: TInput;
  auth: RuntimeAuthContext;
  signal: AbortSignal;
  interaction: RuntimeActionExecutionContext;
  invocationId?: string;
};

export type RuntimeAction<
  TInputSchema extends RuntimeSchema = RuntimeSchema,
  TOutputSchema extends RuntimeSchema = RuntimeSchema,
> = {
  id: string;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  effects: ActionEffect;
  requiredPermissions?: string[];
  tenantScope?: RuntimeTenantScope;
  audit?: RuntimeActionAuditPolicy;
  execute: (
    args: RuntimeActionExecuteArgs<InferRuntimeSchema<TInputSchema>>,
  ) => Promise<InferRuntimeSchema<TOutputSchema>>;
};

export type AnyRuntimeAction = RuntimeAction<
  RuntimeSchema<any>,
  RuntimeSchema<any>
>;

export function defineAction<
  TInputSchema extends RuntimeSchema,
  TOutputSchema extends RuntimeSchema,
>(action: RuntimeAction<TInputSchema, TOutputSchema>) {
  return action;
}

export function defineActionsCatalog<
  TActions extends Record<string, AnyRuntimeAction>,
>(actions: TActions): TActions {
  return actions;
}
