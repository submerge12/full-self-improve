import { createApiRouteHandler } from "../../../_shared/route-adapter.js";

export const runtime = "nodejs";
export const POST = createApiRouteHandler("POST", "/api/health/metrics/import");
