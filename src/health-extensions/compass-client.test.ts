import { describe, expect, test } from "vitest";

import { createCompassHealthClient } from "./compass-client.js";

describe("compass health HTTP client", () => {
  test("rejects non-http base URLs, local paths, credentials, blanks, and malformed URLs", () => {
    const fetch = createJsonFetch({ ok: true });

    for (const baseUrl of [
      "file:///C:/Users/Holly/compass-health/db.sqlite",
      "C:\\Users\\Holly\\compass-health",
      "https://user:pass@example.test",
      "ftp://example.test",
      "",
      "not a url"
    ]) {
      expect(() => createCompassHealthClient({ baseUrl, fetch })).toThrow("baseUrl must be an HTTP(S) URL");
    }
  });

  test("reads daily context through deterministic GET URL with bearer auth", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({ meals: [{ name: "breakfast" }] });
    };

    const client = createCompassHealthClient({
      baseUrl: "https://compass.example.test/public/",
      bearerToken: "live-token-123",
      fetch
    });

    const context = await client.readDailyContext("2026-06-14");

    expect(context).toEqual({
      sourceUrl: "https://compass.example.test/public/api/meal-plan/daily-context?date=2026-06-14",
      meals: { meals: [{ name: "breakfast" }] }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      input: "https://compass.example.test/public/api/meal-plan/daily-context?date=2026-06-14",
      init: {
        method: "GET",
        headers: {
          Authorization: "Bearer live-token-123"
        }
      }
    });
  });

  test("returns unavailable reason without leaking bearer token when fetch fails", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("network failure for live-token-123");
    };
    const client = createCompassHealthClient({
      baseUrl: "https://compass.example.test",
      bearerToken: "live-token-123",
      fetch
    });

    const context = await client.readDailyContext("2026-06-14");

    expect(context.sourceUrl).toBe("https://compass.example.test/api/meal-plan/daily-context?date=2026-06-14");
    expect(context.meals).toBeUndefined();
    expect(context.unavailableReason).toBe("compass-health request failed");
    expect(context.unavailableReason).not.toContain("live-token-123");
  });

  test("returns unavailable reason for non-ok responses without parsing body content", async () => {
    const fetch = createJsonFetch({ ok: false, status: 503, body: { error: "live-token-123" } });
    const client = createCompassHealthClient({
      baseUrl: "https://compass.example.test",
      bearerToken: "live-token-123",
      fetch
    });

    const context = await client.readDailyContext("2026-06-14");

    expect(context).toEqual({
      sourceUrl: "https://compass.example.test/api/meal-plan/daily-context?date=2026-06-14",
      unavailableReason: "compass-health returned HTTP 503"
    });
  });

  test("returns unavailable reason for invalid JSON responses", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const client = createCompassHealthClient({ baseUrl: "https://compass.example.test", fetch });

    const context = await client.readDailyContext("2026-06-14");

    expect(context).toEqual({
      sourceUrl: "https://compass.example.test/api/meal-plan/daily-context?date=2026-06-14",
      unavailableReason: "compass-health response was not valid JSON"
    });
  });

  test("rejects invalid ISO dates before calling fetch", async () => {
    let called = false;
    const fetch: typeof globalThis.fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    const client = createCompassHealthClient({ baseUrl: "https://compass.example.test", fetch });

    await expect(client.readDailyContext("2026-02-31")).rejects.toThrow("date must be an ISO date");
    await expect(client.readDailyContext("2026-6-14")).rejects.toThrow("date must be an ISO date");
    expect(called).toBe(false);
  });
});

function createJsonFetch(options: { ok: boolean; status?: number; body?: unknown }): typeof globalThis.fetch {
  return async () => jsonResponse(options.body ?? {}, options.status ?? (options.ok ? 200 : 500));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
