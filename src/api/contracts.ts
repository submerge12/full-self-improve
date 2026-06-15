export type ApiMethod = "GET" | "POST" | "PATCH";

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
  "application.task.create",
  "application.grade",
  "review.due",
  "review.attempt",
  "wiki.pages",
  "health.metrics.create",
  "health.metrics.list",
  "health.metrics.update",
  "health.metrics.import",
  "health.exercise.templates.create",
  "health.exercise.plans.create",
  "health.exercise.sessions.complete",
  "health.exercise.completion",
  "health.sedentary.spans.ingest",
  "health.sedentary.summary",
  "health.break-reminders.evaluate",
  "health.coach-digest.generate"
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
    id: "application.task.create",
    method: "POST",
    path: "/api/application/task",
    auth: "bearer",
    description: "Generate an application task for a concept."
  },
  {
    id: "application.grade",
    method: "POST",
    path: "/api/application/grade",
    auth: "bearer",
    description: "Submit an application response for rubric grading."
  },
  {
    id: "review.due",
    method: "GET",
    path: "/api/review/due?target=...",
    auth: "bearer",
    description: "List persistent reviews due on or before the target day."
  },
  {
    id: "review.attempt",
    method: "POST",
    path: "/api/review/attempt",
    auth: "bearer",
    description: "Record a persistent review attempt and update mastery."
  },
  {
    id: "wiki.pages",
    method: "GET",
    path: "/api/wiki/pages?visibility=...",
    auth: "public_read",
    description: "List wiki pages; public visibility is readable without a bearer token."
  },
  {
    id: "health.metrics.create",
    method: "POST",
    path: "/api/health/metrics",
    auth: "bearer",
    description: "Create one manual health metric observation."
  },
  {
    id: "health.metrics.list",
    method: "GET",
    path: "/api/health/metrics?metric=...",
    auth: "bearer",
    description: "List health metric observations by metric and optional date window."
  },
  {
    id: "health.metrics.update",
    method: "PATCH",
    path: "/api/health/metrics",
    auth: "bearer",
    description: "Update one health metric observation by id with an audit reason."
  },
  {
    id: "health.metrics.import",
    method: "POST",
    path: "/api/health/metrics/import",
    auth: "bearer",
    description: "Import health metric observations from CSV text."
  },
  {
    id: "health.exercise.templates.create",
    method: "POST",
    path: "/api/health/exercise/templates",
    auth: "bearer",
    description: "Create or update a reusable exercise template with default weekly sessions."
  },
  {
    id: "health.exercise.plans.create",
    method: "POST",
    path: "/api/health/exercise/plans",
    auth: "bearer",
    description: "Create a weekly exercise plan from an existing template."
  },
  {
    id: "health.exercise.sessions.complete",
    method: "POST",
    path: "/api/health/exercise/sessions/complete",
    auth: "bearer",
    description: "Complete a planned exercise session or record an ad hoc session."
  },
  {
    id: "health.exercise.completion",
    method: "GET",
    path: "/api/health/exercise/completion?from=...&to=...",
    auth: "bearer",
    description: "Summarize planned and ad hoc exercise completion for a required date window."
  },
  {
    id: "health.sedentary.spans.ingest",
    method: "POST",
    path: "/api/health/sedentary/spans",
    auth: "bearer",
    description: "Ingest one sedentary span from the Windows logger."
  },
  {
    id: "health.sedentary.summary",
    method: "GET",
    path: "/api/health/sedentary/summary?from=...&to=...",
    auth: "bearer",
    description: "Summarize sedentary, active, and unknown minutes for a required instant window."
  },
  {
    id: "health.break-reminders.evaluate",
    method: "POST",
    path: "/api/health/break-reminders/evaluate",
    auth: "bearer",
    description: "Evaluate whether the current sedentary streak is eligible for a break reminder."
  },
  {
    id: "health.coach-digest.generate",
    method: "POST",
    path: "/api/health/coach-digest/generate",
    auth: "bearer",
    description: "Generate a dry-run coach digest snapshot from health extension data and optional compass context."
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

export function createRouteManifestMarkdown(): string {
  const rows = API_ROUTE_MANIFEST.map(createRouteManifestMarkdownRow);

  return [
    "# knowledge-loop API routes",
    "",
    "Generated from `API_ROUTE_MANIFEST`.",
    "",
    "Bearer routes require `Authorization: Bearer <token>`.",
    "Public read routes do not require a bearer token.",
    "",
    "| Route ID | Method | Path | Auth | Description |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    ""
  ].join("\n");
}

export function createRouteManifestMarkdownRow(route: ApiRouteManifestEntry): string {
  const cells = [
    codeTableCell(route.id),
    codeTableCell(route.method),
    codeTableCell(route.path),
    codeTableCell(route.auth),
    markdownTableCell(route.description)
  ];

  return `| ${cells.join(" | ")} |`;
}

function codeTableCell(value: string): string {
  return `\`${markdownTableCell(value)}\``;
}

function markdownTableCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
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

  if (route.id === "review.due") {
    const url = parseApiPath(path);
    const target = url?.searchParams.get("target");

    return url?.pathname === "/api/review/due" && typeof target === "string" && target.length > 0;
  }

  if (route.id === "health.metrics.list") {
    if (!isLocalApiPathString(path)) {
      return false;
    }

    const url = parseApiPath(path);

    return url?.pathname === "/api/health/metrics";
  }

  if (route.id === "health.exercise.completion") {
    if (!isLocalApiPathString(path)) {
      return false;
    }

    const url = parseApiPath(path);

    return url?.pathname === "/api/health/exercise/completion";
  }

  if (route.id === "health.sedentary.summary") {
    if (!isLocalApiPathString(path)) {
      return false;
    }

    const url = parseApiPath(path);

    return url?.pathname === "/api/health/sedentary/summary";
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

function isLocalApiPathString(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
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
