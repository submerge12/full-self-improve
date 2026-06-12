import { describe, expect, test } from "vitest";

import {
  API_ROUTE_MANIFEST,
  ApiAuthConfigurationError,
  ApiAuthError,
  authorizeApiRequest,
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
  { id: "wiki.pages", method: "GET", path: "/api/wiki/pages?visibility=...", auth: "public_read" }
] as const;

describe("API route manifest", () => {
  test("contains exactly the seven PLAN section 2.5 endpoints", () => {
    expect(API_ROUTE_MANIFEST).toHaveLength(7);
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

  test("requires bearer auth for every POST route", () => {
    const postRoutes = API_ROUTE_MANIFEST.filter((route) => route.method === "POST");

    expect(postRoutes).toHaveLength(4);
    expect(postRoutes.every((route) => route.auth === "bearer")).toBe(true);
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
});
