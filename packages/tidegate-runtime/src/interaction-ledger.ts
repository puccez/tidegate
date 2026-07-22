import type {
  InvokeInteractionErrorCode,
  PublishedInteractionArtifact,
} from "@tidegate/contracts";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import {
  InteractionRegistryError,
  type ScopedInteractionRecordResolution,
} from "./interaction-registry.ts";

export type InteractionLedgerRegistry = {
  resolveVisibleInteraction: (input: {
    auth: RuntimeAuthContext;
    interactionId: string;
  }) => ScopedInteractionRecordResolution | undefined;
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

  resolvePublishedInteractionForInvoke({
    auth,
    body,
    interactionId,
  }: {
    auth: RuntimeAuthContext;
    body: unknown;
    interactionId: string;
  }): PublishedInteractionInvokeResolution {
    let resolution: ScopedInteractionRecordResolution | undefined;

    try {
      resolution = this.registry.resolveVisibleInteraction({
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

  resolvePublishedArtifactForRuntime({
    auth,
    interactionId,
  }: {
    auth: RuntimeAuthContext;
    interactionId: string;
  }): PublishedInteractionArtifact | undefined {
    return artifactForPublishedInvoke(
      this.registry.resolveVisibleInteraction({
        auth,
        interactionId,
      }),
    );
  }
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
