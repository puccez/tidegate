import ts from "typescript";

export type GeneratedInteractionSourcePolicyFindingCode =
  | "import_disallowed"
  | "raw_action_bypass"
  | "source_policy_disallowed"
  | "unsafe_any";

export type GeneratedInteractionSourcePolicyFinding = {
  code: GeneratedInteractionSourcePolicyFindingCode;
  label: string;
  message: string;
  index?: number;
  specifier?: string;
};

type LexicalSourcePolicyRule = {
  code: GeneratedInteractionSourcePolicyFindingCode;
  label: string;
  message: string;
  pattern: RegExp;
};

const RUNTIME_LEXICAL_SOURCE_POLICY_RULES: LexicalSourcePolicyRule[] = [
  {
    code: "source_policy_disallowed",
    label: "arbitrary imports",
    pattern: /\bimport\s*(?:\(|\.meta|(?!(?:type)\b)(?:[A-Za-z_$*]|\{|["']))/u,
    message: "Imports are not allowed in generated interactions.",
  },
  {
    code: "source_policy_disallowed",
    label: "module re-exports",
    pattern:
      /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?|\{[\s\S]*?\})\s+from\s*["']/u,
    message: "Module re-exports are not allowed in generated interactions.",
  },
  {
    code: "import_disallowed",
    label: "CommonJS require",
    pattern: /\brequire\s*\(/u,
    message: "CommonJS require calls are not allowed in generated interactions.",
  },
  {
    code: "source_policy_disallowed",
    label: "direct network access",
    pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/u,
    message: "Generated interactions cannot access the network directly.",
  },
  {
    code: "source_policy_disallowed",
    label: "host runtime globals",
    pattern:
      /\b(?:Bun|Deno|process|globalThis|global|self|window|document|localStorage|sessionStorage|indexedDB|caches)\b/u,
    message: "Generated interactions cannot read host runtime globals.",
  },
  {
    code: "source_policy_disallowed",
    label: "dynamic code evaluation",
    pattern: /\b(?:eval|Function)\s*\(/u,
    message: "Generated interactions cannot evaluate dynamic code.",
  },
  {
    code: "source_policy_disallowed",
    label: "constructor escape hatches",
    pattern: /\bconstructor\b/u,
    message: "Generated interactions cannot use constructor escape hatches.",
  },
  {
    code: "source_policy_disallowed",
    label: "prototype escape hatches",
    pattern:
      /\b(?:__proto__|prototype|Object|Reflect|Proxy|getOwnProperty|defineProperty|getPrototypeOf|setPrototypeOf)\b/u,
    message: "Generated interactions cannot use prototype escape hatches.",
  },
  {
    code: "source_policy_disallowed",
    label: "direct filesystem access",
    pattern:
      /\b(?:readFile|writeFile|readdir|open|stat|unlink|mkdir|rmdir|node:fs|fs\/promises)\b/u,
    message: "Generated interactions cannot access the filesystem directly.",
  },
  {
    code: "raw_action_bypass",
    label: "raw action caller access",
    pattern:
      /(?:\bactions\s*\.\s*(?:call|invoke)\b|\.\s*actions\s*\.\s*(?:call|invoke)\b)/u,
    message:
      "Generated interactions must call ctx.capabilities.* instead of raw actions.",
  },
];

const PUBLISH_LEXICAL_SOURCE_POLICY_RULES =
  RUNTIME_LEXICAL_SOURCE_POLICY_RULES.filter(
    (rule) =>
      rule.label !== "arbitrary imports" &&
      rule.label !== "module re-exports" &&
      rule.label !== "CommonJS require",
  );

export function collectGeneratedInteractionPublishSourcePolicyFindings(
  source: string,
): GeneratedInteractionSourcePolicyFinding[] {
  return [
    ...collectReferenceDirectiveFindings(source),
    ...collectImportSyntaxPolicyFindings(source),
    ...collectLexicalSourcePolicyFindings(
      source,
      PUBLISH_LEXICAL_SOURCE_POLICY_RULES,
      "publish",
    ),
    ...collectComputedPropertyAccessFindings(source),
    ...collectRawActionBypassFindings(source),
    ...collectUnsafeAnyFindings(source),
  ];
}

export function findGeneratedInteractionRuntimeSourcePolicyFinding(
  source: string,
): GeneratedInteractionSourcePolicyFinding | undefined {
  return (
    findImportSyntaxPolicyFinding(source) ??
    findComputedPropertyAccessFinding(source) ??
    findLexicalSourcePolicyFinding(source, RUNTIME_LEXICAL_SOURCE_POLICY_RULES)
  );
}

export function transpileGeneratedInteractionSource(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      isolatedModules: true,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
    reportDiagnostics: false,
  }).outputText;
}

function collectReferenceDirectiveFindings(
  source: string,
): GeneratedInteractionSourcePolicyFinding[] {
  const findings: GeneratedInteractionSourcePolicyFinding[] = [];
  const pattern =
    /^\s*\/\/\/\s*<reference\s+[^>]*(?:path|types|lib)=["']([^"']+)["'][^>]*>/gm;

  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];

    findings.push({
      code: "import_disallowed",
      label: "TypeScript reference directive",
      index: match.index,
      message:
        "TypeScript reference directives are not allowed in generated interactions.",
      specifier,
    });
  }

  return findings;
}

function collectImportSyntaxPolicyFindings(
  source: string,
): GeneratedInteractionSourcePolicyFinding[] {
  const findings: GeneratedInteractionSourcePolicyFinding[] = [];
  const sourceFile = createGeneratedSourceFile(source);

  visitSourceFile(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);

      if (
        node.importClause?.isTypeOnly === true &&
        specifier !== undefined &&
        importSpecifierIsAllowed(specifier)
      ) {
        return;
      }

      findings.push(importSyntaxFinding(node, specifier));
      return;
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      findings.push({
        code: "import_disallowed",
        label: "module re-exports",
        index: node.getStart(sourceFile),
        message: "Module re-exports are not allowed in generated interactions.",
        specifier: stringLiteralText(node.moduleSpecifier),
      });
      return;
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      findings.push({
        code: "import_disallowed",
        label: "arbitrary imports",
        index: node.getStart(sourceFile),
        message: "Dynamic imports are not allowed in generated interactions.",
        specifier: stringLiteralText(node.arguments[0]),
      });
      return;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      findings.push({
        code: "import_disallowed",
        label: "CommonJS require",
        index: node.getStart(sourceFile),
        message: "CommonJS require calls are not allowed in generated interactions.",
        specifier: stringLiteralText(node.arguments[0]),
      });
    }

    if (ts.isImportTypeNode(node)) {
      findings.push({
        code: "import_disallowed",
        label: "arbitrary imports",
        index: node.getStart(sourceFile),
        message:
          "Import type expressions are not allowed in generated interactions. Use a declaration-level import type from the generated helper instead.",
        specifier: importTypeSpecifier(node),
      });
    }
  });

  return findings;
}

function findImportSyntaxPolicyFinding(
  source: string,
): GeneratedInteractionSourcePolicyFinding | undefined {
  const sourceFile = createGeneratedSourceFile(source);
  let finding: GeneratedInteractionSourcePolicyFinding | undefined;

  visitSourceFile(sourceFile, (node) => {
    if (finding !== undefined) {
      return;
    }

    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);

      if (
        node.importClause?.isTypeOnly === true &&
        specifier !== undefined &&
        importSpecifierIsAllowed(specifier)
      ) {
        return;
      }

      finding = staticSourcePolicyFinding("arbitrary imports");
      return;
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      finding = staticSourcePolicyFinding("module re-exports");
      return;
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      finding = staticSourcePolicyFinding("arbitrary imports");
      return;
    }

    if (ts.isImportTypeNode(node)) {
      finding = staticSourcePolicyFinding("arbitrary imports");
    }
  });

  return finding;
}

function collectLexicalSourcePolicyFindings(
  source: string,
  rules: readonly LexicalSourcePolicyRule[],
  messageMode: "publish" | "runtime",
): GeneratedInteractionSourcePolicyFinding[] {
  const findings: GeneratedInteractionSourcePolicyFinding[] = [];

  for (const rule of rules) {
    const match = rule.pattern.exec(source);

    if (match === null || match.index === undefined) {
      continue;
    }

    findings.push({
      code: rule.code,
      label: rule.label,
      index: match.index,
      message:
        messageMode === "publish"
          ? `${rule.message} Sandbox source policy rejected ${rule.label}.`
          : rule.message,
    });
  }

  return findings;
}

function findLexicalSourcePolicyFinding(
  source: string,
  rules: readonly LexicalSourcePolicyRule[],
): GeneratedInteractionSourcePolicyFinding | undefined {
  return collectLexicalSourcePolicyFindings(source, rules, "runtime")[0];
}

function collectComputedPropertyAccessFindings(
  source: string,
): GeneratedInteractionSourcePolicyFinding[] {
  const findings: GeneratedInteractionSourcePolicyFinding[] = [];
  const sourceFile = createGeneratedSourceFile(source);

  visitSourceFile(sourceFile, (node) => {
    if (!ts.isElementAccessExpression(node)) {
      return;
    }

    findings.push({
      code: "source_policy_disallowed",
      label: "computed property access",
      index: node.argumentExpression.getStart(sourceFile),
      message:
        "Generated interactions cannot use computed property access. Sandbox source policy rejected computed property access.",
    });
  });

  return findings;
}

function findComputedPropertyAccessFinding(
  source: string,
): GeneratedInteractionSourcePolicyFinding | undefined {
  const sourceFile = createGeneratedSourceFile(source);
  let finding: GeneratedInteractionSourcePolicyFinding | undefined;

  visitSourceFile(sourceFile, (node) => {
    if (finding !== undefined) {
      return;
    }

    if (ts.isElementAccessExpression(node)) {
      finding = staticSourcePolicyFinding("computed property access");
    }
  });

  return finding;
}

function collectRawActionBypassFindings(
  source: string,
): GeneratedInteractionSourcePolicyFinding[] {
  const findings: GeneratedInteractionSourcePolicyFinding[] = [];
  const sourceFile = createGeneratedSourceFile(source);

  visitSourceFile(sourceFile, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "actions") {
      findings.push(rawActionBypassFinding(node, sourceFile));
      return;
    }

    if (
      ts.isElementAccessExpression(node) &&
      stringLiteralText(node.argumentExpression) === "actions"
    ) {
      findings.push(rawActionBypassFinding(node, sourceFile));
      return;
    }

    if (bindingElementReadsActions(node)) {
      findings.push(rawActionBypassFinding(node, sourceFile));
    }
  });

  return findings;
}

function collectUnsafeAnyFindings(
  source: string,
): GeneratedInteractionSourcePolicyFinding[] {
  const findings: GeneratedInteractionSourcePolicyFinding[] = [];
  const sourceFile = createGeneratedSourceFile(source);

  visitSourceFile(sourceFile, (node) => {
    if (node.kind !== ts.SyntaxKind.AnyKeyword) {
      return;
    }

    findings.push({
      code: "unsafe_any",
      label: "unsafe any",
      index: node.getStart(sourceFile),
      message:
        "Explicit any is not allowed in generated interactions; use the generated context and schema-derived types.",
    });
  });

  return findings;
}

function importSyntaxFinding(
  node: ts.Node,
  specifier: string | undefined,
): GeneratedInteractionSourcePolicyFinding {
  return {
    code: "import_disallowed",
    label: "arbitrary imports",
    index: node.getStart(),
    message:
      specifier === undefined
        ? "Imports are not allowed in generated interactions."
        : importPolicyMessage(specifier),
    specifier,
  };
}

function rawActionBypassFinding(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): GeneratedInteractionSourcePolicyFinding {
  return {
    code: "raw_action_bypass",
    label: "raw action caller access",
    index: node.getStart(sourceFile),
    message:
      "Generated interactions must call ctx.capabilities.* instead of reading raw actions.",
  };
}

function staticSourcePolicyFinding(
  label: string,
): GeneratedInteractionSourcePolicyFinding {
  return {
    code: "source_policy_disallowed",
    label,
    message: `Sandbox source policy rejected ${label}.`,
  };
}

function createGeneratedSourceFile(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "interaction.generated.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function visitSourceFile(
  sourceFile: ts.SourceFile,
  visitor: (node: ts.Node) => void,
) {
  const visit = (node: ts.Node) => {
    visitor(node);
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function bindingElementReadsActions(node: ts.Node): boolean {
  if (!ts.isBindingElement(node)) {
    return false;
  }

  if (
    node.propertyName !== undefined &&
    bindingNameMatchesIdentifier(node.propertyName, "actions")
  ) {
    return true;
  }

  return (
    node.propertyName === undefined &&
    bindingNameMatchesIdentifier(node.name, "actions")
  );
}

function bindingNameMatchesIdentifier(
  node: ts.BindingName | ts.PropertyName,
  name: string,
): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function importTypeSpecifier(node: ts.ImportTypeNode): string | undefined {
  const argument = node.argument;

  if (!ts.isLiteralTypeNode(argument)) {
    return undefined;
  }

  return stringLiteralText(argument.literal);
}

function importSpecifierIsAllowed(specifier: string) {
  return (
    specifier === "./tidegate-capabilities.generated" ||
    specifier === "./tidegate-capabilities.generated.ts"
  );
}

function importPolicyMessage(specifier: string) {
  if (specifier.startsWith("node:")) {
    return `Node built-in imports are not allowed in generated interactions: ${specifier}.`;
  }

  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  ) {
    return `Local relative imports are not allowed in this publish slice except ./tidegate-capabilities.generated: ${specifier}.`;
  }

  return `Bare package imports are not allowed in generated interactions: ${specifier}.`;
}
