import { describe, expect, test } from "bun:test";
import {
  absoluteInteractionPublicApiPath,
  absoluteLegacyInteractionPublicApiPath,
  interactionPublicRoutePaths,
  legacyInteractionPublicRoutePaths,
  legacyPublicInteractionConfirmPath,
  legacyPublicInteractionInvokeRoute,
  publicInteractionInvokeRoute,
  TIDEGATE_INTERACTION_API_BASE_PATH,
  TIDEGATE_LEGACY_INTERACTION_API_BASE_PATH,
} from "./interaction-public-routes";

describe("interaction public routes", () => {
  test("builds canonical discovery and invoke paths", () => {
    expect(TIDEGATE_INTERACTION_API_BASE_PATH).toBe("/api/v1");
    expect(interactionPublicRoutePaths.listInteractions()).toBe("interactions");
    expect(
      interactionPublicRoutePaths.getInteraction({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toBe("interactions/ix.booking.cancel%20appointment");
    expect(
      interactionPublicRoutePaths.invokeInteraction({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toBe("interactions/ix.booking.cancel%20appointment/invoke");
  });

  test("builds absolute invoke routes", () => {
    expect(
      absoluteInteractionPublicApiPath(
        interactionPublicRoutePaths.listInteractions(),
      ),
    ).toBe("/api/v1/interactions");
    expect(
      publicInteractionInvokeRoute({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toEqual({
      method: "POST",
      path:
        "/api/v1/interactions/ix.booking.cancel%20appointment/invoke",
    });
  });

  test("builds legacy invoke and confirmation paths without changing encoding", () => {
    expect(TIDEGATE_LEGACY_INTERACTION_API_BASE_PATH).toBe("/api");
    expect(
      legacyInteractionPublicRoutePaths.invokeInteraction({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toBe("interactions/ix.booking.cancel appointment/invoke");
    expect(
      legacyInteractionPublicRoutePaths.confirmInteraction({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toBe("interactions/ix.booking.cancel appointment/confirm");
    expect(
      absoluteLegacyInteractionPublicApiPath(
        legacyInteractionPublicRoutePaths.invokeInteraction({
          interactionId: "ix.booking.cancel appointment",
        }),
      ),
    ).toBe(
      "/api/interactions/ix.booking.cancel appointment/invoke",
    );
    expect(
      legacyPublicInteractionInvokeRoute({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/interactions/ix.booking.cancel appointment/invoke",
    });
    expect(
      legacyPublicInteractionConfirmPath({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toBe(
      "/api/interactions/ix.booking.cancel appointment/confirm",
    );
  });
});
