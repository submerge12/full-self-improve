import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createPage, createSourceWithChunk, recordMasteryUpdate } from "../db/content-store.js";
import { createConcept } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { listTraceEvents } from "../db/trace-store.js";
import type { DocRef, RawDoc, SourceAdapter } from "../engine/source-adapter.js";
import type { ApiRouteId } from "./contracts.js";
import { handleApiRequest, type ApiHandlerContext, type ApiRequest } from "./handlers.js";

class FixtureSourceAdapter implements SourceAdapter {
  readonly id = "fixture";
  readonly kind = "fixture";

  constructor(
    private readonly docs: readonly FixtureDoc[],
    private readonly onReadDocument?: () => Promise<void> | void
  ) {}

  async *listDocuments(): AsyncIterable<DocRef> {
    for (const doc of this.docs) {
      yield this.refFor(doc);
    }
  }

  async readDocument(ref: DocRef): Promise<RawDoc> {
    const doc = this.docs.find((candidate) => candidate.id === ref.id);
    if (doc === undefined) {
      throw new Error(`Missing fixture doc ${ref.id}`);
    }

    await this.onReadDocument?.();

    return {
      ref,
      text: doc.text,
      links: doc.links ?? [],
      mediaRefs: [],
      metadata: doc.metadata ?? {}
    };
  }

  fingerprint(ref: DocRef): string {
    return `fingerprint:${ref.id}`;
  }

  private refFor(doc: FixtureDoc): DocRef {
    return {
      adapterId: this.id,
      id: doc.id,
      kind: "markdown",
      path: doc.id,
      title: doc.title
    };
  }
}

interface FixtureDoc {
  id: string;
  title: string;
  text: string;
  links?: string[];
  metadata?: Record<string, unknown>;
}

describe("pure API request handlers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("unknown routes return a 404 JSON error envelope", async () => {
    const response = await handleApiRequest(request("GET", "/api/not-real"), context());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: "route_not_found",
        message: "API route was not found."
      }
    });
  });

  test("protected routes reject missing auth with 401", async () => {
    const response = await handleApiRequest(request("GET", "/api/plan/today"), context());

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
        routeId: "plan.today"
      }
    });
  });

  test("missing configured bearer token returns 500 before accepting protected routes", async () => {
    const response = await handleApiRequest(
      request("GET", "/api/plan/today", { authorization: "Bearer secret" }),
      context({ expectedBearerToken: undefined })
    );

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: "auth_not_configured",
        routeId: "plan.today"
      }
    });
  });

  test("public wiki pages endpoint works without auth and excludes private pages", async () => {
    const publicConcept = createConcept(db, { slug: "public-topic", name: "Public Topic", status: "generated" });
    const privateConcept = createConcept(db, { slug: "private-topic", name: "Private Topic", status: "generated" });
    const { chunk: publicChunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "public.md",
      title: "Public",
      fingerprint: "public",
      chunkText: "Public cited idea."
    });
    const { chunk: privateChunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "private.md",
      title: "Private",
      fingerprint: "private",
      chunkText: "Private cited idea."
    });
    createPage(db, {
      conceptId: publicConcept.id,
      version: 1,
      markdown: "Public page",
      citationIds: [publicChunk.id],
      visibility: "public"
    });
    createPage(db, {
      conceptId: privateConcept.id,
      version: 1,
      markdown: "Private page",
      citationIds: [privateChunk.id],
      visibility: "private"
    });

    const response = await handleApiRequest(request("GET", "/api/wiki/pages?visibility=public"), context());

    expect(response.status).toBe(200);
    const data = responseData<{ pages: Array<{ markdown: string; visibility: string }> }>(response);
    expect(response.body).toMatchObject({ ok: true, routeId: "wiki.pages" });
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0]).toMatchObject({ markdown: "Public page", visibility: "public" });
  });

  test("GET /api/plan/today is idempotent for the same date and persists trace events", async () => {
    createConcept(db, { slug: "algebra", name: "Algebra", status: "generated" });

    const first = await handleApiRequest(authRequest("GET", "/api/plan/today"), context({ now: fixedNow }));
    const firstData = responseData<PlanTodayData>(first);
    const firstTraceEvents = listTraceEvents(db, { runId: firstData.plan.runId });
    const second = await handleApiRequest(authRequest("GET", "/api/plan/today"), context({ now: fixedNow }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondData = responseData<PlanTodayData>(second);
    expect(secondData.plan).toMatchObject({
      date: firstData.plan.date,
      queue: firstData.plan.queue,
      rationale: firstData.plan.rationale,
      status: firstData.plan.status
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM study_plans").get()).toEqual({ count: 1 });
    expect(firstTraceEvents).toHaveLength(1);
    expect(listTraceEvents(db, { runId: secondData.plan.runId })).toHaveLength(2);
  });

  test("POST ingest with fixture adapter persists content and trace events; unknown adapter returns 404", async () => {
    const adapter = new FixtureSourceAdapter([
      { id: "fundamentals.md", title: "Fundamentals", text: "# Fundamentals\nCore idea." },
      { id: "advanced.md", title: "Advanced", text: "# Advanced\nAdvanced idea.", links: ["Fundamentals"] }
    ]);

    const response = await handleApiRequest(
      authRequest("POST", "/api/ingest/run?adapter=fixture"),
      context({ adapters: { fixture: adapter } })
    );
    const missing = await handleApiRequest(authRequest("POST", "/api/ingest/run?adapter=missing"), context());

    expect(response.status).toBe(200);
    const data = responseData<IngestData>(response);
    expect(data.summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 2,
      chunksCreated: 2
    });
    expect(countRows("sources")).toBe(2);
    expect(countRows("chunks")).toBe(2);
    expect(countRows("concepts")).toBe(2);
    expect(countRows("pages")).toBe(2);
    expect(listTraceEvents(db, { runId: data.summary.runId }).length).toBeGreaterThan(0);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ ok: false, error: { code: "adapter_not_found", routeId: "ingest.run" } });
  });

  test("POST ingest does not hold a handler transaction while awaiting adapter reads", async () => {
    const transactionStates: boolean[] = [];
    const adapter = new FixtureSourceAdapter(
      [{ id: "async.md", title: "Async", text: "# Async\nAdapter read." }],
      async () => {
        await Promise.resolve();
        transactionStates.push(db.inTransaction);
      }
    );

    const response = await handleApiRequest(
      authRequest("POST", "/api/ingest/run?adapter=fixture"),
      context({ adapters: { fixture: adapter } })
    );

    expect(response.status).toBe(200);
    expect(transactionStates).toEqual([false]);
  });

  test("POST quiz grade updates mastery and persists trace events; malformed body returns 400", async () => {
    createConcept(db, { slug: "mitochondria", name: "Mitochondria", status: "generated" });

    const response = await handleApiRequest(
      authRequest("POST", "/api/quiz/grade", {
        conceptSlug: "mitochondria",
        statement: "Powerhouse?",
        answer: "mitochondria",
        response: "mitochondria"
      }),
      context({ now: fixedNow })
    );
    const malformed = await handleApiRequest(
      authRequest("POST", "/api/quiz/grade", { conceptSlug: "mitochondria", response: "mitochondria" }),
      context()
    );

    expect(response.status).toBe(200);
    const data = responseData<QuizData>(response);
    expect(data.result).toMatchObject({ conceptSlug: "mitochondria", verdict: "correct" });
    expect(countRows("mastery")).toBe(1);
    expect(listTraceEvents(db, { runId: data.result.runId }).length).toBeGreaterThan(0);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ ok: false, error: { code: "invalid_request_body", routeId: "quiz.grade" } });
  });

  test("POST quiz grade returns 500 and rolls back mutation rows when trace persistence fails", async () => {
    createConcept(db, { slug: "mitochondria", name: "Mitochondria", status: "generated" });
    failTraceEventInserts();

    const response = await handleApiRequest(
      authRequest("POST", "/api/quiz/grade", {
        conceptSlug: "mitochondria",
        statement: "Powerhouse?",
        answer: "mitochondria",
        response: "mitochondria"
      }),
      context({ now: fixedNow })
    );

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "unexpected_error", routeId: "quiz.grade" }
    });
    expect(countRows("items")).toBe(0);
    expect(countRows("attempts")).toBe(0);
    expect(countRows("mastery")).toBe(0);
    expect(countRows("trace_events")).toBe(0);
  });

  test("POST quiz grade returns 400 for a missing concept", async () => {
    const response = await handleApiRequest(
      authRequest("POST", "/api/quiz/grade", {
        conceptSlug: "missing",
        statement: "Powerhouse?",
        answer: "mitochondria",
        response: "mitochondria"
      }),
      context({ now: fixedNow })
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "invalid_request_body", routeId: "quiz.grade" }
    });
  });

  test("POST teachback updates mastery and rubric and persists trace events; malformed body returns 400", async () => {
    seedTeachbackConcept("retrieval-practice", "Retrieval Practice", "Retrieval practice uses active recall for memory.");

    const response = await handleApiRequest(
      authRequest("POST", "/api/teachback", {
        conceptSlug: "retrieval-practice",
        transcript: "Retrieval practice uses active recall to strengthen memory."
      }),
      context({ now: fixedNow })
    );
    const malformed = await handleApiRequest(
      authRequest("POST", "/api/teachback", { conceptSlug: "retrieval-practice", transcript: "   " }),
      context()
    );

    expect(response.status).toBe(200);
    const data = responseData<TeachbackData>(response);
    expect(data.result.rubricReport).toMatchObject({ gradingMethod: "rubric" });
    expect(data.result.rubricReport.gaps).toEqual(expect.any(Array));
    expect(countRows("teachbacks")).toBe(1);
    expect(countRows("mastery")).toBe(1);
    expect(listTraceEvents(db, { runId: data.result.runId }).length).toBeGreaterThan(0);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ ok: false, error: { code: "invalid_request_body", routeId: "teachback.submit" } });
  });

  test("POST teachback returns 400 when the concept has no page", async () => {
    createConcept(db, { slug: "no-page", name: "No Page", status: "generated" });

    const response = await handleApiRequest(
      authRequest("POST", "/api/teachback", {
        conceptSlug: "no-page",
        transcript: "This concept has no page yet."
      }),
      context({ now: fixedNow })
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "invalid_request_body", routeId: "teachback.submit" }
    });
  });

  test("GET mastery summary returns mastery rows and weak spots, and persists diagnose trace events", async () => {
    const concept = createConcept(db, { slug: "weak", name: "Weak", status: "generated" });
    recordMasteryUpdate(db, {
      conceptId: concept.id,
      score: 0.2,
      confidence: 0.4,
      attemptsN: 2,
      lastSeenAt: "2026-06-12T00:00:00.000Z"
    });

    const response = await handleApiRequest(authRequest("GET", "/api/mastery/summary"), context());

    expect(response.status).toBe(200);
    const data = responseData<MasterySummaryData>(response);
    expect(data.masteryRows).toEqual([
      expect.objectContaining({ conceptSlug: "weak", conceptName: "Weak", score: 0.2, attemptsN: 2 })
    ]);
    expect(data.diagnosis.weakSpots).toEqual([
      expect.objectContaining({ conceptSlug: "weak", score: 0.2 })
    ]);
    expect(listTraceEvents(db, { runId: data.diagnosis.runId })).toHaveLength(1);
  });

  test("POST /api/plan/generate returns 501 after auth and does not create a study plan", async () => {
    createConcept(db, { slug: "algebra", name: "Algebra", status: "generated" });

    const response = await handleApiRequest(authRequest("POST", "/api/plan/generate"), context());

    expect(response.status).toBe(501);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: "not_implemented",
        message: "Forced study plan regeneration is not implemented yet.",
        routeId: "plan.generate"
      }
    });
    expect(countRows("study_plans")).toBe(0);
  });

  function seedTeachbackConcept(slug: string, name: string, markdown: string): void {
    const concept = createConcept(db, { slug, name, status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: `${slug}.md`,
      title: name,
      fingerprint: `fingerprint-${slug}`,
      chunkText: markdown
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown,
      citationIds: [chunk.id],
      visibility: "private"
    });
  }

  function countRows(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  }

  function failTraceEventInserts(): void {
    db.exec(`
      CREATE TRIGGER fail_trace_event_inserts
      BEFORE INSERT ON trace_events
      BEGIN
        SELECT RAISE(FAIL, 'trace storage failed');
      END
    `);
  }

  function context(overrides: Partial<ApiHandlerContext> = {}): ApiHandlerContext {
    return {
      db,
      expectedBearerToken: "secret",
      ...overrides
    };
  }
});

function request(method: ApiRequest["method"], path: string, body?: unknown): ApiRequest {
  return { method, path, headers: {}, body };
}

function authRequest(method: ApiRequest["method"], path: string, body?: unknown): ApiRequest {
  return { method, path, headers: { authorization: "Bearer secret" }, body };
}

function fixedNow(): Date {
  return new Date("2026-06-13T08:00:00.000Z");
}

type SuccessfulApiResponse = {
  readonly status: number;
  readonly body: {
    readonly ok: true;
    readonly routeId: ApiRouteId;
    readonly data: Record<string, unknown>;
  };
};

function expectOk(response: Awaited<ReturnType<typeof handleApiRequest>>): asserts response is SuccessfulApiResponse {
  expect(response.body.ok).toBe(true);
}

function responseData<T extends Record<string, unknown>>(response: Awaited<ReturnType<typeof handleApiRequest>>): T {
  expectOk(response);
  return response.body.data as T;
}

interface PlanTodayData extends Record<string, unknown> {
  plan: {
    runId: string;
    date: string;
    queue: unknown[];
    rationale: string;
    status: string;
  };
}

interface IngestData extends Record<string, unknown> {
  summary: {
    runId: string;
    sourcesSeen: number;
    sourcesProcessed: number;
    chunksCreated: number;
  };
}

interface QuizData extends Record<string, unknown> {
  result: {
    runId: string;
    conceptSlug: string;
    verdict: string;
  };
}

interface TeachbackData extends Record<string, unknown> {
  result: {
    runId: string;
    rubricReport: {
      gradingMethod: string;
      gaps: unknown[];
    };
  };
}

interface MasterySummaryData extends Record<string, unknown> {
  masteryRows: unknown[];
  diagnosis: {
    runId: string;
    weakSpots: unknown[];
  };
}
