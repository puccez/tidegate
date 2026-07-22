export const TIDEGATE_INTERACTION_API_BASE_PATH = "/api/v1";
export const TIDEGATE_LEGACY_INTERACTION_API_BASE_PATH = "/api";

export const interactionPublicRoutePaths = {
  getInteraction: ({ interactionId }: { interactionId: string }) =>
    interactionPath(interactionId),
  invokeInteraction: ({ interactionId }: { interactionId: string }) =>
    interactionPath(interactionId, "invoke"),
  listInteractions: () => "interactions",
};

export const legacyInteractionPublicRoutePaths = {
  confirmInteraction: ({ interactionId }: { interactionId: string }) =>
    legacyInteractionPath(interactionId, "confirm"),
  invokeInteraction: ({ interactionId }: { interactionId: string }) =>
    legacyInteractionPath(interactionId, "invoke"),
};

export function absoluteInteractionPublicApiPath(path: string) {
  return `${TIDEGATE_INTERACTION_API_BASE_PATH}/${path.replace(/^\/+/, "")}`;
}

export function absoluteLegacyInteractionPublicApiPath(path: string) {
  return `${TIDEGATE_LEGACY_INTERACTION_API_BASE_PATH}/${path.replace(/^\/+/, "")}`;
}

export function publicInteractionInvokeRoute({
  interactionId,
}: {
  interactionId: string;
}) {
  return {
    method: "POST" as const,
    path: absoluteInteractionPublicApiPath(
      interactionPublicRoutePaths.invokeInteraction({ interactionId }),
    ),
  };
}

export function legacyPublicInteractionInvokeRoute({
  interactionId,
}: {
  interactionId: string;
}) {
  return {
    method: "POST" as const,
    path: absoluteLegacyInteractionPublicApiPath(
      legacyInteractionPublicRoutePaths.invokeInteraction({ interactionId }),
    ),
  };
}

export function legacyPublicInteractionConfirmPath({
  interactionId,
}: {
  interactionId: string;
}) {
  return absoluteLegacyInteractionPublicApiPath(
    legacyInteractionPublicRoutePaths.confirmInteraction({ interactionId }),
  );
}

function interactionPath(interactionId: string, operation?: string) {
  const base = `interactions/${encodePathSegment(interactionId)}`;

  return operation === undefined ? base : `${base}/${operation}`;
}

function legacyInteractionPath(interactionId: string, operation: string) {
  // Existing manifest routes emitted raw IDs; keep the legacy quirk isolated here.
  return `interactions/${interactionId}/${operation}`;
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value);
}
