export type ApiMethod = "GET" | "POST";

export type ApiAuthMode = "bearer" | "public_read";

export type ApiJsonValue =
  | null
  | string
  | number
  | boolean
  | ApiJsonValue[]
  | { readonly [key: string]: ApiJsonValue };

export type ApiJsonBody = { readonly [key: string]: ApiJsonValue };

export interface ApiRequestHeaders {
  readonly [name: string]: string | readonly string[] | undefined;
}

export interface ApiResponse<T> {
  readonly status: number;
  readonly body: T;
}

export const API_ROUTE_IDS = [
  "ingest.run",
  "plan.today",
  "plan.generate",
  "mastery.summary",
  "quiz.grade",
  "teachback.submit",
  "wiki.pages"
] as const;

export type ApiRouteId = (typeof API_ROUTE_IDS)[number];

export interface ApiRouteManifestEntry {
  readonly id: ApiRouteId;
  readonly method: ApiMethod;
  readonly path: string;
  readonly auth: ApiAuthMode;
  readonly description: string;
}

export const API_ROUTE_MANIFEST = [
  {
    id: "ingest.run",
    method: "POST",
    path: "/api/ingest/run?adapter=...",
    auth: "bearer",
    description: "Trigger an incremental ingest run for the selected source adapter."
  },
  {
    id: "plan.today",
    method: "GET",
    path: "/api/plan/today",
    auth: "bearer",
    description: "Return today's study plan, creating one if it does not already exist."
  },
  {
    id: "plan.generate",
    method: "POST",
    path: "/api/plan/generate",
    auth: "bearer",
    description: "Force regeneration of the study plan."
  },
  {
    id: "mastery.summary",
    method: "GET",
    path: "/api/mastery/summary",
    auth: "bearer",
    description: "Return per-concept mastery and weak spot summaries."
  },
  {
    id: "quiz.grade",
    method: "POST",
    path: "/api/quiz/grade",
    auth: "bearer",
    description: "Submit a quiz attempt for grading."
  },
  {
    id: "teachback.submit",
    method: "POST",
    path: "/api/teachback",
    auth: "bearer",
    description: "Submit a teach-back explanation for rubric grading."
  },
  {
    id: "wiki.pages",
    method: "GET",
    path: "/api/wiki/pages?visibility=...",
    auth: "public_read",
    description: "List wiki pages; public visibility is readable without a bearer token."
  }
] as const satisfies readonly ApiRouteManifestEntry[];

export type ApiRouteManifestDocument = {
  readonly routes: readonly ApiRouteManifestEntry[];
};

export class ApiAuthError extends Error {
  readonly status = 401;

  constructor(message = "API bearer authorization failed") {
    super(message);
    this.name = "ApiAuthError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ApiAuthConfigurationError extends Error {
  readonly status = 500;

  constructor(message = "API bearer token is not configured") {
    super(message);
    this.name = "ApiAuthConfigurationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function findApiRoute(method: ApiMethod, path: string): ApiRouteManifestEntry | undefined {
  return API_ROUTE_MANIFEST.find((route) => route.method === method && routeMatchesPath(route, path));
}

export function authorizeApiRequest(
  route: ApiRouteManifestEntry,
  headers: ApiRequestHeaders,
  expectedBearerToken: string | undefined
): void {
  if (route.auth === "public_read") {
    return;
  }

  if (typeof expectedBearerToken !== "string" || expectedBearerToken.trim().length === 0) {
    throw new ApiAuthConfigurationError();
  }

  const authorization = getSingleHeaderValue(headers, "authorization");
  if (authorization !== `Bearer ${expectedBearerToken}`) {
    throw new ApiAuthError();
  }
}

export function createRouteManifestDocument(): ApiRouteManifestDocument {
  return {
    routes: API_ROUTE_MANIFEST.map((route) => ({ ...route }))
  };
}

function routeMatchesPath(route: ApiRouteManifestEntry, path: string): boolean {
  if (route.path === path) {
    return true;
  }

  if (route.id === "ingest.run") {
    const url = parseApiPath(path);
    const adapter = url?.searchParams.get("adapter");

    return url?.pathname === "/api/ingest/run" && typeof adapter === "string" && adapter.length > 0;
  }

  if (route.id === "wiki.pages") {
    const url = parseApiPath(path);

    return url?.pathname === "/api/wiki/pages" && url.searchParams.get("visibility") === "public";
  }

  return false;
}

function parseApiPath(path: string): URL | undefined {
  try {
    return new URL(path, "https://knowledge-loop.local");
  } catch {
    return undefined;
  }
}

function getSingleHeaderValue(headers: ApiRequestHeaders, expectedName: string): string | undefined {
  let matchedValue: string | undefined;
  let hasMatch = false;

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === expectedName) {
      if (hasMatch || Array.isArray(value)) {
        throw new ApiAuthError();
      }

      hasMatch = true;
      matchedValue = typeof value === "string" ? value : undefined;
    }
  }

  return matchedValue;
}
