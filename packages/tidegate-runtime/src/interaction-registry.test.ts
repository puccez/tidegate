// The behavioral contract of the scoped registry lives in the cross-backend
// conformance suite (`interaction-registry-conformance.ts`), executed against
// the in-memory backend by `interaction-registry.conformance.test.ts`. This
// file only covers the static-interaction helpers.
import { describe, expect, test } from "bun:test";
import { cancelAppointmentContract } from "@tidegate/contracts/fixtures";
import {
  createInteractionRegistry,
  defineInteraction,
} from "./interaction-registry";

describe("interaction registry helpers", () => {
  test("maps static interactions by public interaction id", () => {
    const interaction = defineInteraction({
      contract: cancelAppointmentContract,
      async run(input) {
        return input;
      },
    });

    const registry = createInteractionRegistry([interaction]);

    expect(registry.get("ix.booking.cancelAppointment")).toBe(interaction);
  });
});
