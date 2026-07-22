import {
  JsonSchemaSchema,
  type JsonSchema,
} from "@tidegate/contracts";
import type { RuntimeSchema } from "./action-catalog.ts";

export type JsonSchemaValidationIssue = {
  path: string;
  message: string;
};

export class JsonSchemaValidationError extends Error {
  override name = "JsonSchemaValidationError";
  readonly issues: JsonSchemaValidationIssue[];

  constructor(issues: JsonSchemaValidationIssue[]) {
    super(
      issues.length === 1
        ? issues[0]?.message
        : `${issues.length} JSON Schema validation issues.`,
    );
    this.issues = issues;
  }
}

export function createJsonSchemaRuntimeSchema<TData = unknown>(
  schema: JsonSchema,
): RuntimeSchema<TData> {
  const parsedSchema = JsonSchemaSchema.parse(schema);

  return {
    jsonSchema: parsedSchema,
    safeParse(value) {
      const issues = collectJsonSchemaValidationIssues(value, parsedSchema);

      if (issues.length > 0) {
        return {
          success: false,
          error: new JsonSchemaValidationError(issues),
        };
      }

      return {
        success: true,
        data: value as TData,
      };
    },
  };
}

export function validateJsonSchemaValue(
  value: unknown,
  schema: JsonSchema,
): boolean {
  return collectJsonSchemaValidationIssues(value, schema).length === 0;
}

export function collectJsonSchemaValidationIssues(
  value: unknown,
  schema: JsonSchema,
): JsonSchemaValidationIssue[] {
  const issues: JsonSchemaValidationIssue[] = [];
  validateAgainstSchema(value, schema, "$", issues);
  return issues;
}

function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  if (!isRecord(schema)) {
    issues.push({
      path,
      message: "JSON Schema must be an object.",
    });
    return false;
  }

  if (typeof schema.$ref === "string") {
    issues.push({
      path,
      message: `JSON Schema $ref is not supported at runtime: ${schema.$ref}`,
    });
    return false;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({
      path,
      message: "Value does not match any allowed enum value.",
    });
    return false;
  }

  if ("const" in schema && !Object.is(value, schema.const)) {
    issues.push({
      path,
      message: "Value does not match the required const value.",
    });
    return false;
  }

  if (Array.isArray(schema.anyOf)) {
    return validateSchemaUnion("anyOf", value, schema.anyOf, path, issues);
  }

  if (Array.isArray(schema.oneOf)) {
    return validateSchemaUnion("oneOf", value, schema.oneOf, path, issues);
  }

  if (Array.isArray(schema.allOf)) {
    let valid = true;

    for (const item of schema.allOf) {
      if (!validateAgainstSchema(value, item as JsonSchema, path, issues)) {
        valid = false;
      }
    }

    return valid;
  }

  const types = schemaTypes(schema);

  if (types.length === 0) {
    return true;
  }

  const matchingTypeIssues = types.map((type) => {
    const typeIssues: JsonSchemaValidationIssue[] = [];
    validateJsonSchemaType(value, schema, type, path, typeIssues);
    return typeIssues;
  });
  const passingType = matchingTypeIssues.find((typeIssues) => typeIssues.length === 0);

  if (passingType) {
    return true;
  }

  issues.push(...(matchingTypeIssues[0] ?? []));
  return false;
}

function validateSchemaUnion(
  keyword: "anyOf" | "oneOf",
  value: unknown,
  schemas: unknown[],
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  const matchingSchemas = schemas.filter((item) => {
    const candidateIssues: JsonSchemaValidationIssue[] = [];
    return validateAgainstSchema(value, item as JsonSchema, path, candidateIssues);
  });

  if (
    (keyword === "anyOf" && matchingSchemas.length > 0) ||
    (keyword === "oneOf" && matchingSchemas.length === 1)
  ) {
    return true;
  }

  issues.push({
    path,
    message:
      keyword === "oneOf"
        ? "Value must match exactly one schema."
        : "Value must match at least one schema.",
  });
  return false;
}

function schemaTypes(schema: JsonSchema): string[] {
  const schemaType = schema.type;

  if (Array.isArray(schemaType)) {
    return schemaType.filter((item): item is string => typeof item === "string");
  }

  if (typeof schemaType === "string") {
    return [schemaType];
  }

  return [];
}

function validateJsonSchemaType(
  value: unknown,
  schema: JsonSchema,
  type: string,
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  switch (type) {
    case "object":
      return validateJsonObject(value, schema, path, issues);
    case "array":
      return validateJsonArray(value, schema, path, issues);
    case "string":
      return validateJsonString(value, schema, path, issues);
    case "number":
      return validateJsonNumber(value, schema, path, issues);
    case "integer":
      return validateJsonInteger(value, schema, path, issues);
    case "boolean":
      return validatePrimitive(
        typeof value === "boolean",
        "Value must be a boolean.",
        path,
        issues,
      );
    case "null":
      return validatePrimitive(value === null, "Value must be null.", path, issues);
    default:
      issues.push({
        path,
        message: `Unsupported JSON Schema type "${type}".`,
      });
      return false;
  }
}

function validateJsonObject(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  if (!isRecord(value)) {
    issues.push({
      path,
      message: "Value must be an object.",
    });
    return false;
  }

  let valid = true;
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const item of required) {
    if (typeof item !== "string") {
      issues.push({
        path,
        message: "JSON Schema required entries must be strings.",
      });
      valid = false;
      continue;
    }

    if (!Object.hasOwn(value, item)) {
      issues.push({
        path: propertyPath(path, item),
        message: "Required property is missing.",
      });
      valid = false;
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }

    if (
      !validateAgainstSchema(
        value[key],
        propertySchema as JsonSchema,
        propertyPath(path, key),
        issues,
      )
    ) {
      valid = false;
    }
  }

  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) {
      continue;
    }

    if (schema.additionalProperties === false) {
      issues.push({
        path: propertyPath(path, key),
        message: "Additional property is not allowed.",
      });
      valid = false;
      continue;
    }

    if (
      isRecord(schema.additionalProperties) &&
      !validateAgainstSchema(
        value[key],
        schema.additionalProperties as JsonSchema,
        propertyPath(path, key),
        issues,
      )
    ) {
      valid = false;
    }
  }

  return valid;
}

function validateJsonArray(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  if (!Array.isArray(value)) {
    issues.push({
      path,
      message: "Value must be an array.",
    });
    return false;
  }

  let valid = true;

  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    issues.push({
      path,
      message: `Array must contain at least ${schema.minItems} items.`,
    });
    valid = false;
  }

  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    issues.push({
      path,
      message: `Array must contain at most ${schema.maxItems} items.`,
    });
    valid = false;
  }

  if (Array.isArray(schema.items)) {
    const tupleItems = schema.items;

    value.forEach((item, index) => {
      const itemSchema = tupleItems[index];

      if (
        itemSchema &&
        !validateAgainstSchema(
          item,
          itemSchema as JsonSchema,
          arrayPath(path, index),
          issues,
        )
      ) {
        valid = false;
      }
    });
    return valid;
  }

  if (!isRecord(schema.items)) {
    return valid;
  }

  value.forEach((item, index) => {
    if (
      !validateAgainstSchema(
        item,
        schema.items as JsonSchema,
        arrayPath(path, index),
        issues,
      )
    ) {
      valid = false;
    }
  });

  return valid;
}

function validateJsonString(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  if (typeof value !== "string") {
    issues.push({
      path,
      message: "Value must be a string.",
    });
    return false;
  }

  let valid = true;

  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    issues.push({
      path,
      message: `String must contain at least ${schema.minLength} characters.`,
    });
    valid = false;
  }

  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    issues.push({
      path,
      message: `String must contain at most ${schema.maxLength} characters.`,
    });
    valid = false;
  }

  if (typeof schema.pattern === "string") {
    const pattern = new RegExp(schema.pattern);

    if (!pattern.test(value)) {
      issues.push({
        path,
        message: "String does not match the required pattern.",
      });
      valid = false;
    }
  }

  return valid;
}

function validateJsonNumber(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({
      path,
      message: "Value must be a number.",
    });
    return false;
  }

  return validateNumberBounds(value, schema, path, issues);
}

function validateJsonInteger(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    issues.push({
      path,
      message: "Value must be an integer.",
    });
    return false;
  }

  return validateNumberBounds(value, schema, path, issues);
}

function validateNumberBounds(
  value: number,
  schema: JsonSchema,
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  let valid = true;

  if (typeof schema.minimum === "number" && value < schema.minimum) {
    issues.push({
      path,
      message: `Number must be at least ${schema.minimum}.`,
    });
    valid = false;
  }

  if (typeof schema.maximum === "number" && value > schema.maximum) {
    issues.push({
      path,
      message: `Number must be at most ${schema.maximum}.`,
    });
    valid = false;
  }

  if (
    typeof schema.exclusiveMinimum === "number" &&
    value <= schema.exclusiveMinimum
  ) {
    issues.push({
      path,
      message: `Number must be greater than ${schema.exclusiveMinimum}.`,
    });
    valid = false;
  }

  if (
    typeof schema.exclusiveMaximum === "number" &&
    value >= schema.exclusiveMaximum
  ) {
    issues.push({
      path,
      message: `Number must be less than ${schema.exclusiveMaximum}.`,
    });
    valid = false;
  }

  return valid;
}

function validatePrimitive(
  valid: boolean,
  message: string,
  path: string,
  issues: JsonSchemaValidationIssue[],
): boolean {
  if (!valid) {
    issues.push({
      path,
      message,
    });
  }

  return valid;
}

function propertyPath(path: string, key: string): string {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function arrayPath(path: string, index: number): string {
  return `${path}/${index}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
