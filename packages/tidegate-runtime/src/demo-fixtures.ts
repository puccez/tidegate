import type { JsonSchema } from "@tidegate/contracts";
import { cancelAppointmentContract } from "@tidegate/contracts/fixtures";
import { defineAction, defineActionsCatalog } from "./action-catalog.ts";
import {
  createInteractionRegistry,
  defineInteraction,
} from "./interaction-registry.ts";
import { createJsonSchemaRuntimeSchema } from "./json-schema-runtime.ts";

const bookingCancelInputSchema = {
  type: "object",
  required: ["appointmentId"],
  properties: {
    appointmentId: { type: "string" },
    reason: { type: "string" },
  },
  additionalProperties: false,
} satisfies JsonSchema;

const bookingCancelOutputSchema = {
  type: "object",
  required: ["ok", "appointmentId"],
  properties: {
    ok: { type: "boolean" },
    appointmentId: { type: "string" },
  },
  additionalProperties: false,
} satisfies JsonSchema;

type BookingCancelInput = {
  appointmentId: string;
  reason?: string;
};

type BookingCancelOutput = {
  ok: boolean;
  appointmentId: string;
};

export const demoActions = defineActionsCatalog({
  "booking.cancel": defineAction({
    id: "booking.cancel",
    description: "Cancel one appointment in the current salon.",
    effects: "write",
    requiredPermissions: ["booking:write"],
    tenantScope: {
      tenantId: "demo-salon",
    },
    inputSchema:
      createJsonSchemaRuntimeSchema<BookingCancelInput>(bookingCancelInputSchema),
    outputSchema:
      createJsonSchemaRuntimeSchema<BookingCancelOutput>(bookingCancelOutputSchema),
    async execute({ input, auth }) {
      return {
        ok: true,
        appointmentId: input.appointmentId,
      };
    },
  }),
});

export const cancelAppointmentInteraction = defineInteraction({
  contract: cancelAppointmentContract,
  async run(input, ctx) {
    return ctx.actions.call("booking.cancel", input);
  },
});

export const demoInteractions = createInteractionRegistry([
  cancelAppointmentInteraction,
]);
