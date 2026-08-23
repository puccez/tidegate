import type {
  InteractionVisibility,
  InvokeInteractionErrorCode,
  PublishedInteractionArtifact,
} from "@tidegate/contracts";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import {
  InteractionRegistryError,
  type ScopedInteractionRecordResolution,
  type ScopedInteractionResolution,
} from "./interaction-registry.ts";
import type { ScopedInteractionRegistryResult } from "./scoped-interaction-registry.ts";

export type InteractionLedgerRegistry = {
  resolveVisibleInteraction: (input: {
    auth: RuntimeAuthContext;
    interactionId: string;
    visibility?: InteractionVisibility;
  }) => ScopedInteractionRegistryResult<
    ScopedInteractionRecordResolution | undefined
  >;
  resolveVersion: (input: {
    auth: RuntimeAuthContext;
    interactionId: string;
    visibility: InteractionVisibility;
    version: string;
  }) => ScopedInteractionRegistryResult<ScopedInteractionResolution | undefined>;
};

/**
 * An interaction pinned (id + exact version) by an app version: the
 * authorization witness for resolving a historical artifact version on the
 * app-bound invoke path. Server-derived from the app aggregate, never from
 * caller input.
 */
export type AppPinnedInteractionRef = {
  readonly interactionId: string;
  readonly version: string;
};

export type PublishedInteractionInvokeResolution =
  | {
      status: "not_found";
      request: unknown;
    }
  | {
      status: "published";
      artifact: PublishedInteractionArtifact;
      request: unknown;
    }
  | {
      status: "unavailable";
      code: Extract<
        InvokeInteractionErrorCode,
        "interaction_revoked" | "interaction_unavailable"
      >;
      message: string;
    }
  | {
      status: "version_mismatch";
      code: Extract<InvokeInteractionErrorCode, "interaction_version_mismatch">;
      message: string;
    };

export function createScopedInteractionLedger({
  registry,
}: {
  registry: InteractionLedgerRegistry;
}) {
  return new ScopedInteractionLedger(registry);
}

export class ScopedInteractionLedger {
  private readonly registry: InteractionLedgerRegistry;

  // Avoid a TypeScript parameter property: the eve runtime loads this module
  // via Node's strip-only type stripping, which rejects parameter properties.
  constructor(registry: InteractionLedgerRegistry) {
    this.registry = registry;
  }

  async resolvePublishedInteractionForInvoke({
    auth,
    body,
    interactionId,
  }: {
    auth: RuntimeAuthContext;
    body: unknown;
    interactionId: string;
  }): Promise<PublishedInteractionInvokeResolution> {
    let resolution: ScopedInteractionRecordResolution | undefined;

    try {
      resolution = await this.registry.resolveVisibleInteraction({
        auth,
        interactionId,
      });
    } catch (error) {
      if (error instanceof InteractionRegistryError) {
        return interactionUnavailableForRecordStatus("archived");
      }

      throw error;
    }

    if (resolution === undefined) {
      return {
        status: "not_found",
        request: body,
      };
    }

    const artifact = artifactForPublishedInvoke(resolution);

    if (artifact === undefined) {
      return interactionUnavailableForRecordStatus(resolution.record.status);
    }

    const request = requestWithResolvedActiveVersion({
      activeVersion: artifact.version,
      body,
    });

    if (request.status === "version_mismatch") {
      return {
        status: "version_mismatch",
        code: "interaction_version_mismatch",
        message:
          "Pinned historical interaction versions are not available on this route yet.",
      };
    }

    return {
      status: "published",
      artifact,
      request: request.body,
    };
  }

  async resolvePublishedArtifactForRuntime({
    auth,
    interactionId,
  }: {
    auth: RuntimeAuthContext;
    interactionId: string;
  }): Promise<PublishedInteractionArtifact | undefined> {
    return artifactForPublishedInvoke(
      await this.registry.resolveVisibleInteraction({
        auth,
        interactionId,
      }),
    );
  }

  /**
   * Resolves the exact interaction version pinned by an app (spec
   * app-catalogo, decision 11) — the ONLY path that may execute a historical
   * artifact version, and only when the app authorizes it:
   *
   * - `pinnedRefs` is the served app version's pinned set, loaded from the
   *   app aggregate server-side; an interaction id (or version) outside it
   *   stays unresolvable, exactly like on the machine invoke route;
   * - `resolutionAuth` is a registry-scope context rebuilt from the app
   *   record (the CREATOR's `user` scope, where app interactions live). It
   *   authorizes WHERE to look, never who executes: the kernel always runs
   *   with the invoker's own auth context, passed separately.
   *
   * The pre-existing invoke path is untouched: without an app in the middle,
   * `resolvePublishedInteractionForInvoke` still serves only the active
   * version and rejects pinned historical versions.
   */
  async resolveAppPinnedInteractionForInvoke({
    body,
    interactionId,
    pinnedRefs,
    resolutionAuth,
  }: {
    body: unknown;
    interactionId: string;
    pinnedRefs: readonly AppPinnedInteractionRef[];
    resolutionAuth: RuntimeAuthContext;
  }): Promise<PublishedInteractionInvokeResolution> {
    const pinned = pinnedRefs.find(
      (ref) => ref.interactionId === interactionId,
    );

    // Fail-closed: an interaction the app does not pin is not invokable
    // through the app, and (unlike the machine route) there is no static
    // fallback to hand the request to.
    if (pinned === undefined) {
      return appInteractionUnavailable();
    }

    let resolution: ScopedInteractionRecordResolution | undefined;

    try {
      resolution = await this.registry.resolveVisibleInteraction({
        auth: resolutionAuth,
        interactionId,
        visibility: "user",
      });
    } catch (error) {
      if (error instanceof InteractionRegistryError) {
        return appInteractionUnavailable();
      }

      throw error;
    }

    if (resolution === undefined) {
      return appInteractionUnavailable();
    }

    const record = resolution.record;
    let artifact: PublishedInteractionArtifact | undefined;

    if (resolution.artifact?.version === pinned.version) {
      artifact = resolution.artifact;
    } else {
      let versionResolution: ScopedInteractionResolution | undefined;

      try {
        versionResolution = await this.registry.resolveVersion({
          auth: resolutionAuth,
          interactionId,
          visibility: "user",
          version: pinned.version,
        });
      } catch (error) {
        if (error instanceof InteractionRegistryError) {
          return appInteractionUnavailable();
        }

        throw error;
      }

      artifact = versionResolution?.artifact;
    }

    if (artifact === undefined) {
      return record.status === "revoked"
        ? interactionUnavailableForRecordStatus(record.status)
        : appInteractionUnavailable();
    }

    // Same availability overlay as the active-version path: the kernel's
    // policy engine denies revoked/archived records, so a record-level
    // revoke keeps winning over any pinned artifact.
    const overlaid =
      artifact.status === record.status
        ? artifact
        : { ...artifact, status: record.status };

    const request = requestWithResolvedActiveVersion({
      activeVersion: pinned.version,
      body,
    });

    if (request.status === "version_mismatch") {
      return {
        status: "version_mismatch",
        code: "interaction_version_mismatch",
        message:
          "The request pins a different interaction version than the one served by this app.",
      };
    }

    return {
      status: "published",
      artifact: overlaid,
      request: request.body,
    };
  }
}

function appInteractionUnavailable(): Extract<
  PublishedInteractionInvokeResolution,
  { status: "unavailable" }
> {
  return {
    status: "unavailable",
    code: "interaction_unavailable",
    message: "This interaction is not available.",
  };
}

function artifactForPublishedInvoke(
  resolution: ScopedInteractionRecordResolution | undefined,
): PublishedInteractionArtifact | undefined {
  if (resolution?.artifact === undefined) {
    return undefined;
  }

  if (resolution.artifact.status === resolution.record.status) {
    return resolution.artifact;
  }

  return {
    ...resolution.artifact,
    status: resolution.record.status,
  };
}

function interactionUnavailableForRecordStatus(
  status: ScopedInteractionRecordResolution["record"]["status"],
): Extract<PublishedInteractionInvokeResolution, { status: "unavailable" }> {
  if (status === "revoked") {
    return {
      status: "unavailable",
      code: "interaction_revoked",
      message: "This interaction has been revoked.",
    };
  }

  return {
    status: "unavailable",
    code: "interaction_unavailable",
    message: "This interaction is not available.",
  };
}

function requestWithResolvedActiveVersion({
  activeVersion,
  body,
}: {
  activeVersion: string;
  body: unknown;
}):
  | { status: "ok"; body: unknown }
  | { status: "version_mismatch" } {
  if (!isRecord(body)) {
    return {
      status: "ok",
      body,
    };
  }

  const requestedVersion = body.interactionVersion;

  if (requestedVersion === undefined) {
    return {
      status: "ok",
      body: {
        ...body,
        interactionVersion: activeVersion,
      },
    };
  }

  if (typeof requestedVersion === "string" && requestedVersion !== activeVersion) {
    return { status: "version_mismatch" };
  }

  return {
    status: "ok",
    body,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
