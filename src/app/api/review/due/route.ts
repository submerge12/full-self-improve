import { createApiRouteHandler } from "../../_shared/route-adapter.js";

export const runtime = "nodejs";
export const GET = createApiRouteHandler("GET", "/api/review/due");
