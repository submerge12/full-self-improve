import { describe, expect, test } from "vitest";

import { createAgentDryRunPlan, type AgentIntendedAction } from "./dry-run.js";
import { executeAgentPlan } from "./executor.js";
import {
  createFetchAgentReadClient,
  createHttpBoardClient,
  redactEndpointReference,
  redactText
} from "./http-clients.js";

interface FetchCall {
  readonly input: string | URL | Request;
  readonly init: RequestInit | undefined;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
}

function createSpyFetch(responses: readonly Response[]): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  let index = 0;

  return {
    calls,
    async fetch(input, init) {
      calls.push({ input, init });
      const response = responses[index];
      index += 1;

      if (response === undefined) {
        throw new Error(`Unexpected fetch call ${index}`);
      }

      return response;
    }
  };
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }

  throw new Error("Expected action to throw an Error.");
}

describe("agent HTTP clients", () => {
  test("read client maps endpoint plans to fetch without adding a POST body", async () => {
    const spy = createSpyFetch([jsonResponse({ processed: 3 })]);
    const client = createFetchAgentReadClient({
      fetch: spy.fetch,
      bearerToken: "test-bearer"
    });
    const endpoint = {
      method: "POST",
      url: "http://127.0.0.1:3000/api/ingest/run?adapter=holly-vault",
      purpose: "Run ingest"
    } as const;

    const result = await client.read(endpoint);

    expect(result).toEqual({ endpoint, status: 200, body: { processed: 3 } });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.input).toBe(endpoint.url);
    expect(spy.calls[0]?.init).toMatchObject({
      method: "POST"
    });
    expect(spy.calls[0]?.init?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer test-bearer"
    });
    expect(spy.calls[0]?.init).not.toHaveProperty("body");
  });

  test("read client sends JSON body only for endpoint plans with jsonBody", async () => {
    const spy = createSpyFetch([jsonResponse({ items: ["rice"] })]);
    const client = createFetchAgentReadClient({
      fetch: spy.fetch,
      bearerToken: "test-bearer"
    });
    const endpoint = {
      method: "POST",
      url: "http://127.0.0.1:8000/api/meal-engine/procurement",
      purpose: "Fetch shopping/procurement list",
      jsonBody: { start_date: "2026-06-13" }
    } as const;

    const result = await client.read(endpoint);

    expect(result).toEqual({ endpoint, status: 200, body: { items: ["rice"] } });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.input).toBe(endpoint.url);
    expect(spy.calls[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer test-bearer"
      },
      body: JSON.stringify({ start_date: "2026-06-13" })
    });
  });

  test("read client uses endpoint-origin bearer tokens before fallback bearer", async () => {
    const spy = createSpyFetch([
      jsonResponse({ service: "knowledge-loop" }),
      jsonResponse({ service: "compass-health" }),
      jsonResponse({ service: "fallback" })
    ]);
    const client = createFetchAgentReadClient({
      fetch: spy.fetch,
      bearerToken: "fallback-bearer",
      bearerTokensByOrigin: {
        "http://knowledge.local": "knowledge-bearer",
        "https://compass.local:8443": "compass-bearer"
      }
    });

    await client.read({
      method: "GET",
      url: "http://knowledge.local/api/plan/today",
      purpose: "Fetch plan"
    });
    await client.read({
      method: "GET",
      url: "https://compass.local:8443/api/meal-plan/today?date=2026-06-13",
      purpose: "Fetch meals"
    });
    await client.read({
      method: "GET",
      url: "http://other.local/api/status",
      purpose: "Fetch fallback service"
    });

    expect(spy.calls.map((call) => call.init?.headers)).toEqual([
      {
        Accept: "application/json",
        Authorization: "Bearer knowledge-bearer"
      },
      {
        Accept: "application/json",
        Authorization: "Bearer compass-bearer"
      },
      {
        Accept: "application/json",
        Authorization: "Bearer fallback-bearer"
      }
    ]);
  });

  test("read client honors explicit no-token origins before fallback bearer", async () => {
    const spy = createSpyFetch([jsonResponse({ service: "public" }), jsonResponse({ service: "fallback" })]);
    const client = createFetchAgentReadClient({
      fetch: spy.fetch,
      bearerToken: "fallback-bearer",
      bearerTokensByOrigin: {
        "http://public.local": undefined
      }
    });

    await client.read({
      method: "GET",
      url: "http://public.local/api/status",
      purpose: "Fetch public service"
    });
    await client.read({
      method: "GET",
      url: "http://other.local/api/status",
      purpose: "Fetch fallback service"
    });

    expect(spy.calls.map((call) => call.init?.headers)).toEqual([
      {
        Accept: "application/json"
      },
      {
        Accept: "application/json",
        Authorization: "Bearer fallback-bearer"
      }
    ]);
  });

  test("read client returns text bodies for non-json responses", async () => {
    const spy = createSpyFetch([
      new Response("plain mastery summary", {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    ]);
    const client = createFetchAgentReadClient({ fetch: spy.fetch });
    const endpoint = {
      method: "GET",
      url: "http://127.0.0.1:3000/api/mastery/summary",
      purpose: "Fetch mastery rows"
    } as const;

    await expect(client.read(endpoint)).resolves.toEqual({
      endpoint,
      status: 200,
      body: "plain mastery summary"
    });
  });

  test("read client rejects non-object json responses", async () => {
    const endpoint = {
      method: "GET",
      url: "http://127.0.0.1:3000/api/plan/today",
      purpose: "Fetch plan"
    } as const;

    for (const body of [[], "ok", null]) {
      const client = createFetchAgentReadClient({
        fetch: createSpyFetch([jsonResponse(body)]).fetch
      });
      const error = await captureError(() => client.read(endpoint));

      expect(error.message).toContain("expected JSON object");
    }
  });

  test("read client throws redacted errors for non-2xx and invalid json", async () => {
    const secret = "secret-token";
    const nonOkSpy = createSpyFetch([
      jsonResponse({ error: `do not leak ${secret}` }, { status: 500, statusText: `no ${secret}` })
    ]);
    const nonOkClient = createFetchAgentReadClient({
      fetch: nonOkSpy.fetch,
      bearerToken: secret
    });
    const endpoint = {
      method: "GET",
      url: `http://127.0.0.1:3000/api/plan/today?token=${secret}`,
      purpose: `Fetch plan with ${secret}`
    } as const;

    const nonOkError = await captureError(() => nonOkClient.read(endpoint));
    expect(nonOkError.message).toContain(
      "Agent HTTP read failed: GET http://127.0.0.1:3000/api/plan/today?token=REDACTED returned 500"
    );
    expect(nonOkError.message).not.toContain(secret);

    const invalidJsonSpy = createSpyFetch([
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ]);
    const invalidJsonClient = createFetchAgentReadClient({ fetch: invalidJsonSpy.fetch });

    const invalidJsonError = await captureError(() => invalidJsonClient.read(endpoint));
    expect(invalidJsonError.message).toContain("invalid JSON");
    expect(invalidJsonError.message).not.toContain(secret);
  });

  test("board client posts action payloads to configured endpoints with redacted source endpoints", async () => {
    const action: AgentIntendedAction = {
      target: "multica",
      type: "create_task",
      title: "Scholar study plan for 2026-06-13",
      body: "Study queue",
      checklist: ["Review learn activities"],
      sourceEndpoints: ["GET http://127.0.0.1:3000/api/plan/today?api_key=secret-token"]
    };
    const spy = createSpyFetch([jsonResponse({ id: "task-1", url: "http://multica.local/tasks/task-1" })]);
    const client = createHttpBoardClient({
      fetch: spy.fetch,
      boardId: "daily-plan",
      bearerToken: "secret-token",
      createTaskEndpointUrl: "http://multica.local/api/tasks",
      addCommentEndpointUrl: "http://multica.local/api/comments"
    });

    const result = await client.publish(action);
    const payload = JSON.parse(String(spy.calls[0]?.init?.body));

    expect(result).toEqual({ action, id: "task-1", url: "http://multica.local/tasks/task-1" });
    expect(spy.calls[0]?.input).toBe("http://multica.local/api/tasks");
    expect(spy.calls[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token"
      }
    });
    expect(payload).toEqual({
      boardId: "daily-plan",
      target: "multica",
      type: "create_task",
      title: "Scholar study plan for 2026-06-13",
      body: "Study queue",
      checklist: ["Review learn activities"],
      sourceEndpoints: ["GET http://127.0.0.1:3000/api/plan/today?api_key=REDACTED"]
    });
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });

  test("board client rejects missing endpoints and invalid publish responses", async () => {
    const action: AgentIntendedAction = {
      target: "multica",
      type: "add_comment",
      title: "Librarian ingest report",
      body: "Counts",
      checklist: ["Run ingest"],
      sourceEndpoints: []
    };
    const clientWithoutCommentEndpoint = createHttpBoardClient({
      fetch: createSpyFetch([]).fetch,
      boardId: "daily-plan",
      createTaskEndpointUrl: "http://multica.local/api/tasks"
    });

    await expect(clientWithoutCommentEndpoint.publish(action)).rejects.toThrow(/No endpoint configured/);

    const invalidResponseClient = createHttpBoardClient({
      fetch: createSpyFetch([jsonResponse({ ok: true })]).fetch,
      boardId: "daily-plan",
      addCommentEndpointUrl: "http://multica.local/api/comments"
    });

    await expect(invalidResponseClient.publish(action)).rejects.toThrow(/missing string id/);
  });

  test("board client throws redacted errors for publish failures", async () => {
    const secret = "secret-token";
    const action: AgentIntendedAction = {
      target: "multica",
      type: "add_comment",
      title: "Librarian ingest report",
      body: "Counts",
      checklist: ["Run ingest"],
      sourceEndpoints: []
    };
    const endpointUrl = `http://multica.local/api/comments?token=${secret}`;

    const nonOkClient = createHttpBoardClient({
      fetch: createSpyFetch([jsonResponse({ error: secret }, { status: 503, statusText: `down ${secret}` })]).fetch,
      boardId: "daily-plan",
      bearerToken: secret,
      addCommentEndpointUrl: endpointUrl
    });
    const nonOkError = await captureError(() => nonOkClient.publish(action));
    expect(nonOkError.message).toContain("Agent board publish failed");
    expect(nonOkError.message).toContain("returned 503");
    expect(nonOkError.message).not.toContain(secret);

    const rejectedClient = createHttpBoardClient({
      fetch: async () => {
        throw new Error(`Authorization: Bearer ${secret}`);
      },
      boardId: "daily-plan",
      bearerToken: secret,
      addCommentEndpointUrl: endpointUrl
    });
    const rejectedError = await captureError(() => rejectedClient.publish(action));
    expect(rejectedError.message).toContain("threw Authorization: Bearer REDACTED");
    expect(rejectedError.message).not.toContain(secret);

    const invalidJsonClient = createHttpBoardClient({
      fetch: createSpyFetch([
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      ]).fetch,
      boardId: "daily-plan",
      addCommentEndpointUrl: endpointUrl
    });
    const invalidJsonError = await captureError(() => invalidJsonClient.publish(action));
    expect(invalidJsonError.message).toContain("returned invalid JSON");
    expect(invalidJsonError.message).not.toContain(secret);

    const nonObjectJsonClient = createHttpBoardClient({
      fetch: createSpyFetch([jsonResponse(["not-an-object"])]).fetch,
      boardId: "daily-plan",
      addCommentEndpointUrl: endpointUrl
    });
    await expect(nonObjectJsonClient.publish(action)).rejects.toThrow(/response must be a JSON object/);
  });

  test("board client rejects non-http endpoint URLs", async () => {
    const action: AgentIntendedAction = {
      target: "multica",
      type: "create_task",
      title: "Scholar study plan",
      body: "Study queue",
      checklist: [],
      sourceEndpoints: []
    };
    const client = createHttpBoardClient({
      fetch: createSpyFetch([]).fetch,
      boardId: "daily-plan",
      createTaskEndpointUrl: "file:///G:/multica-ai-multica-https-github-com/tasks"
    });

    await expect(client.publish(action)).rejects.toThrow(/http or https URL/);
  });

  test("board client rejects endpoint URLs with credentials", async () => {
    const action: AgentIntendedAction = {
      target: "multica",
      type: "create_task",
      title: "Scholar study plan",
      body: "Study queue",
      checklist: [],
      sourceEndpoints: []
    };
    const client = createHttpBoardClient({
      fetch: createSpyFetch([]).fetch,
      boardId: "daily-plan",
      createTaskEndpointUrl: "https://user:real-secret@multica.local/api/tasks"
    });

    await expect(client.publish(action)).rejects.toThrow(/must not include URL credentials/);
  });

  test("executor publishes a redacted blocker when the HTTP read client fails", async () => {
    const secret = "secret-token";
    const plan = createAgentDryRunPlan({
      role: "scholar",
      phase: "morning-plan",
      date: "2026-06-13",
      knowledgeLoopBaseUrl: `http://127.0.0.1:3000?token=${secret}`
    });
    const readClient = createFetchAgentReadClient({
      fetch: async () => {
        throw new Error(`network failed with ${secret}`);
      },
      bearerToken: secret
    });
    const publishedActions: AgentIntendedAction[] = [];

    const result = await executeAgentPlan(plan, "live", {
      readClient,
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          return { action, id: "blocker-1" };
        }
      }
    });

    expect(result.status).toBe("blocked");
    expect(publishedActions).toHaveLength(1);
    expect(publishedActions[0]?.body).not.toContain(secret);
    expect(publishedActions[0]?.sourceEndpoints.join("\n")).not.toContain(secret);
    expect(publishedActions[0]?.body).toContain("token=REDACTED");
  });

  test("executor redacts header and key-value secrets from custom read client failures", async () => {
    const plan = createAgentDryRunPlan({
      role: "scholar",
      phase: "morning-plan",
      date: "2026-06-13"
    });
    const leakedValues = ["real-token", "real-cookie-1", "real-cookie-2", "real-key", "real-secret"];
    const publishedActions: AgentIntendedAction[] = [];

    await executeAgentPlan(plan, "live", {
      readClient: {
        async read() {
          throw new Error(
            [
              "Authorization: Bearer real-token",
              "Cookie: harmless=real-cookie-1; custom_session_name=real-cookie-2",
              "api_key=real-key; secret=real-secret"
            ].join("\n")
          );
        }
      },
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          return { action, id: "blocker-1" };
        }
      }
    });

    expect(publishedActions).toHaveLength(1);
    for (const leakedValue of leakedValues) {
      expect(publishedActions[0]?.body).not.toContain(leakedValue);
    }
    expect(publishedActions[0]?.body).toContain("Authorization: Bearer REDACTED");
    expect(publishedActions[0]?.body).toContain("Cookie: REDACTED");
    expect(publishedActions[0]?.body).toContain("api_key=REDACTED");
    expect(publishedActions[0]?.body).toContain("secret=REDACTED");
  });

  test("redacts board-visible text secrets and filesystem paths", () => {
    const cases = [
      { input: "Authorization: Bearer real-token", leak: "real-token", expected: "Authorization: Bearer REDACTED" },
      { input: "Cookie: sid=real-cookie", leak: "real-cookie", expected: "Cookie: REDACTED" },
      { input: "api_key=real-key", leak: "real-key", expected: "api_key=REDACTED" },
      { input: "token=real-token", leak: "real-token", expected: "token=REDACTED" },
      { input: "secret=real-secret", leak: "real-secret", expected: "secret=REDACTED" },
      { input: "sid=real-session", leak: "real-session", expected: "sid=REDACTED" },
      { input: "G:\\pi-harness\\secret.log", leak: "G:\\pi-harness", expected: "PATH_REDACTED" },
      { input: "/home/holly/pi-harness/secret.log", leak: "/home/holly", expected: "PATH_REDACTED" },
      { input: "file:///G:/pi-harness/secret.log", leak: "G:/pi-harness", expected: "PATH_REDACTED" }
    ];

    for (const { input, leak, expected } of cases) {
      const redacted = redactText(`Reason: ${input}`);

      expect(redacted).toContain(expected);
      expect(redacted).not.toContain(leak);
    }
  });

  test("redacts board source endpoint secrets and filesystem paths", () => {
    const cases = [
      {
        input: "GET http://127.0.0.1:3000/api/plan/today?Authorization=Bearer%20real-token",
        leak: "real-token",
        expected: "Authorization=REDACTED"
      },
      {
        input: "GET http://127.0.0.1:3000/api/plan/today?Cookie=sid-real-cookie",
        leak: "sid-real-cookie",
        expected: "Cookie=REDACTED"
      },
      {
        input: "GET http://127.0.0.1:3000/api/plan/today?api_key=real-key",
        leak: "real-key",
        expected: "api_key=REDACTED"
      },
      {
        input: "GET http://127.0.0.1:3000/api/plan/today?token=real-token",
        leak: "real-token",
        expected: "token=REDACTED"
      },
      {
        input: "GET http://127.0.0.1:3000/api/plan/today?secret=real-secret",
        leak: "real-secret",
        expected: "secret=REDACTED"
      },
      {
        input: "GET http://127.0.0.1:3000/api/plan/today?sid=real-session",
        leak: "real-session",
        expected: "sid=REDACTED"
      },
      {
        input: "GET https://user:real-secret@example.com/api/issues",
        leak: "real-secret",
        expected: "https://REDACTED:REDACTED@example.com/api/issues"
      },
      {
        input: "GET G:\\pi-harness\\secret.log?token=real-token",
        leak: "G:\\pi-harness",
        expected: "PATH_REDACTED"
      },
      {
        input: "GET /home/holly/pi-harness/secret.log?token=real-token",
        leak: "/home/holly",
        expected: "PATH_REDACTED"
      },
      {
        input: "GET file:///G:/pi-harness/secret.log?token=real-token",
        leak: "G:/pi-harness",
        expected: "PATH_REDACTED"
      }
    ];

    for (const { input, leak, expected } of cases) {
      const redacted = redactEndpointReference(input);

      expect(redacted).toContain(expected);
      expect(redacted).not.toContain(leak);
      expect(redacted).not.toContain("real-token");
    }
  });
});
