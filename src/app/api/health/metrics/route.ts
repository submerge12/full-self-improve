import { createApiRouteHandler } from "../../_shared/route-adapter.js";

export const runtime = "nodejs";
export const POST = createApiRouteHandler("POST", "/api/health/metrics");
export const GET = createApiRouteHandler("GET", "/api/health/metrics");
export const PATCH = createApiRouteHandler("PATCH", "/api/health/metrics");
