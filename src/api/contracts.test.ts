import { describe, expect, test } from "vitest";

import {
  API_ROUTE_MANIFEST,
  ApiAuthConfigurationError,
  ApiAuthError,
  authorizeApiRequest,
  createRouteManifestMarkdown,
  createRouteManifestMarkdownRow,
  createRouteManifestDocument,
  findApiRoute,
  type ApiAuthMode,
  type ApiMethod
} from "./contracts.js";

const expectedRoutes = [
  { id: "ingest.run", method: "POST", path: "/api/ingest/run?adapter=...", auth: "bearer" },
  { id: "plan.today", method: "GET", path: "/api/plan/today", auth: "bearer" },
  { id: "plan.generate", method: "POST", path: "/api/plan/generate", auth: "bearer" },
  { id: "mastery.summary", method: "GET", path: "/api/mastery/summary", auth: "bearer" },
  { id: "quiz.grade", method: "POST", path: "/api/quiz/grade", auth: "bearer" },
  { id: "teachback.submit", method: "POST", path: "/api/teachback", auth: "bearer" },
  { id: "application.task.create", method: "POST", path: "/api/application/task", auth: "bearer" },
  { id: "application.grade", method: "POST", path: "/api/application/grade", auth: "bearer" },
  { id: "review.due", method: "GET", path: "/api/review/due?target=...", auth: "bearer" },
  { id: "review.attempt", method: "POST", path: "/api/review/attempt", auth: "bearer" },
  { id: "wiki.pages", method: "GET", path: "/api/wiki/pages?visibility=...", auth: "public_read" },
  { id: "health.metrics.create", method: "POST", path: "/api/health/metrics", auth: "bearer" },
  { id: "health.metrics.list", method: "GET", path: "/api/health/metrics?metric=...", auth: "bearer" },
  { id: "health.metrics.update", method: "PATCH", path: "/api/health/metrics", auth: "bearer" },
  { id: "health.metrics.import", method: "POST", path: "/api/health/metrics/import", auth: "bearer" },
  { id: "health.exercise.templates.create", method: "POST", path: "/api/health/exercise/templates", auth: "bearer" },
  { id: "health.exercise.plans.create", method: "POST", path: "/api/health/exercise/plans", auth: "bearer" },
  {
    id: "health.exercise.sessions.complete",
    method: "POST",
    path: "/api/health/exercise/sessions/complete",
    auth: "bearer"
  },
  {
    id: "health.exercise.completion",
    method: "GET",
    path: "/api/health/exercise/completion?from=...&to=...",
    auth: "bearer"
  },
  {
    id: "health.sedentary.spans.ingest",
    method: "POST",
    path: "/api/health/sedentary/spans",
    auth: "bearer"
  },
  {
    id: "health.sedentary.summary",
    method: "GET",
    path: "/api/health/sedentary/summary?from=...&to=...",
    auth: "bearer"
  },
  {
    id: "health.break-reminders.evaluate",
    method: "POST",
    path: "/api/health/break-reminders/evaluate",
    auth: "bearer"
  }
] as const;

describe("API route manifest", () => {
  test("contains exactly the documented API endpoints", () => {
    expect(API_ROUTE_MANIFEST).toHaveLength(22);
    expect(
      API_ROUTE_MANIFEST.map((route) => ({
        id: route.id,
        method: route.method,
        path: route.path,
        auth: route.auth
      }))
    ).toEqual(expectedRoutes);

    for (const route of API_ROUTE_MANIFEST) {
      expect(route.description.trim().length).toBeGreaterThan(0);
    }
  });

  test("requires bearer auth for every mutation route", () => {
    const mutationRoutes = API_ROUTE_MANIFEST.filter((route) => route.method === "POST" || route.method === "PATCH");

    expect(mutationRoutes).toHaveLength(15);
    expect(mutationRoutes.every((route) => route.auth === "bearer")).toBe(true);
  });

  test("findApiRoute returns a matching route and is method-sensitive", () => {
    expect(findApiRoute("GET", "/api/plan/today")?.id).toBe("plan.today");
    expect(findApiRoute("POST", "/api/plan/today")).toBeUndefined();
    expect(findApiRoute("GET", "/api/not-real")).toBeUndefined();
  });

  test("findApiRoute matches concrete runtime query values for documented placeholder routes", () => {
    expect(findApiRoute("POST", "/api/ingest/run?adapter=readwise")?.id).toBe("ingest.run");
    expect(findApiRoute("POST", "/api/ingest/run?adapter=...")?.id).toBe("ingest.run");
    expect(findApiRoute("GET", "/api/ingest/run?adapter=readwise")).toBeUndefined();
    expect(findApiRoute("POST", "/api/ingest/run")).toBeUndefined();
    expect(findApiRoute("POST", "/api/ingest/run?adapter=")).toBeUndefined();

    expect(findApiRoute("GET", "/api/wiki/pages?visibility=public")?.id).toBe("wiki.pages");
    expect(findApiRoute("GET", "/api/wiki/pages?visibility=...")?.id).toBe("wiki.pages");
    expect(findApiRoute("POST", "/api/wiki/pages?visibility=public")).toBeUndefined();
    expect(findApiRoute("GET", "/api/wiki/pages?visibility=private")).toBeUndefined();

    expect(findApiRoute("GET", "/api/review/due?target=2026-06-14")?.id).toBe("review.due");
    expect(findApiRoute("GET", "/api/review/due?target=2026-06-14&limit=2")?.id).toBe("review.due");
    expect(findApiRoute("POST", "/api/review/due?target=2026-06-14")).toBeUndefined();
    expect(findApiRoute("GET", "/api/review/due")).toBeUndefined();
    expect(findApiRoute("GET", "/api/review/due?target=")).toBeUndefined();

    expect(findApiRoute("POST", "/api/health/metrics")?.id).toBe("health.metrics.create");
    expect(findApiRoute("POST", "/api/health/metrics?metric=weight")).toBeUndefined();
    expect(findApiRoute("GET", "/api/health/metrics?metric=weight&from=2026-06-14&to=2026-06-15")?.id).toBe(
      "health.metrics.list"
    );
    expect(findApiRoute("GET", "/api/health/metrics?from=bad-date")?.id).toBe("health.metrics.list");
    expect(findApiRoute("GET", "api/health/metrics?metric=weight")).toBeUndefined();
    expect(findApiRoute("GET", "https://evil.test/api/health/metrics?metric=weight")).toBeUndefined();
    expect(findApiRoute("GET", "//evil.test/api/health/metrics?metric=weight")).toBeUndefined();
    expect(findApiRoute("PATCH", "/api/health/metrics")?.id).toBe("health.metrics.update");
    expect(findApiRoute("PATCH", "/api/health/metrics/1")).toBeUndefined();
    expect(findApiRoute("POST", "/api/health/metrics/import")?.id).toBe("health.metrics.import");
    expect(findApiRoute("GET", "/api/health/metrics/import")).toBeUndefined();

    expect(findApiRoute("POST", "/api/health/exercise/templates")?.id).toBe("health.exercise.templates.create");
    expect(findApiRoute("POST", "/api/health/exercise/templates?slug=starter")).toBeUndefined();
    expect(findApiRoute("POST", "/api/health/exercise/plans")?.id).toBe("health.exercise.plans.create");
    expect(findApiRoute("POST", "/api/health/exercise/sessions/complete")?.id).toBe(
      "health.exercise.sessions.complete"
    );
    expect(findApiRoute("GET", "/api/health/exercise/completion?from=2026-06-15&to=2026-06-22")?.id).toBe(
      "health.exercise.completion"
    );
    expect(findApiRoute("GET", "/api/health/exercise/completion")?.id).toBe("health.exercise.completion");
    expect(findApiRoute("POST", "/api/health/exercise/completion?from=2026-06-15&to=2026-06-22")).toBeUndefined();
    expect(findApiRoute("GET", "api/health/exercise/completion?from=2026-06-15&to=2026-06-22")).toBeUndefined();
    expect(
      findApiRoute("GET", "https://evil.test/api/health/exercise/completion?from=2026-06-15&to=2026-06-22")
    ).toBeUndefined();
    expect(findApiRoute("GET", "//evil.test/api/health/exercise/completion?from=2026-06-15&to=2026-06-22")).toBeUndefined();

    expect(findApiRoute("POST", "/api/health/sedentary/spans")?.id).toBe("health.sedentary.spans.ingest");
    expect(findApiRoute("GET", "/api/health/sedentary/spans")).toBeUndefined();
    expect(findApiRoute("POST", "/api/health/sedentary/spans?source=windows")).toBeUndefined();
    expect(findApiRoute("GET", "/api/health/sedentary/summary?from=2026-06-15T00:00:00.000Z&to=2026-06-15T01:00:00.000Z")?.id).toBe(
      "health.sedentary.summary"
    );
    expect(findApiRoute("GET", "/api/health/sedentary/summary")?.id).toBe("health.sedentary.summary");
    expect(findApiRoute("POST", "/api/health/sedentary/summary?from=2026-06-15T00:00:00.000Z&to=2026-06-15T01:00:00.000Z")).toBeUndefined();
    expect(findApiRoute("GET", "api/health/sedentary/summary?from=2026-06-15T00:00:00.000Z&to=2026-06-15T01:00:00.000Z")).toBeUndefined();
    expect(
      findApiRoute(
        "GET",
        "https://evil.test/api/health/sedentary/summary?from=2026-06-15T00:00:00.000Z&to=2026-06-15T01:00:00.000Z"
      )
    ).toBeUndefined();
    expect(findApiRoute("GET", "//evil.test/api/health/sedentary/summary?from=2026-06-15T00:00:00.000Z&to=2026-06-15T01:00:00.000Z")).toBeUndefined();
    expect(findApiRoute("POST", "/api/health/break-reminders/evaluate")?.id).toBe("health.break-reminders.evaluate");
    expect(findApiRoute("GET", "/api/health/break-reminders/evaluate")).toBeUndefined();
    expect(findApiRoute("POST", "/api/health/break-reminders/evaluate?mode=check")).toBeUndefined();
  });
});

describe("API auth helpers", () => {
  test("authorizes public wiki route without a bearer token", () => {
    const route = findApiRoute("GET", "/api/wiki/pages?visibility=...");

    expect(route).toBeDefined();
    expect(() => authorizeApiRequest(route!, {}, undefined)).not.toThrow();
  });

  test("authorizes protected routes with correct bearer token and case-insensitive header names", () => {
    const route = findApiRoute("GET", "/api/plan/today");

    expect(route).toBeDefined();
    expect(() => authorizeApiRequest(route!, { authorization: "Bearer secret-token" }, "secret-token")).not.toThrow();
    expect(() => authorizeApiRequest(route!, { AuThOrIzAtIoN: "Bearer secret-token" }, "secret-token")).not.toThrow();
  });

  test("rejects missing, malformed, and wrong bearer headers for protected routes", () => {
    const route = findApiRoute("POST", "/api/quiz/grade");

    expect(route).toBeDefined();

    const invalidHeaders = [
      {},
      { Authorization: "" },
      { Authorization: "Bearer" },
      { Authorization: "Bearer " },
      { Authorization: "bearer secret-token" },
      { Authorization: "Token secret-token" },
      { Authorization: "Bearer secret-token extra" },
      { Authorization: "Bearer wrong-token" }
    ];

    for (const headers of invalidHeaders) {
      expect(() => authorizeApiRequest(route!, headers, "secret-token")).toThrow(ApiAuthError);
    }
  });

  test("rejects blank configured tokens for protected routes with a configuration error", () => {
    const route = findApiRoute("POST", "/api/teachback");

    expect(route).toBeDefined();
    expect(() => authorizeApiRequest(route!, { Authorization: "Bearer secret-token" }, "  ")).toThrow(
      ApiAuthConfigurationError
    );
  });

  test("rejects missing configured tokens for protected routes with a configuration error", () => {
    const route = findApiRoute("POST", "/api/teachback");

    expect(route).toBeDefined();
    expect(() => authorizeApiRequest(route!, { Authorization: "Bearer secret-token" }, undefined)).toThrow(
      ApiAuthConfigurationError
    );
  });

  test("rejects duplicate or array-valued authorization headers for protected routes", () => {
    const route = findApiRoute("GET", "/api/plan/today");

    expect(route).toBeDefined();
    expect(() =>
      authorizeApiRequest(route!, { Authorization: "Bearer secret-token", authorization: "Bearer wrong-token" }, "secret-token")
    ).toThrow(ApiAuthError);
    expect(() =>
      authorizeApiRequest(route!, { Authorization: ["Bearer secret-token"] }, "secret-token")
    ).toThrow(ApiAuthError);
  });
});

describe("route manifest document", () => {
  test("is generated from the route manifest without count or identity drift", () => {
    const document = createRouteManifestDocument();

    expect(document.routes).toHaveLength(API_ROUTE_MANIFEST.length);
    expect(
      document.routes.map((route) => ({
        id: route.id,
        method: route.method as ApiMethod,
        path: route.path,
        auth: route.auth as ApiAuthMode
      }))
    ).toEqual(
      API_ROUTE_MANIFEST.map((route) => ({
        id: route.id,
        method: route.method,
        path: route.path,
        auth: route.auth
      }))
    );
  });

  test("markdown is generated from the route manifest without count, identity, auth, or description drift", () => {
    const markdown = createRouteManifestMarkdown();

    expect(markdown.startsWith("# knowledge-loop API routes\n\n")).toBe(true);
    expect(markdown.endsWith("\n")).toBe(true);

    const rows = markdown
      .split("\n")
      .filter((line) => line.startsWith("| `") && !line.includes("---"));

    expect(rows).toHaveLength(API_ROUTE_MANIFEST.length);
    expect(rows).toEqual(API_ROUTE_MANIFEST.map((route) => createRouteManifestMarkdownRow(route)));
  });

  test("markdown documents bearer and public read authorization expectations", () => {
    const markdown = createRouteManifestMarkdown();

    expect(markdown).toContain("Bearer routes require `Authorization: Bearer <token>`.");
    expect(markdown).toContain("Public read routes do not require a bearer token.");
  });

  test("markdown route rows escape table separators and backslashes", () => {
    expect(
      createRouteManifestMarkdownRow({
        id: "quiz.grade",
        method: "POST",
        path: "/api/quiz/grade?kind=a|b\\c",
        auth: "bearer",
        description: "Grade A | B using C\\D."
      })
    ).toBe("| `quiz.grade` | `POST` | `/api/quiz/grade?kind=a\\|b\\\\c` | `bearer` | Grade A \\| B using C\\\\D. |");
  });
});
