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
  type AppRouteHandler,
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
import { GET as opsDashboardGet, runtime as opsDashboardRuntime } from "../ops/dashboard/route.js";

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
    expect(opsDashboardGet).toEqual(expect.any(Function));
  });

  test("actual health route modules export the expected HTTP method functions", async () => {
    const { metrics, metricsImport } = await importHealthRouteModules();
    const { coachDigestGenerate, coachDigestPublish } = await importHealthCoachDigestRouteModules();
    const { templates, plans, sessionsComplete, completion } = await importHealthExerciseRouteModules();
    const { sedentarySpans, sedentarySummary, breakReminderEvaluate } = await importSedentaryRouteModules();

    expect(exportKeys(metrics)).toEqual(["GET", "PATCH", "POST", "runtime"]);
    expect(metrics.POST).toEqual(expect.any(Function));
    expect(metrics.GET).toEqual(expect.any(Function));
    expect(metrics.PATCH).toEqual(expect.any(Function));
    expect(exportKeys(metricsImport)).toEqual(["POST", "runtime"]);
    expect(metricsImport.POST).toEqual(expect.any(Function));
    expect(exportKeys(coachDigestGenerate)).toEqual(["POST", "runtime"]);
    expect(coachDigestGenerate.POST).toEqual(expect.any(Function));
    expect(exportKeys(coachDigestPublish)).toEqual(["POST", "runtime"]);
    expect(coachDigestPublish.POST).toEqual(expect.any(Function));
    expect(exportKeys(templates)).toEqual(["POST", "runtime"]);
    expect(templates.POST).toEqual(expect.any(Function));
    expect(exportKeys(plans)).toEqual(["POST", "runtime"]);
    expect(plans.POST).toEqual(expect.any(Function));
    expect(exportKeys(sessionsComplete)).toEqual(["POST", "runtime"]);
    expect(sessionsComplete.POST).toEqual(expect.any(Function));
    expect(exportKeys(completion)).toEqual(["GET", "runtime"]);
    expect(completion.GET).toEqual(expect.any(Function));
    expect(exportKeys(sedentarySpans)).toEqual(["POST", "runtime"]);
    expect(sedentarySpans.POST).toEqual(expect.any(Function));
    expect(exportKeys(sedentarySummary)).toEqual(["GET", "runtime"]);
    expect(sedentarySummary.GET).toEqual(expect.any(Function));
    expect(exportKeys(breakReminderEvaluate)).toEqual(["POST", "runtime"]);
    expect(breakReminderEvaluate.POST).toEqual(expect.any(Function));
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
    expect(opsDashboardRuntime).toBe("nodejs");
  });

  test("actual health route modules force the Node.js runtime", async () => {
    const { metrics, metricsImport } = await importHealthRouteModules();
    const { coachDigestGenerate, coachDigestPublish } = await importHealthCoachDigestRouteModules();
    const { templates, plans, sessionsComplete, completion } = await importHealthExerciseRouteModules();
    const { sedentarySpans, sedentarySummary, breakReminderEvaluate } = await importSedentaryRouteModules();

    expect(metrics.runtime).toBe("nodejs");
    expect(metricsImport.runtime).toBe("nodejs");
    expect(coachDigestGenerate.runtime).toBe("nodejs");
    expect(coachDigestPublish.runtime).toBe("nodejs");
    expect(templates.runtime).toBe("nodejs");
    expect(plans.runtime).toBe("nodejs");
    expect(sessionsComplete.runtime).toBe("nodejs");
    expect(completion.runtime).toBe("nodejs");
    expect(sedentarySpans.runtime).toBe("nodejs");
    expect(sedentarySummary.runtime).toBe("nodejs");
    expect(breakReminderEvaluate.runtime).toBe("nodejs");
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
      reviewAttemptResponse,
      await opsDashboardGet(
        new Request("https://example.test/api/ops/dashboard", {
          headers: { authorization: "Bearer env-secret" }
        })
      )
    ];

    expect(responses.map((response) => response.status)).toEqual([
      200,
      200,
      200,
      200,
      200,
      200,
      200,
      200,
      200,
      200,
      200
    ]);
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
      "review.attempt",
      "ops.dashboard"
    ]);
  });

  test("actual ops dashboard route rejects unauthenticated requests without creating a missing DB", async () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-ops-dashboard-auth-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const response = await opsDashboardGet(new Request("https://example.test/api/ops/dashboard"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "ops.dashboard" }
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  test("actual ops dashboard route reads an existing DB without mutating dashboard rows", async () => {
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-ops-dashboard-readonly-${Date.now()}.db`);
    tempFiles.push(dbPath);
    seedOpsDashboardRouteData(dbPath);
    const beforeRows = readDashboardRouteRows(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const response = await opsDashboardGet(
      new Request("https://example.test/api/ops/dashboard", {
        headers: { authorization: "Bearer env-secret" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      routeId: "ops.dashboard",
      data: {
        summary: {
          tableCounts: {
            sources: 1,
            chunks: 1,
            trace_events: 1
          }
        }
      }
    });
    expect(readDashboardRouteRows(dbPath)).toEqual(beforeRows);
  });

  test("actual health route modules accept bearer-authenticated Web requests", async () => {
    const { metrics, metricsImport } = await importHealthRouteModules();
    const { coachDigestGenerate, coachDigestPublish } = await importHealthCoachDigestRouteModules();
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-health-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const createResponse = await metrics.POST(
      jsonRequest("https://example.test/api/health/metrics", {
        metricKey: "Weight",
        metricLabel: "Weight",
        value: 58.2,
        unit: "kg",
        observedAt: "2026-06-14T08:00:00.000Z"
      })
    );
    const createBody = (await createResponse.clone().json()) as {
      data: { result: { metric: { id: number } } };
    };
    const listResponse = await metrics.GET(
      new Request("https://example.test/api/health/metrics?metric=weight&from=2026-06-14&to=2026-06-14", {
        headers: { authorization: "Bearer env-secret" }
      })
    );
    const updateResponse = await metrics.PATCH(
      jsonRequest(
        "https://example.test/api/health/metrics",
        {
          id: createBody.data.result.metric.id,
          value: 58.0,
          reason: "corrected morning reading"
        },
        "PATCH"
      )
    );
    const importResponse = await metricsImport.POST(
      jsonRequest("https://example.test/api/health/metrics/import", {
        sourceFilename: "metrics.csv",
        csvText: [
          "metric_key,metric_label,value,unit,observed_at,source,note",
          "sleep,Sleep,7.5,h,2026-06-14T22:00:00.000Z,csv,night"
        ].join("\n")
      })
    );
    const coachDigestResponse = await coachDigestGenerate.POST(
      jsonRequest("https://example.test/api/health/coach-digest/generate", {
        date: "2026-06-14",
        offline: true
      })
    );
    const coachDigestBody = (await coachDigestResponse.clone().json()) as {
      data: { result: { snapshot: { id: number } } };
    };
    const coachDigestPublishResponse = await coachDigestPublish.POST(
      jsonRequest("https://example.test/api/health/coach-digest/publish", {
        snapshotId: coachDigestBody.data.result.snapshot.id,
        dryRun: true
      })
    );
    const responses = [
      createResponse,
      listResponse,
      updateResponse,
      importResponse,
      coachDigestResponse,
      coachDigestPublishResponse
    ];

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    await expectResponseRouteIds(responses, [
      "health.metrics.create",
      "health.metrics.list",
      "health.metrics.update",
      "health.metrics.import",
      "health.coach-digest.generate",
      "health.coach-digest.publish"
    ]);
  });

  test("actual health exercise route modules accept bearer-authenticated Web requests", async () => {
    const { templates, plans, sessionsComplete, completion } = await importHealthExerciseRouteModules();
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-exercise-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const templateResponse = await templates.POST(
      jsonRequest("https://example.test/api/health/exercise/templates", {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [
          { sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 },
          { sessionKey: "pull", dayOffset: 2, title: "Pull", targetReps: 30 }
        ]
      })
    );
    const planResponse = await plans.POST(
      jsonRequest("https://example.test/api/health/exercise/plans", {
        templateSlug: "starter-strength",
        weekStart: "2026-06-15"
      })
    );
    const planBody = (await planResponse.clone().json()) as {
      data: { result: { sessions: Array<{ id: number }> } };
    };
    const completeResponse = await sessionsComplete.POST(
      jsonRequest("https://example.test/api/health/exercise/sessions/complete", {
        sessionId: planBody.data.result.sessions[0]!.id,
        completedAt: "2026-06-15T09:00:00.000Z",
        durationMinutes: 22,
        intensity: "moderate"
      })
    );
    const summaryResponse = await completion.GET(
      new Request("https://example.test/api/health/exercise/completion?from=2026-06-15&to=2026-06-22", {
        headers: { authorization: "Bearer env-secret" }
      })
    );
    const responses = [templateResponse, planResponse, completeResponse, summaryResponse];
    const summaryBody = (await summaryResponse.clone().json()) as {
      data: { summary: { planned: number; completed: number; missed: number; rate: number } };
    };

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    await expectResponseRouteIds(responses, [
      "health.exercise.templates.create",
      "health.exercise.plans.create",
      "health.exercise.sessions.complete",
      "health.exercise.completion"
    ]);
    expect(summaryBody.data.summary).toMatchObject({ planned: 2, completed: 1, missed: 1, rate: 0.5 });
  });

  test("actual sedentary route modules accept bearer-authenticated Web requests", async () => {
    const { sedentarySpans, sedentarySummary, breakReminderEvaluate } = await importSedentaryRouteModules();
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-sedentary-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const ingestResponse = await sedentarySpans.POST(
      jsonRequest("https://example.test/api/health/sedentary/spans", {
        sourceId: "windows-logger:route-span",
        spanStart: "2026-06-15T10:00:00.000Z",
        spanEnd: "2026-06-15T11:05:00.000Z",
        state: "idle",
        confidence: 0.9,
        receivedAt: "2026-06-15T11:05:01.000Z"
      })
    );
    const summaryResponse = await sedentarySummary.GET(
      new Request("https://example.test/api/health/sedentary/summary?from=2026-06-15T10:00:00.000Z&to=2026-06-15T11:05:00.000Z", {
        headers: { authorization: "Bearer env-secret" }
      })
    );
    const evaluateResponse = await breakReminderEvaluate.POST(
      jsonRequest("https://example.test/api/health/break-reminders/evaluate", {
        from: "2026-06-15T10:00:00.000Z",
        to: "2026-06-15T11:05:00.000Z",
        evaluatedAt: "2026-06-15T11:05:00.000Z",
        thresholdMinutes: 60
      })
    );
    const responses = [ingestResponse, summaryResponse, evaluateResponse];
    const summaryBody = (await summaryResponse.clone().json()) as {
      data: { summary: { currentIdleStreakMinutes: number } };
    };

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    await expectResponseRouteIds(responses, [
      "health.sedentary.spans.ingest",
      "health.sedentary.summary",
      "health.break-reminders.evaluate"
    ]);
    expect(summaryBody.data.summary).toMatchObject({ currentIdleStreakMinutes: 65 });
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
    const { metrics, metricsImport } = await importHealthRouteModules();
    const { coachDigestGenerate, coachDigestPublish } = await importHealthCoachDigestRouteModules();
    const { templates, plans, sessionsComplete } = await importHealthExerciseRouteModules();
    const { sedentarySpans, breakReminderEvaluate } = await importSedentaryRouteModules();
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
      { routeId: "review.attempt", handler: reviewAttemptPost, url: "https://example.test/api/review/attempt" },
      { routeId: "health.metrics.create", handler: metrics.POST, url: "https://example.test/api/health/metrics" },
      {
        routeId: "health.metrics.update",
        handler: metrics.PATCH,
        url: "https://example.test/api/health/metrics",
        method: "PATCH"
      },
      {
        routeId: "health.metrics.import",
        handler: metricsImport.POST,
        url: "https://example.test/api/health/metrics/import"
      },
      {
        routeId: "health.coach-digest.generate",
        handler: coachDigestGenerate.POST,
        url: "https://example.test/api/health/coach-digest/generate"
      },
      {
        routeId: "health.coach-digest.publish",
        handler: coachDigestPublish.POST,
        url: "https://example.test/api/health/coach-digest/publish"
      },
      {
        routeId: "health.exercise.templates.create",
        handler: templates.POST,
        url: "https://example.test/api/health/exercise/templates"
      },
      {
        routeId: "health.exercise.plans.create",
        handler: plans.POST,
        url: "https://example.test/api/health/exercise/plans"
      },
      {
        routeId: "health.exercise.sessions.complete",
        handler: sessionsComplete.POST,
        url: "https://example.test/api/health/exercise/sessions/complete"
      },
      {
        routeId: "health.sedentary.spans.ingest",
        handler: sedentarySpans.POST,
        url: "https://example.test/api/health/sedentary/spans"
      },
      {
        routeId: "health.break-reminders.evaluate",
        handler: breakReminderEvaluate.POST,
        url: "https://example.test/api/health/break-reminders/evaluate"
      }
    ] as const;

    for (const route of mutationRoutes) {
      const response = await route.handler(new Request(route.url, { method: "method" in route ? route.method : "POST" }));

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "unauthorized", routeId: route.routeId }
      });
    }
  });

  test("actual mutation route modules reject unauthenticated malformed JSON before parsing the body", async () => {
    const { templates } = await importHealthExerciseRouteModules();
    const { coachDigestGenerate, coachDigestPublish } = await importHealthCoachDigestRouteModules();
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-malformed-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const quizResponse = await quizGradePost(
      new Request("https://example.test/api/quiz/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"conceptSlug\":"
      })
    );
    const templateResponse = await templates.POST(
      new Request("https://example.test/api/health/exercise/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"slug\":"
      })
    );
    const coachDigestResponse = await coachDigestGenerate.POST(
      new Request("https://example.test/api/health/coach-digest/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"date\":"
      })
    );
    const coachDigestPublishResponse = await coachDigestPublish.POST(
      new Request("https://example.test/api/health/coach-digest/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"snapshotId\":"
      })
    );

    expect(quizResponse.status).toBe(401);
    expect(await quizResponse.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "quiz.grade" }
    });
    expect(templateResponse.status).toBe(401);
    expect(await templateResponse.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "health.exercise.templates.create" }
    });
    expect(coachDigestResponse.status).toBe(401);
    expect(await coachDigestResponse.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "health.coach-digest.generate" }
    });
    expect(coachDigestPublishResponse.status).toBe(401);
    expect(await coachDigestPublishResponse.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "health.coach-digest.publish" }
    });
  });

  test("actual sedentary mutation route modules reject unauthenticated query requests before body handling", async () => {
    const { sedentarySpans, breakReminderEvaluate } = await importSedentaryRouteModules();
    const dbPath = path.join(os.tmpdir(), `knowledge-loop-route-adapter-sedentary-query-auth-${Date.now()}.db`);
    tempFiles.push(dbPath);
    process.env.KNOWLEDGE_LOOP_DB_PATH = dbPath;
    process.env.KNOWLEDGE_LOOP_API_TOKEN = "env-secret";

    const ingestResponse = await sedentarySpans.POST(
      new Request("https://example.test/api/health/sedentary/spans?source=windows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"sourceId\":"
      })
    );
    const evaluateResponse = await breakReminderEvaluate.POST(
      new Request("https://example.test/api/health/break-reminders/evaluate?mode=check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"from\":"
      })
    );

    expect(ingestResponse.status).toBe(401);
    expect(await ingestResponse.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "health.sedentary.spans.ingest" }
    });
    expect(evaluateResponse.status).toBe(401);
    expect(await evaluateResponse.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", routeId: "health.break-reminders.evaluate" }
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

function seedOpsDashboardRouteData(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    const source = db
      .prepare(
        `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("ops-route", "ops.md", "Ops", "ops-route-fingerprint", "ingested");
    db.prepare(
      `INSERT INTO chunks (source_id, seq, text, meta)
       VALUES (?, ?, ?, ?)`
    ).run(source.lastInsertRowid, 1, "Ops dashboard route fixture.", "{}");
    db.prepare(
      `INSERT INTO trace_events (run_id, stage, level, message, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ops-route-run", "plan", "info", "Ops dashboard route trace.", "2026-06-15T12:00:00.000Z", "null");
  } finally {
    db.close();
  }
}

function readDashboardRouteRows(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(
      ["sources", "chunks", "concepts", "pages", "mastery", "trace_events"].map((table) => {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        return [table, row.count];
      })
    );
  } finally {
    db.close();
  }
}

function jsonRequest(url: string, body: Record<string, unknown>, method = "POST"): Request {
  return new Request(url, {
    method,
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

function exportKeys(module: object): string[] {
  return Object.keys(module).sort();
}

interface HealthRouteModule {
  readonly runtime: string;
  readonly GET: AppRouteHandler;
  readonly POST: AppRouteHandler;
  readonly PATCH: AppRouteHandler;
}

interface HealthImportRouteModule {
  readonly runtime: string;
  readonly POST: AppRouteHandler;
}

type HealthCoachDigestRouteModule = HealthImportRouteModule;

async function importHealthRouteModules(): Promise<{
  readonly metrics: HealthRouteModule;
  readonly metricsImport: HealthImportRouteModule;
}> {
  const metrics = (await import("../health/metrics/route.js")) as HealthRouteModule;
  const metricsImport = (await import("../health/metrics/import/route.js")) as HealthImportRouteModule;

  return { metrics, metricsImport };
}

async function importHealthCoachDigestRouteModules(): Promise<{
  readonly coachDigestGenerate: HealthCoachDigestRouteModule;
  readonly coachDigestPublish: HealthCoachDigestRouteModule;
}> {
  const coachDigestGenerate = (await import("../health/coach-digest/generate/route.js")) as HealthCoachDigestRouteModule;
  const coachDigestPublish = (await import("../health/coach-digest/publish/route.js")) as HealthCoachDigestRouteModule;

  return { coachDigestGenerate, coachDigestPublish };
}

interface ExercisePostRouteModule {
  readonly runtime: string;
  readonly POST: AppRouteHandler;
}

interface ExerciseCompletionRouteModule {
  readonly runtime: string;
  readonly GET: AppRouteHandler;
}

interface SedentaryPostRouteModule {
  readonly runtime: string;
  readonly POST: AppRouteHandler;
}

interface SedentarySummaryRouteModule {
  readonly runtime: string;
  readonly GET: AppRouteHandler;
}

async function importHealthExerciseRouteModules(): Promise<{
  readonly templates: ExercisePostRouteModule;
  readonly plans: ExercisePostRouteModule;
  readonly sessionsComplete: ExercisePostRouteModule;
  readonly completion: ExerciseCompletionRouteModule;
}> {
  const templates = (await import("../health/exercise/templates/route.js")) as ExercisePostRouteModule;
  const plans = (await import("../health/exercise/plans/route.js")) as ExercisePostRouteModule;
  const sessionsComplete = (await import(
    "../health/exercise/sessions/complete/route.js"
  )) as ExercisePostRouteModule;
  const completion = (await import("../health/exercise/completion/route.js")) as ExerciseCompletionRouteModule;

  return { templates, plans, sessionsComplete, completion };
}

async function importSedentaryRouteModules(): Promise<{
  readonly sedentarySpans: SedentaryPostRouteModule;
  readonly sedentarySummary: SedentarySummaryRouteModule;
  readonly breakReminderEvaluate: SedentaryPostRouteModule;
}> {
  const sedentarySpans = (await import("../health/sedentary/spans/route.js")) as SedentaryPostRouteModule;
  const sedentarySummary = (await import("../health/sedentary/summary/route.js")) as SedentarySummaryRouteModule;
  const breakReminderEvaluate = (await import(
    "../health/break-reminders/evaluate/route.js"
  )) as SedentaryPostRouteModule;

  return { sedentarySpans, sedentarySummary, breakReminderEvaluate };
}
