import {
  TidegateActionCatalogManifestV1Schema,
  type TidegateActionCatalogManifestV1,
  type TidegateActionManifestV1,
} from "@tidegate/contracts";

export const TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME = "actions";
export const TIDEGATE_INTERACTION_AUTHORING_ACTION_CATALOG_FILENAME =
  "catalog.json";
export const TIDEGATE_INTERACTION_AUTHORING_ACTION_INDEX_FILENAME = "index.ts";
export const TIDEGATE_INTERACTION_AUTHORING_ACTION_README_FILENAME = "README.md";

export type GeneratedTidegateActionAuthoringFile = {
  actionId?: string;
  relativePath: string;
  source: string;
};

export type GeneratedTidegateActionAuthoringFiles = {
  actionFiles: Record<string, string>;
  files: GeneratedTidegateActionAuthoringFile[];
};

export type TidegateActionAuthoringAllowedAction = {
  id: string;
  maxCalls?: number;
  timeoutMs?: number;
};

export type GenerateTidegateActionAuthoringFilesOptions = {
  allowedActions?: readonly TidegateActionAuthoringAllowedAction[];
};

export type TidegateActionAuthoringManifest = {
  allowedActions: TidegateActionAuthoringAllowedAction[];
  manifest: TidegateActionCatalogManifestV1;
};

type ActionEntry = {
  action: TidegateActionManifestV1;
  actionId: string;
  allowedAction: {
    id: string;
    maxCalls?: number;
    timeoutMs?: number;
  };
  alias: string;
  callExpression: string;
  exportSpecifier: string;
  inputTypeName: string;
  outputTypeName: string;
  relativePath: string;
  runtimeImportSpecifier: string;
};

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function createTidegateActionAuthoringManifest(
  manifest: TidegateActionCatalogManifestV1,
  options: GenerateTidegateActionAuthoringFilesOptions = {},
): TidegateActionAuthoringManifest {
  const parsed = TidegateActionCatalogManifestV1Schema.parse(manifest);
  const allowedActions = normalizedAllowedActions({
    actionIds: Object.keys(parsed.actions),
    allowedActions: options.allowedActions,
  });

  return {
    allowedActions,
    manifest: {
      ...parsed,
      actions: Object.fromEntries(
        allowedActions.map((allowedAction) => [
          allowedAction.id,
          requireAction(parsed, allowedAction.id),
        ]),
      ),
    },
  };
}

export function generateTidegateActionAuthoringFiles(
  manifest: TidegateActionCatalogManifestV1,
  options: GenerateTidegateActionAuthoringFilesOptions = {},
): GeneratedTidegateActionAuthoringFiles {
  const authoring = createTidegateActionAuthoringManifest(manifest, options);
  const entries = authoring.allowedActions
    .map((allowedAction) => {
      return [
        allowedAction.id,
        requireAction(authoring.manifest, allowedAction.id),
        allowedAction,
      ] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([actionId, action, allowedAction]) =>
      actionEntry(actionId, action, allowedAction),
    );

  assertUniqueEntries(entries, "relativePath", "file path");
  assertUniqueEntries(entries, "alias", "export alias");

  return {
    actionFiles: Object.fromEntries(
      entries.map((entry) => [entry.actionId, entry.relativePath]),
    ),
    files: [
      {
        relativePath: joinActionPath(
          TIDEGATE_INTERACTION_AUTHORING_ACTION_CATALOG_FILENAME,
        ),
        source: `${stableJson(authoring.manifest)}\n`,
      },
      {
        relativePath: joinActionPath(
          TIDEGATE_INTERACTION_AUTHORING_ACTION_README_FILENAME,
        ),
        source: readmeSource(authoring.manifest, entries),
      },
      {
        relativePath: joinActionPath(
          TIDEGATE_INTERACTION_AUTHORING_ACTION_INDEX_FILENAME,
        ),
        source: indexSource(authoring.manifest, entries),
      },
      ...entries.map((entry) => ({
        actionId: entry.actionId,
        relativePath: entry.relativePath,
        source: actionSource(entry),
      })),
    ],
  };
}

function actionEntry(
  actionId: string,
  action: TidegateActionManifestV1,
  allowedAction: {
    id: string;
    maxCalls?: number;
    timeoutMs?: number;
  },
): ActionEntry {
  const segments = actionId.split(".");
  const actionPathSegments = segments.map(safePathSegment);
  const filename = `${actionPathSegments.at(-1) ?? "action"}.ts`;
  const directorySegments = actionPathSegments.slice(0, -1);
  const relativePath = joinActionPath(...directorySegments, filename);
  const name = typeNameBase(segments);

  return {
    action,
    actionId,
    alias: `${valueIdentifier(camelCase(segments), "action")}Action`,
    allowedAction,
    callExpression: capabilityCallExpression(segments),
    exportSpecifier: `./${[...directorySegments, filename.replace(/\.ts$/, "")]
      .filter(Boolean)
      .join("/")}`,
    inputTypeName: `${name}Input`,
    outputTypeName: `${name}Output`,
    relativePath,
    runtimeImportSpecifier: `${"../".repeat(segments.length)}tidegate-capabilities.generated`,
  };
}

function readmeSource(
  manifest: TidegateActionCatalogManifestV1,
  entries: ActionEntry[],
): string {
  return [
    "# Tidegate Actions",
    "",
    "Generated by Tidegate. Do not edit these files by hand.",
    "",
    `Catalog: \`${manifest.catalogId}@${manifest.version}\``,
    "",
    "Use this folder as the TypeScript discovery surface for interaction authoring.",
    "The publish artifact is still a single `interaction.ts` file, so production source should call `ctx.capabilities.*` directly.",
    "",
    "Allowed actions for this interaction:",
    "",
    ...entries.flatMap((entry) => [
      `- \`${entry.actionId}\``,
      `  - call: \`${entry.callExpression}(input)\``,
      `  - effects: \`${entry.action.effects}\``,
      `  - permissions: ${
        entry.action.requiredPermissions.length > 0
          ? entry.action.requiredPermissions.map((permission) => `\`${permission}\``).join(", ")
          : "none"
      }`,
      `  - types: \`${entry.inputTypeName}\` -> \`${entry.outputTypeName}\` in \`${entry.relativePath}\``,
      "",
    ]),
  ].join("\n");
}

function indexSource(
  manifest: TidegateActionCatalogManifestV1,
  entries: ActionEntry[],
): string {
  return [
    "/* eslint-disable */",
    "// Generated by Tidegate. Do not edit by hand.",
    "",
    'import type { TidegateGeneratedInteractionContext } from "../tidegate-capabilities.generated";',
    "",
    "export type TidegateActions = TidegateGeneratedInteractionContext[\"capabilities\"];",
    "",
    `export const actionCatalog = ${stableJson({
      catalogId: manifest.catalogId,
      version: manifest.version,
      actionIds: entries.map((entry) => entry.actionId),
    })} as const;`,
    "",
    `export const requestedAllowedActions = ${stableJson(
      entries.map((entry) => entry.allowedAction),
    )} as const;`,
    "",
    ...entries.map(
      (entry) =>
        `export { action as ${entry.alias} } from ${JSON.stringify(
          entry.exportSpecifier,
        )};`,
    ),
    "",
  ].join("\n");
}

function actionSource(entry: ActionEntry): string {
  return [
    "/* eslint-disable */",
    "// Generated by Tidegate. Do not edit by hand.",
    `// Action: ${entry.actionId}`,
    "",
    "import type {",
    "  TidegateActionMap,",
    "  TidegateGeneratedInteractionContext,",
    `} from ${JSON.stringify(entry.runtimeImportSpecifier)};`,
    "",
    `export const actionId = ${JSON.stringify(entry.actionId)} as const;`,
    `export const effects = ${JSON.stringify(entry.action.effects)} as const;`,
    `export const requiredPermissions = ${stableJson(
      entry.action.requiredPermissions,
    )} as const;`,
    `export const inputSchema = ${stableJson(entry.action.input)} as const;`,
    `export const outputSchema = ${stableJson(entry.action.output)} as const;`,
    "",
    `export type ${entry.inputTypeName} = TidegateActionMap[typeof actionId]["input"];`,
    `export type ${entry.outputTypeName} = TidegateActionMap[typeof actionId]["output"];`,
    "",
    "export function call(",
    "  ctx: Pick<TidegateGeneratedInteractionContext, \"capabilities\">,",
    `  input: ${entry.inputTypeName},`,
    `): Promise<${entry.outputTypeName}> {`,
    `  return ${entry.callExpression}(input);`,
    "}",
    "",
    "export const action = {",
    "  id: actionId,",
    "  effects,",
    "  requiredPermissions,",
    "  inputSchema,",
    "  outputSchema,",
    "  call,",
    "} as const;",
    "",
    `export type ActionInput = ${entry.inputTypeName};`,
    `export type ActionOutput = ${entry.outputTypeName};`,
    "",
  ].join("\n");
}

function capabilityCallExpression(segments: string[]): string {
  return ["ctx", "capabilities", ...segments]
    .map((segment, index) => (index === 0 ? segment : propertyAccess(segment)))
    .join("");
}

function propertyAccess(value: string): string {
  return IDENTIFIER_PATTERN.test(value) ? `.${value}` : `[${JSON.stringify(value)}]`;
}

function joinActionPath(...segments: string[]): string {
  return [TIDEGATE_INTERACTION_AUTHORING_ACTIONS_DIRNAME, ...segments]
    .filter((segment) => segment.length > 0)
    .join("/");
}

function safePathSegment(segment: string): string {
  const encoded = encodeURIComponent(segment);

  return encoded.length > 0 ? encoded : "_";
}

function normalizedAllowedActions({
  actionIds,
  allowedActions,
}: {
  actionIds: string[];
  allowedActions: GenerateTidegateActionAuthoringFilesOptions["allowedActions"];
}) {
  const source =
    allowedActions ??
    actionIds.map((id) => ({
      id,
      maxCalls: 1,
    }));
  const normalizedSource: ReadonlyArray<TidegateActionAuthoringAllowedAction> =
    source;
  const seen = new Set<string>();

  return normalizedSource.map((action) => {
    if (seen.has(action.id)) {
      throw new Error(
        `Tidegate action authoring files received duplicate allowed action "${action.id}".`,
      );
    }

    seen.add(action.id);
    return omitUndefined({
      id: action.id,
      maxCalls: action.maxCalls,
      timeoutMs: action.timeoutMs,
    });
  });
}

function requireAction(
  manifest: TidegateActionCatalogManifestV1,
  actionId: string,
): TidegateActionManifestV1 {
  const action = manifest.actions[actionId];

  if (action === undefined) {
    throw new Error(
      `Tidegate action authoring files cannot include unknown allowed action "${actionId}".`,
    );
  }

  return action;
}

function assertUniqueEntries(
  entries: ActionEntry[],
  key: "alias" | "relativePath",
  label: string,
) {
  const seen = new Map<string, string>();

  for (const entry of entries) {
    const value = entry[key];
    const existingActionId = seen.get(value);

    if (existingActionId !== undefined) {
      throw new Error(
        `Tidegate action authoring files cannot generate duplicate ${label} "${value}" for actions "${existingActionId}" and "${entry.actionId}".`,
      );
    }

    seen.set(value, entry.actionId);
  }
}

function camelCase(segments: string[]): string {
  const [first = ["action"], ...rest] = segments.map(identifierWords);
  return [
    first.map((word) => word.toLowerCase()).join(""),
    ...rest.map((words) => capitalize(words.map((word) => word.toLowerCase()).join(""))),
  ].join("");
}

function typeNameBase(segments: string[]): string {
  return typeIdentifier(pascalCase(segments), "TidegateAction");
}

function pascalCase(segments: string[]): string {
  return segments
    .flatMap(identifierWords)
    .map((word) => capitalize(word.toLowerCase()))
    .join("");
}

function valueIdentifier(value: string, prefix: string): string {
  return IDENTIFIER_PATTERN.test(value) ? value : `${prefix}${capitalize(value)}`;
}

function typeIdentifier(value: string, prefix: string): string {
  return IDENTIFIER_PATTERN.test(value) ? value : `${prefix}${capitalize(value)}`;
}

function identifierWords(segment: string): string[] {
  const words = segment.match(/[A-Za-z0-9]+/g);
  return words && words.length > 0 ? words : ["action"];
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function omitUndefined<TValue extends Record<string, unknown>>(
  value: TValue,
): TValue {
  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }

  return result as TValue;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};

  for (const key of Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const item = sortJson(value[key]);

    if (item !== undefined) {
      sorted[key] = item;
    }
  }

  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
