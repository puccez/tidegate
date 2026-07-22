import { describe, expect, test } from "bun:test";
import * as sdk from "./index";

describe("@tidegate/sdk root entrypoint", () => {
  test("does not export server API-key helpers", () => {
    expect("createTidegateServerClient" in sdk).toBe(false);
  });
});
