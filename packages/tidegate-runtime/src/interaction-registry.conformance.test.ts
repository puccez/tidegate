import { runScopedInteractionRegistryConformance } from "./interaction-registry-conformance.ts";
import { createScopedInteractionRegistry } from "./interaction-registry.ts";

runScopedInteractionRegistryConformance({
  name: "in-memory",
  createRegistry: createScopedInteractionRegistry,
});
