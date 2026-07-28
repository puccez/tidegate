import { createTidegateActionCatalogManifest } from "@tidegate/sdk/server";
import { actions } from "../../../tidegate/actions";

// Non-executable catalog manifest: Tidegate reads it to generate the typed
// ctx.capabilities client for the agent. It carries schemas and policies,
// never code — the real actions execute only through POST /api/actions.
// It is intentionally public metadata; if your deployment must not enumerate
// its action surface, put this route behind your own auth.
const manifest = createTidegateActionCatalogManifest(actions, {
  catalogId: "acme-backend",
});

export function GET() {
  return Response.json(manifest);
}
