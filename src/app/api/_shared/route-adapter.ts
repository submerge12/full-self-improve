import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createConfiguredSourceAdapters } from "../../../adapters/config.js";
import { applyMigrations } from "../../../db/migrations.js";
import {
  handleApiRequest,
  type ApiHandlerContext,
  type ApiHandlerResponseBody,
  type ApiRequest
} from "../../../api/handlers.js";
import {
  ApiAuthConfigurationError,
  ApiAuthError,
  authorizeApiRequest,
  findApiRoute,
  type ApiMethod,
  type ApiResponse
} from "../../../api/contracts.js";

export interface RuntimeApiContext {
  readonly context: ApiHandlerContext;
  readonly close: () => void;
}

export type RuntimeApiContextFactory = () => RuntimeApiContext;

export interface WebApiRouteOptions {
  readonly method: ApiMethod;
  readonly path: string;
  readonly contextFactory?: RuntimeApiContextFactory;
  readonly handleRequest?: (
    request: ApiRequest,
    context: ApiHandlerContext
  ) => Promise<ApiResponse<ApiHandlerResponseBody>> | ApiResponse<ApiHandlerResponseBody>;
}

export type AppRouteHandler = (request: Request) => Promise<Response>;

interface RuntimeApiContextTestHooks {
  readonly afterOpen?: (db: Database.Database) => void;
  readonly applyMigrations?: (db: Database.Database) => void;
  readonly createEnvAdapters?: () => ApiHandlerContext["adapters"];
}

class InvalidRequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestBodyError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

let runtimeApiContextTestHooks: RuntimeApiContextTestHooks = {};

export function createApiRouteHandler(method: ApiMethod, path: string): AppRouteHandler {
  return (request) => handleWebApiRequest(request, { method, path });
}

export async function handleWebApiRequest(request: Request, options: WebApiRouteOptions): Promise<Response> {
  const runtime = (options.contextFactory ?? createRuntimeApiContext)();

  try {
    const path = pathWithSearch(options.path, request.url);
    const headers = headersToRecord(request.headers);
    const authResponse = authorizeWebRequest(options.method, path, headers, runtime.context.expectedBearerToken);
    if (authResponse !== undefined) {
      return Response.json(authResponse.body, { status: authResponse.status });
    }

    const body = await requestBody(request);
    const apiResponse = await (options.handleRequest ?? handleApiRequest)(
      {
        method: options.method,
        path,
        headers,
        body
      },
      runtime.context
    );

    return Response.json(apiResponse.body, { status: apiResponse.status });
  } catch (error) {
    if (error instanceof InvalidRequestBodyError) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "invalid_request_body",
            message: error.message
          }
        },
        { status: 400 }
      );
    }

    throw error;
  } finally {
    runtime.close();
  }
}

export function createRuntimeApiContext(): RuntimeApiContext {
  const db = new Database(resolveRuntimeDbPath());
  runtimeApiContextTestHooks.afterOpen?.(db);

  try {
    (runtimeApiContextTestHooks.applyMigrations ?? applyMigrations)(db);
    const adapters = (runtimeApiContextTestHooks.createEnvAdapters ?? createConfiguredSourceAdapters)();

    return {
      context: {
        db,
        expectedBearerToken: process.env.KNOWLEDGE_LOOP_API_TOKEN,
        adapters
      },
      close: () => db.close()
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export const __routeAdapterInternals = {
  resolveRuntimeDbPath,
  setTestHooks(hooks: RuntimeApiContextTestHooks): void {
    runtimeApiContextTestHooks = { ...hooks };
  },
  resetTestHooks(): void {
    runtimeApiContextTestHooks = {};
  }
};

function authorizeWebRequest(
  method: ApiMethod,
  path: string,
  headers: ApiRequest["headers"],
  expectedBearerToken: string | undefined
): ApiResponse<ApiHandlerResponseBody> | undefined {
  const route = findApiRoute(method, path);
  if (route === undefined || route.auth === "public_read") {
    return undefined;
  }

  try {
    authorizeApiRequest(route, headers, expectedBearerToken);
    return undefined;
  } catch (error) {
    if (error instanceof ApiAuthConfigurationError) {
      return {
        status: 500,
        body: {
          ok: false,
          error: {
            code: "auth_not_configured",
            message: error.message,
            routeId: route.id
          }
        }
      };
    }

    if (error instanceof ApiAuthError) {
      return {
        status: 401,
        body: {
          ok: false,
          error: {
            code: "unauthorized",
            message: error.message,
            routeId: route.id
          }
        }
      };
    }

    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: "unexpected_error",
          message: "Unexpected API handler error.",
          routeId: route.id
        }
      }
    };
  }
}

function headersToRecord(headers: Headers): ApiRequest["headers"] {
  const record: Record<string, string> = {};

  for (const [name, value] of headers.entries()) {
    record[name] = value;
  }

  return record;
}

function pathWithSearch(path: string, requestUrl: string): string {
  const url = new URL(requestUrl);

  return `${path}${url.search}`;
}

async function requestBody(request: Request): Promise<unknown> {
  if (request.body === null) {
    return undefined;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    const text = await request.text();
    if (text.length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new InvalidRequestBodyError("Request body must be valid JSON.");
    }
  }

  const text = await request.text();
  return text.length === 0 ? undefined : text;
}

function resolveRuntimeDbPath(): string {
  const configuredPath = process.env.KNOWLEDGE_LOOP_DB_PATH;
  if (configuredPath !== undefined && configuredPath.trim().length > 0) {
    return configuredPath;
  }

  return path.join(projectRoot(), "knowledge-loop.db");
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
}
