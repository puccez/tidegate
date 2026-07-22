/**
 * Pure, transport-agnostic sandbox runner core.
 *
 * `runInteraction` is the single implementation of the sandbox-side
 * execution loop: harden globals, load the generated interaction module,
 * build the capability tree, run the interaction, normalize errors. It knows
 * nothing about processes, stdin/stdout, or NDJSON.
 *
 * Two consumers share it so the runner cannot drift:
 *
 * - `createSandboxRunnerSource()` (local process backend) embeds this exact
 *   code into the generated runner script via `Function.prototype.toString()`
 *   and wires it to the NDJSON stdin/stdout transport.
 * - The deterministic test backend (`sandbox-backend-deterministic.ts`)
 *   imports it directly and wires it to an in-memory module loader and a
 *   FIFO-ordered action caller.
 *
 * IMPORTANT: because the exported functions are serialized into the runner
 * source, they MUST stay fully self-contained arrow functions: no captures
 * of module-scope bindings, no imports, and only syntax that survives type
 * stripping as plain portable JavaScript. A guard test asserts the generated
 * runner source still contains the `runInteraction(` call site.
 */

export type SandboxRunnerErrorStatus = "rejected" | "failed";

export type SandboxRunnerError = {
  code: string;
  status: SandboxRunnerErrorStatus;
  message: string;
  retryable?: boolean | undefined;
};

export type SandboxRunnerInteractionModule = {
  readonly default?: unknown;
};

export type RunSandboxInteractionOptions = {
  /** Loads the generated interaction module (dynamic import or in-memory). */
  moduleLoader: () => Promise<SandboxRunnerInteractionModule>;
  input: unknown;
  auth: unknown;
  capabilities: { readonly actionIds: readonly string[] };
  /**
   * Host-mediated action call. Rejections may carry `code` / `status` /
   * `retryable` properties, which the error normalization preserves.
   */
  actionCaller: (actionId: string, input: unknown) => Promise<unknown>;
  /**
   * Strips host globals inside the realm that executes the interaction.
   * Runs before the module loads so top-level interaction code is already
   * hardened.
   */
  hardenGlobals?: (() => void) | undefined;
};

export type RunSandboxInteractionResult =
  | { status: "ok"; output: unknown }
  | { status: "error"; error: SandboxRunnerError };

/**
 * Replaces `console` with a no-op sink and deletes the host globals that
 * generated interactions must never see. Safe to call repeatedly. The
 * sandbox does not rely on this alone: the source policy and
 * code-generation-from-strings restrictions back it up.
 */
export const hardenSandboxGlobals: (
  globalObject: Record<string, unknown>,
) => void = (globalObject) => {
  globalObject.console = {
    debug() {},
    error() {},
    info() {},
    log() {},
    warn() {},
  };

  try {
    delete globalObject.Bun;
    delete globalObject.Deno;
    delete globalObject.fetch;
    delete globalObject.Function;
    delete globalObject.eval;
    delete globalObject.process;
    delete globalObject.require;
    delete globalObject.Buffer;
    delete globalObject.global;
    delete globalObject.self;
    delete globalObject.window;
    delete globalObject.document;
    delete globalObject.XMLHttpRequest;
    delete globalObject.WebSocket;
    delete globalObject.EventSource;
  } catch {
    // Some hosts mark globals non-configurable; the source policy and the
    // code-generation restrictions still fail closed.
  }
};

export const runInteraction: (
  options: RunSandboxInteractionOptions,
) => Promise<RunSandboxInteractionResult> = async ({
  actionCaller,
  auth,
  capabilities,
  hardenGlobals,
  input,
  moduleLoader,
}) => {
  const normalizeError = (error: unknown): SandboxRunnerError => {
    if (error && typeof error === "object") {
      const candidate = error as {
        code?: unknown;
        retryable?: unknown;
        status?: unknown;
      };

      return {
        code:
          typeof candidate.code === "string"
            ? candidate.code
            : "interaction_failed",
        status:
          candidate.status === "rejected" || candidate.status === "failed"
            ? candidate.status
            : "failed",
        message:
          error instanceof Error ? error.message : "Interaction failed.",
        retryable:
          typeof candidate.retryable === "boolean"
            ? candidate.retryable
            : undefined,
      };
    }

    return {
      code: "interaction_failed",
      status: "failed",
      message: "Interaction failed.",
    };
  };

  const createCapabilities = (actionIds: readonly string[]) => {
    // Null-prototype namespaces: an action id segment that collides with an
    // Object.prototype member (for example "toString") must build a fresh
    // namespace instead of reading the inherited member and corrupting it.
    const root: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;

    for (const actionId of actionIds) {
      const segments = actionId.split(".");
      let cursor = root;

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index] ?? "";

        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
          throw new Error(
            "Generated capability action ids must use identifier segments.",
          );
        }

        if (index === segments.length - 1) {
          cursor[segment] = (capabilityInput: unknown) =>
            actionCaller(actionId, capabilityInput);
          continue;
        }

        cursor[segment] ??= Object.create(null) as Record<string, unknown>;
        cursor = cursor[segment] as Record<string, unknown>;
      }
    }

    return root;
  };

  try {
    if (hardenGlobals) {
      hardenGlobals();
    }

    const interactionModule = await moduleLoader();
    const interaction = interactionModule.default;

    if (typeof interaction !== "function") {
      throw new Error(
        "Published interaction must default export a run function.",
      );
    }

    const ctx = {
      auth,
      signal: {
        aborted: false,
        throwIfAborted() {},
      },
      capabilities: createCapabilities(capabilities.actionIds),
    };
    const output: unknown = await interaction(input, ctx);

    return { status: "ok", output };
  } catch (error) {
    return { status: "error", error: normalizeError(error) };
  }
};
