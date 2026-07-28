import { createTidegateActionHandler } from "@tidegate/sdk/server";
import { actions } from "../../../tidegate/actions";

// Protected, executable Tidegate surface: the Tidegate Execution Kernel calls
// this endpoint through the server-side action bridge. Authentication uses
// TIDEGATE_ACTION_BRIDGE_SECRET (compared in constant time); auth context and
// the per-interaction action allowlist arrive in server-derived headers and
// are never taken from the request body.
export const POST = createTidegateActionHandler(actions);
