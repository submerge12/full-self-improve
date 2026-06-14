import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createPage, createSourceWithChunk } from "../../../db/content-store.js";
import { createConcept } from "../../../db/graph-store.js";
import { applyMigrations, listTables } from "../../../db/migrations.js";
import { upsertPersistentReviewSchedule } from "../../../engine/persistent-review.js";
import type { ApiRequest } from "../../../api/handlers.js";
import {
  __routeAdapterInternals,
  createRuntimeApiContext,
  handleWebApiRequest,
  type RuntimeApiContextFactory
} from "./route-adapter.js";
import { POST as ingestRunPost, runtime as ingestRunRuntime } from "../ingest/run/route.js";
import { GET as planTodayGet, runtime as planTodayRuntime } from "../plan/today/route.js";
import { POST as planGeneratePost, runtime as planGenerateRuntime } from "../plan/generate/route.js";
import { GET as masterySummaryGet, runtime as masterySummaryRuntime } from "../mastery/summary/route.js";
import { POST as quizGradePost, runtime as quizGradeRuntime } from "../quiz/grade/route.js";
import { POST as teachbackPost, runtime as teachbackRuntime } from "../teachback/route.js";
import { POST as applicationTaskPost, runtime as applicationTaskRuntime } from "../application/task/route.js";
import { POST as applicationGradePost, runtime as applicationGradeRuntime } from "../application/grade/route.js";
import { GET as reviewDueGet, runtime as reviewDueRuntime } from "../review/due/route.js";
import { POST as reviewAttemptPost, runtime as reviewAttemptRuntime } from "../review/attempt/route.js";
import { GET as wikiPagesGet, runtime as wikiPagesRuntime } from "../wiki/pages/route.js";

describe("Next app route adapter", () => {
  const originalEnv = { ...process.env };
  const tempFiles: string[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };
    __routeAdapterInternals.resetTestHooks();

    for (const file of tempFiles.splice(0)) {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    }

    for (const dir of tempDirs.splice(0).reverse()) {
      if (existsSync(dir)) {
        rmdirSync(dir);
      }
    }
  });

  test("converts a Web Request into handler input and returns a JSON Web Response", async () => {
    let captured: ApiRequest | undefined;
    const response = await handleWebApiRequest(
      new Request("https://example.test/api/quiz/grade?mode=fast", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-request-id": "abc123"
        },
        body: JSON.stringify({ answer: "memory" })
      }),
      {
        method: "POST",
        path: "/api/quiz/grade",
        contextFactory: inMemoryContextFactory(),
        handleRequest: async (request) => {
          captured = request;
          return {
            status: 202,
            body: { ok: true, routeId: "quiz.grade", data: { accepted: true } }
          };
        }
      }
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: true, routeId: "quiz.grade", data: { accepted: true } });
    expect(captured).toEqual({
      method: "POST",
      path: "/api/quiz/grade?mode=fast",
      headers: expect.objectContaining({
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-request-id": "abc123"
      }),
      body: { answer: "memory" }
    });
  });

  test("returns an API error envelope when an application/json request body is malformed", async () => {
    const response = await handleWebApiRequest(
      new Request("https://example.test/api/quiz/grade", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json"
        },
        body: "{\"conceptSlug\":"
      }),
      {
        method: "POST",
        path: "/api/quiz/grade",
        contextFactory: inMemoryContextFactory(),
        handleRequest: () => {
          throw new Error("handler should not receive malformed JSON");
        }
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "invalid_request_body",
        message: "Request body must be valid JSON."
      }
    });
  });

  test("rejects a protected route without bearer auth through the adapter", async () => {
    const response = await handleWebApiRequest(new Request("https://example.test/api/plan/today"), {
      method: "GET",
      path: "/api/plan/today",
      contextFactory: inMemoryContextFactory({ expectedBearerToken: "secret" })
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "plan.today" }
    });
  });

  test("allows public wiki pages without auth and excludes private pages with an injected context factory", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    seedWikiPages(db);

    const response = await handleWebApiRequest(new Request("https://example.test/api/wiki/pages?visibility=public"), {
      method: "GET",
      path: "/api/wiki/pages",
      contextFactory: () => ({
        context: { db, expectedBearerToken: "secret" },
        close: () => db.close()
      })
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { pages: Array<{ markdown: string; visibility: string }> } };
    expect(body.data.pages).toHaveLength(1);
    expect(body.data.pages[0]).toMatchObject({ markdown: "Public page", visibility: "public" });
  });

  test("actual route modules export the expected HTTP method functions", () => {
    expect(ingestRunPost).toEqual(expect.any(Function));
    expect(planTodayGet).toEqual(expect.any(Function));
    expect(planGeneratePost).toEqual(expect.any(Function));
    expect(masterySummaryGet).toEqual(expect.any(Function));
    expect(quizGradePost).toEqual(expect.any(Function));
    expect(teachbackPost).toEqual(expect.any(Function));
    expect(applicationTaskPost).toEqual(expect.any(Function));
    expect(applicationGradePost).toEqual(expect.any(Function));
    expect(reviewDueGet).toEqual(expect.any(Function));
    expect(reviewAttemptPost).toEqual(expect.any(Function));
    expect(wikiPagesGet).toEqual(expect.any(Function));
  });

  test("actual route modules force the Node.js runtime", () => {
    expect(ingestRunRuntime).toBe("nodejs");
    expect(planTodayRuntime).toBe("nodejs");
    expect(planGenerateRuntime).toBe("nodejs");
    expect(masterySummaryRuntime).toBe("nodejs");
    expect(quizGradeRuntime).toBe("nodejs");
    expect(teachbackRuntime).toBe("nodejs");
    expect(applicationTaskRuntime).toBe("nodejs");
    expect(applicationGradeRuntime).toBe("nodejs");
    expect(reviewDueRuntime).toBe("nodejs");
    expect(reviewAttemptRuntime).toBe("nodejs");
    expect(wikiPagesRuntime).toBe("nodejs");
  });

  test("actual protected route modules accept bearer-authenticated Web requests", async () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-auth-${Date.now()}.db`);
    const vaultRoot = path.join(os.tmpdir(), `knowledge-loop-route-adapter-auth-vault-${Date.now()}`);
    const vaultFile = path.join(vaultRoot, "vault-topic.md");
    tempFiles.push(dbPath);
    tempFiles.push(vaultFile);
    tempDirs.push(vaultRoot);
    mkdirSync(vaultRoot);
    writeFileSync(vaultFile, "# Vault Topic\nA grounded vault topic.", "utf8");
    seedAuthenticatedRouteData(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";
    process.env.KNOWLEDGE_LOOP_VAULT_ROOT = vaultRoot;

    const applicationTaskResponse = await applicationTaskPost(
      jsonRequest("https://example.test/api/application/task", {
        conceptSlug: "application-topic",
        difficulty: 4
      })
    );
    const applicationTaskBody = (await applicationTaskResponse.clone().json()) as {
      data: { result: { itemId: number } };
    };
    const applicationGradeResponse = await applicationGradePost(
      jsonRequest("https://example.test/api/application/grade", {
        itemId: applicationTaskBody.data.result.itemId,
        response:
          "Retrieval practice transfers knowledge into realistic planning scenarios with constraints and feedback."
      })
    );
    const reviewDueResponse = await reviewDueGet(
      new Request("https://example.test/api/review/due?target=2026-06-14", {
        headers: { authorization: "Bearer env-secret" }
      })
    );
    const reviewAttemptResponse = await reviewAttemptPost(
      jsonRequest("https://example.test/api/review/attempt", {
        conceptSlug: "review-topic",
        rating: "good",
        reviewedAt: "2026-06-14T00:00:00.000Z"
      })
    );

    const responses = [
      await ingestRunPost(
        new Request("https://example.test/api/ingest/run?adapter=holly-vault", {
          method: "POST",
          headers: { authorization: "Bearer env-secret" }
        })
      ),
      await planTodayGet(
        new Request("https://example.test/api/plan/today", {
          headers: { authorization: "Bearer env-secret" }
        })
      ),
      await planGeneratePost(
        new Request("https://example.test/api/plan/generate", {
          method: "POST",
          headers: { authorization: "Bearer env-secret" }
        })
      ),
      await masterySummaryGet(
        new Request("https://example.test/api/mastery/summary", {
          headers: { authorization: "Bearer env-secret" }
        })
      ),
      await quizGradePost(
        jsonRequest("https://example.test/api/quiz/grade", {
          conceptSlug: "quiz-topic",
          statement: "What is the answer?",
          answer: "memory",
          response: "memory"
        })
      ),
      await teachbackPost(
        jsonRequest("https://example.test/api/teachback", {
          conceptSlug: "teachback-topic",
          transcript: "Teachback topics use active recall and cited source evidence."
        })
      ),
      applicationTaskResponse,
      applicationGradeResponse,
      reviewDueResponse,
      reviewAttemptResponse
    ];

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200]);
    await expectResponseRouteIds(responses, [
      "ingest.run",
      "plan.today",
      "plan.generate",
      "mastery.summary",
      "quiz.grade",
      "teachback.submit",
      "application.task.create",
      "application.grade",
      "review.due",
      "review.attempt"
    ]);
  });

  test("actual protected route modules reject missing configured bearer tokens before body handling", async () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-auth-config-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    delete process.env.KNOWLEDGE_LOOP_API_TOKEN;

    const response = await planGeneratePost(
      new Request("https://example.test/api/plan/generate", {
        method: "POST",
        headers: { authorization: "Bearer env-secret" }
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "auth_not_configured", routeId: "plan.generate" }
    });
  });

  test("actual protected route modules reject wrong bearer tokens before body handling", async () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-auth-wrong-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const response = await planGeneratePost(
      new Request("https://example.test/api/plan/generate", {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret" }
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "plan.generate" }
    });
  });

  test("actual mutation route modules reject unauthenticated Web requests before body handling", async () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-mutations-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const mutationRoutes = [
      { routeId: "ingest.run", handler: ingestRunPost, url: "https://example.test/api/ingest/run?adapter=fixture" },
      { routeId: "plan.generate", handler: planGeneratePost, url: "https://example.test/api/plan/generate" },
      { routeId: "quiz.grade", handler: quizGradePost, url: "https://example.test/api/quiz/grade" },
      { routeId: "teachback.submit", handler: teachbackPost, url: "https://example.test/api/teachback" },
      {
        routeId: "application.task.create",
        handler: applicationTaskPost,
        url: "https://example.test/api/application/task"
      },
      { routeId: "application.grade", handler: applicationGradePost, url: "https://example.test/api/application/grade" },
      { routeId: "review.attempt", handler: reviewAttemptPost, url: "https://example.test/api/review/attempt" }
    ] as const;

    for (const route of mutationRoutes) {
      const response = await route.handler(new Request(route.url, { method: "POST" }));

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "unauthorized", routeId: route.routeId }
      });
    }
  });

  test("actual mutation route modules reject unauthenticated malformed JSON before parsing the body", async () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-malformed-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const response = await quizGradePost(
      new Request("https://example.test/api/quiz/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"conceptSlug\":"
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "quiz.grade" }
    });
  });

  test("runtime context factory reads env DB path and token and closes its DB", () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const runtime = createRuntimeApiContext();

    expect(runtime.context.expectedBearerToken).toBe("env-secret");
    expect(listTables(runtime.context.db)).toContain("schema_migrations");
    runtime.close();
    expect(() => runtime.context.db.prepare("SELECT 1").get()).toThrow(/database connection is not open/i);
  });

  test("runtime context factory closes the DB if setup fails after opening it", () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-failure-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    let openedDb: Database.Database | undefined;

    __routeAdapterInternals.setTestHooks({
      afterOpen: (db) => {
        openedDb = db;
      },
      applyMigrations: () => {
        throw new Error("migration failed");
      }
    });

    expect(() => createRuntimeApiContext()).toThrow("migration failed");
    expect(openedDb).toBeDefined();
    expect(() => openedDb?.prepare("SELECT 1").get()).toThrow(/database connection is not open/i);
  });

  test("runtime context factory resolves the default DB path to the project root", () => {
    delete process.env.KNOWLEDGE_LOOP_DB_PATH;

    const dbPath = __routeAdapterInternals.resolveRuntimeDbPath();
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

    expect(path.isAbsolute(dbPath)).toBe(true);
    expect(dbPath).toBe(path.join(projectRoot, "knowledge-loop.db"));
  });

  test("runtime context factory preserves an explicit env DB path", () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-env-${Date.now()}.db`);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;

    expect(__routeAdapterInternals.resolveRuntimeDbPath()).toBe(dbPath);
  });

  test("runtime context factory registers the default Holly vault adapter from env", async () => {
    const vaultRoot = path.join(os.tmpdir(), `knowledge-loop-vault-${Date.now()}`);
    const vaultFile = path.join(vaultRoot, "concept.md");
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-vault-${Date.now()}.db`);
    tempFiles.push(vaultFile, dbPath);
    tempDirs.push(vaultRoot);
    mkdirSync(vaultRoot);
    writeFileSync(vaultFile, "---\ntitle: Env Concept\n---\n# Env Concept\n", "utf8");
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_VAULT_ROOT = vaultRoot;

    const runtime = createRuntimeApiContext();
    const docs = [];
    try {
      const adapter = runtime.context.adapters?.["holly-vault"];

      expect(adapter?.id).toBe("holly-vault");
      expect(adapter?.kind).toBe("markdown-vault");
      if (adapter !== undefined) {
        for await (const doc of adapter.listDocuments()) {
          docs.push(doc);
        }
      }
    } finally {
      runtime.close();
    }
    expect(docs).toEqual([expect.objectContaining({ adapterId: "holly-vault", title: "Env Concept" })]);
  });

  test("runtime context factory applies vault include and exclude env filters", async () => {
    const vaultRoot = path.join(os.tmpdir(), `knowledge-loop-vault-filtered-${Date.now()}`);
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-filtered-${Date.now()}.db`);
    const publicDir = path.join(vaultRoot, "notes");
    const excludedDir = path.join(vaultRoot, "90_待确认");
    tempDirs.push(vaultRoot, publicDir, excludedDir);
    mkdirSync(vaultRoot);
    mkdirSync(publicDir);
    mkdirSync(excludedDir);
    const keptFile = path.join(publicDir, "kept.md");
    const draftFile = path.join(publicDir, "draft-ignore.md");
    const excludedFile = path.join(excludedDir, "hidden.md");
    tempFiles.push(keptFile, draftFile, excludedFile, dbPath);
    writeFileSync(keptFile, "---\ntitle: Kept\n---\n# Kept\n", "utf8");
    writeFileSync(draftFile, "---\ntitle: Draft\n---\n# Draft\n", "utf8");
    writeFileSync(excludedFile, "---\ntitle: Hidden\n---\n# Hidden\n", "utf8");
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_VAULT_ROOT = vaultRoot;
    process.env.KNOWLEDGE_LOOP_VAULT_INCLUDE = " notes/**, 90_待确认/** ";
    process.env.KNOWLEDGE_LOOP_VAULT_EXCLUDE = " **/draft-*, 90_待确认/** ";

    const runtime = createRuntimeApiContext();
    const docs = [];
    try {
      const adapter = runtime.context.adapters?.["holly-vault"];
      if (adapter !== undefined) {
        for await (const doc of adapter.listDocuments()) {
          docs.push(doc);
        }
      }
    } finally {
      runtime.close();
    }

    expect(docs.map((doc) => doc.path)).toEqual(["notes/kept.md"]);
  });
});

function inMemoryContextFactory(
  overrides: Partial<ReturnType<RuntimeApiContextFactory>["context"]> = {}
): RuntimeApiContextFactory {
  return () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    return {
      context: {
        db,
        expectedBearerToken: "secret",
        ...overrides
      },
      close: () => db.close()
    };
  };
}

function seedWikiPages(db: Database.Database): void {
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
}

function seedAuthenticatedRouteData(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    createConcept(db, { slug: "quiz-topic", name: "Quiz Topic", status: "generated" });
    const concept = createConcept(db, { slug: "teachback-topic", name: "Teachback Topic", status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "teachback.md",
      title: "Teachback",
      fingerprint: "teachback",
      chunkText: "Teachback topics use active recall and cited source evidence."
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "Teachback topics use active recall and cited source evidence.",
      citationIds: [chunk.id],
      visibility: "private"
    });

    const applicationConcept = createConcept(db, {
      slug: "application-topic",
      name: "Application Topic",
      status: "generated"
    });
    const { chunk: applicationChunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "application.md",
      title: "Application",
      fingerprint: "application",
      chunkText:
        "Retrieval practice transfers knowledge into realistic planning scenarios with constraints and feedback."
    });
    createPage(db, {
      conceptId: applicationConcept.id,
      version: 1,
      markdown: "Retrieval practice transfers knowledge into realistic planning scenarios with constraints and feedback.",
      citationIds: [applicationChunk.id],
      visibility: "private"
    });
    const reviewConcept = createConcept(db, {
      slug: "review-topic",
      name: "Review Topic",
      status: "generated"
    });
    upsertPersistentReviewSchedule(db, {
      conceptId: reviewConcept.id,
      fsrsState: { reviewCount: 0 },
      dueAt: "2026-06-14T00:00:00.000Z"
    });
  } finally {
    db.close();
  }
}

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer env-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function expectResponseRouteIds(responses: readonly Response[], routeIds: readonly string[]): Promise<void> {
  const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ routeId?: string }>));

  expect(bodies.map((body) => body.routeId)).toEqual(routeIds);
}
