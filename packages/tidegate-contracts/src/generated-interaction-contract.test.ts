import { describe, expect, test } from "bun:test";
import { cancelAppointmentContract } from "@tidegate/contracts/fixtures";
import { GeneratedInteractionContractV1Schema } from "./generated-interaction-contract";

function clonedContract(): Record<string, unknown> {
  return structuredClone(cancelAppointmentContract) as unknown as Record<
    string,
    unknown
  >;
}

describe("GeneratedInteractionContractV1Schema", () => {
  test("parses the cancel appointment fixture", () => {
    expect(
      GeneratedInteractionContractV1Schema.safeParse(cancelAppointmentContract)
        .success,
    ).toBe(true);
  });

  test("rejects missing allowed actions", () => {
    const contract = clonedContract();
    delete contract.allowedActions;

    expect(GeneratedInteractionContractV1Schema.safeParse(contract).success).toBe(
      false,
    );
  });

  test("rejects an empty interaction id", () => {
    const contract = clonedContract();
    contract.id = "";

    expect(GeneratedInteractionContractV1Schema.safeParse(contract).success).toBe(
      false,
    );
  });

  test("rejects non-revocable visibility", () => {
    const contract = clonedContract();
    contract.visibility = {
      ...(contract.visibility as Record<string, unknown>),
      revocable: false,
    };

    expect(GeneratedInteractionContractV1Schema.safeParse(contract).success).toBe(
      false,
    );
  });

  test("rejects zero execution timeout", () => {
    const contract = clonedContract();
    contract.timeout = {
      ...(contract.timeout as Record<string, unknown>),
      executionMs: 0,
    };

    expect(GeneratedInteractionContractV1Schema.safeParse(contract).success).toBe(
      false,
    );
  });
});
