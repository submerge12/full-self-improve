import { createReadOnlyApiRouteHandler } from "../../_shared/route-adapter.js";

export const runtime = "nodejs";
export const GET = createReadOnlyApiRouteHandler("GET", "/api/ops/dashboard");
