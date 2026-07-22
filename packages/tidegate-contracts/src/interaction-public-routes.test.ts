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
    expect(TIDEGATE_INTERACTION_API_BASE_PATH).toBe("/api/tidegate/v1");
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
    ).toBe("/api/tidegate/v1/interactions");
    expect(
      publicInteractionInvokeRoute({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toEqual({
      method: "POST",
      path:
        "/api/tidegate/v1/interactions/ix.booking.cancel%20appointment/invoke",
    });
  });

  test("builds legacy invoke and confirmation paths without changing encoding", () => {
    expect(TIDEGATE_LEGACY_INTERACTION_API_BASE_PATH).toBe("/api/tidegate");
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
      "/api/tidegate/interactions/ix.booking.cancel appointment/invoke",
    );
    expect(
      legacyPublicInteractionInvokeRoute({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/tidegate/interactions/ix.booking.cancel appointment/invoke",
    });
    expect(
      legacyPublicInteractionConfirmPath({
        interactionId: "ix.booking.cancel appointment",
      }),
    ).toBe(
      "/api/tidegate/interactions/ix.booking.cancel appointment/confirm",
    );
  });
});
