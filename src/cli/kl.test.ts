import { existsSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createPage, createSourceWithChunk, recordMasteryUpdate } from "../db/content-store.js";
import { createConcept, type ConceptStatus } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { persistTraceEvent } from "../db/trace-store.js";
import type { TraceEvent } from "../engine/trace.js";
import {
  handleKlCommand,
  type KlAgentDayDryRunCommandResult,
  type KlAgentDayLiveCommandResult,
  type KlAgentBoardEvidenceDryRunCommandResult,
  type KlAgentBoardConfigDryRunCommandResult,
  type KlAgentDryRunCommandResult,
  type KlAgentFailureSmokeDryRunCommandResult,
  type KlAgentHarnessDependencyDryRunCommandResult,
  type KlAgentLiveSmokeDryRunCommandResult,
  type KlAgentPreflightDryRunCommandResult,
  type KlAgentScheduleDryRunCommandResult,
  type KlAgentScheduleLiveCommandResult,
  type KlCommandResult,
  type KlHealthLiveEvidenceCommandResult,
  type KlHealthWindowsLoggerCommandResult,
  type KlOpsDashboardCommandResult,
  type KlPersistentApplicationCommandResult,
  type KlPersistentQuizCommandResult,
  type KlPersistentReviewCommandResult,
  type KlPersistentTeachbackCommandResult
} from "./kl.js";
import { upsertPersistentReviewSchedule } from "../engine/persistent-review.js";

function createCapture(): { sink: { write(chunk: string | Uint8Array): boolean }; text(): string } {
  let output = "";

  return {
    sink: {
      write(chunk: string | Uint8Array): boolean {
        output += chunk.toString();
        return true;
      }
    },
    text(): string {
      return output;
    }
  };
}

function unlinkIfExists(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

function rmdirIfEmpty(dirPath: string): void {
  if (existsSync(dirPath) && readdirSync(dirPath).length === 0) {
    rmdirSync(dirPath);
  }
}

function parseCapturedJson(capture: { text(): string }): KlCommandResult {
  return JSON.parse(capture.text()) as KlCommandResult;
}

interface FetchCall {
  readonly input: string | URL | Request;
  readonly init: RequestInit | undefined;
}

function authorizationHeader(call: FetchCall | undefined): string | undefined {
  const headers = call?.init?.headers;
  if (headers instanceof Headers) {
    return headers.get("Authorization") ?? undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === "authorization")?.[1];
  }

  return headers?.Authorization ?? headers?.authorization;
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

function successfulApiBodyForUrl(url: string): Record<string, unknown> {
  const parsed = new URL(url);
  if (parsed.pathname === "/api/health/coach-digest/generate") {
    return {
      ok: true,
      routeId: "health.coach-digest.generate",
      data: {
        result: {
          renderedMarkdown: [
            "# Coach daily health digest",
            "## Date",
            parsed.searchParams.get("date") ?? "2026-06-13",
            "",
            "## Metrics",
            "- No metrics recorded for this date."
          ].join("\n")
        }
      }
    };
  }

  if (parsed.pathname === "/api/mastery/summary") {
    return {
      ok: true,
      routeId: "mastery.summary",
      data: {
        masteryRows: [],
        diagnosis: {
          weakSpots: []
        }
      }
    };
  }

  return { ok: true, url };
}

function writeValidLiveSmokeManifestFixture(manifestPath: string, dates: readonly [string, string]): void {
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        contractStatus: "inferred_live_smoke_pending",
        requiredConsecutiveDays: 2,
        boardPublishConfig: "config/multica/board-publish.example.json",
        smokeMode: "offline-contract-only",
        evidence: {
          days: dates.map((date) => ({
            date,
            items: [
              {
                role: "librarian",
                phase: "nightly-ingest",
                actionType: "add_comment",
                title: `Librarian ingest report for ${date}`,
                requiredSourceEndpoints: ["POST http://127.0.0.1:3000/api/ingest/run?adapter=holly-vault"],
                requiredBoardEvidence: ["commentUrl", "sourceLinks", "conceptCounts"]
              },
              {
                role: "scholar",
                phase: "morning-plan",
                actionType: "create_task",
                title: `Scholar study plan for ${date}`,
                requiredSourceEndpoints: ["GET http://127.0.0.1:3000/api/plan/today"],
                requiredBoardEvidence: ["taskUrl", "checklist", "sourceLinks"]
              },
              {
                role: "nutritionist",
                phase: "daily-meals",
                actionType: "create_task",
                title: `Nutrition plan for ${date}`,
                requiredSourceEndpoints: [
                  `GET http://127.0.0.1:8000/api/meal-plan/today?date=${date}`,
                  "POST http://127.0.0.1:8000/api/meal-engine/procurement"
                ],
                requiredBoardEvidence: ["taskUrl", "mealChecklist", "sourceLinks"]
              },
              {
                role: "coach",
                phase: "daily-health",
                actionType: "add_comment",
                title: `Coach health digest for ${date}`,
                requiredSourceEndpoints: [
                  "POST http://127.0.0.1:3000/api/health/coach-digest/generate"
                ],
                requiredBoardEvidence: ["commentUrl", "sourceLinks"]
              },
              {
                role: "scholar",
                phase: "evening-mastery",
                actionType: "add_comment",
                title: `Scholar mastery report for ${date}`,
                requiredSourceEndpoints: ["GET http://127.0.0.1:3000/api/mastery/summary"],
                requiredBoardEvidence: ["commentUrl", "masteryDelta", "sourceLinks"]
              }
            ]
          }))
        },
        nonCompletionNotice:
          "This manifest is an offline live-smoke contract. It does not execute Multica, install a scheduler, prove live board posting, or close M2."
      },
      null,
      2
    ),
    "utf8"
  );
}

function piHarnessPackageJson(): Record<string, unknown> {
  return {
    name: "pi-harness",
    version: "0.1.0",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    bin: {
      "pi-harness": "./dist/cli/index.js"
    },
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js"
      },
      "./cli": {
        types: "./dist/cli/index.d.ts",
        import: "./dist/cli/index.js",
        default: "./dist/cli/index.js"
      }
    },
    scripts: {
      build: "tsc -p tsconfig.build.json",
      "new-agent": "node scripts/new-agent.mjs"
    }
  };
}

type CountableTable =
  | "schema_migrations"
  | "sources"
  | "chunks"
  | "concepts"
  | "concept_edges"
  | "pages"
  | "study_plans"
  | "items"
  | "attempts"
  | "teachbacks"
  | "mastery"
  | "reviews"
  | "trace_events";

type HealthCountableTable =
  | "health_metrics"
  | "health_metric_audit_events"
  | "health_metric_imports"
  | "health_trace_events"
  | "coach_digest_snapshots"
  | "exercise_templates"
  | "exercise_plans"
  | "exercise_sessions"
  | "sedentary_spans"
  | "sedentary_streaks"
  | "break_reminders";

interface TraceCliCommandResult {
  command: "trace";
  mode: "mock-persistent";
  result: {
    runId: string;
    stage?: string;
    eventCount: number;
    events: Array<{
      id: number;
      runId: string;
      stage: string;
      level: string;
      message: string;
      timestamp: string;
      data: unknown;
    }>;
  };
}

type TraceCliEvent = TraceCliCommandResult["result"]["events"][number];

interface HealthMetricCliCommandResult {
  command: "health-metric";
  mode: "mock-persistent";
  action: "add" | "list" | "update" | "import-csv";
  result: unknown;
}

interface HealthExerciseCliCommandResult {
  command: "health-exercise";
  mode: "mock-persistent";
  action: "template.create" | "plan.create" | "complete" | "completion";
  result: unknown;
}

interface HealthSedentaryCliCommandResult {
  command: "health-sedentary";
  mode: "mock-persistent";
  action: "ingest-span" | "summary";
  result: unknown;
}

interface HealthBreakReminderCliCommandResult {
  command: "health-break-reminder";
  mode: "mock-persistent";
  action: "evaluate";
  result: unknown;
}

interface HealthCoachDigestCliCommandResult {
  command: "health-coach-digest";
  mode: "dry-run";
  result: {
    snapshot: {
      id: number;
      date: string;
      renderedMarkdown: string;
      sourceHash: string;
    };
    renderedMarkdown: string;
    sourceHash: string;
    traceEvents: Array<{
      runId: string;
      stage: string;
      timestamp: string;
      dataJson: string;
    }>;
  };
}

interface HealthCoachDigestPublishCliCommandResult {
  command: "health-coach-digest";
  mode: "dry-run";
  action: "publish";
  result: {
    snapshotId: number;
    status: "dry_run";
    intendedAction: {
      target: "multica";
      type: "add_comment";
      title: string;
      body: string;
      checklist: readonly string[];
      sourceEndpoints: readonly string[];
    };
  };
}

const DOMAIN_COUNTABLE_TABLES = [
  "schema_migrations",
  "sources",
  "chunks",
  "concepts",
  "concept_edges",
  "pages",
  "study_plans",
  "items",
  "attempts",
  "teachbacks",
  "mastery",
  "reviews"
] as const satisfies readonly CountableTable[];

function countRows(dbPath: string, table: CountableTable): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function countHealthRows(dbPath: string, table: HealthCountableTable): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function readCoachDigestSnapshotPublishState(dbPath: string, snapshotId: number): {
  publishedAt: string | null;
  publishResultJson: string | null;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT published_at AS publishedAt, publish_result_json AS publishResultJson
         FROM coach_digest_snapshots
         WHERE id = ?`
      )
      .get(snapshotId) as {
      publishedAt: string | null;
      publishResultJson: string | null;
    };
  } finally {
    db.close();
  }
}

function countHealthExerciseRows(dbPath: string): Record<"templates" | "plans" | "sessions" | "healthTraces" | "legacyTraces", number> {
  return {
    templates: countHealthRows(dbPath, "exercise_templates"),
    plans: countHealthRows(dbPath, "exercise_plans"),
    sessions: countHealthRows(dbPath, "exercise_sessions"),
    healthTraces: countHealthRows(dbPath, "health_trace_events"),
    legacyTraces: countRows(dbPath, "trace_events")
  };
}

async function readTraceRun(dbPath: string, runId: string): Promise<TraceCliCommandResult> {
  return (await handleKlCommand(["trace", "--db", dbPath, "--run", runId])) as unknown as TraceCliCommandResult;
}

async function expectPersistedTraceEventsMatchResult(
  dbPath: string,
  runId: string,
  traceEvents: readonly TraceEvent[]
): Promise<TraceCliCommandResult> {
  const trace = await readTraceRun(dbPath, runId);

  expect(trace.result.runId).toBe(runId);
  expect(trace.result.eventCount).toBe(traceEvents.length);
  expect(stripTraceEventIds(trace.result.events)).toEqual(traceEvents.map(normalizeTraceEventForStorage));

  return trace;
}

function stripTraceEventIds(events: readonly TraceCliEvent[]): Array<Omit<TraceCliEvent, "id">> {
  return events.map(({ runId, stage, level, message, timestamp, data }) => ({
    runId,
    stage,
    level,
    message,
    timestamp,
    data
  }));
}

function normalizeTraceEventForStorage(event: TraceEvent): Omit<TraceCliEvent, "id"> {
  return {
    runId: event.runId,
    stage: event.stage,
    level: event.level,
    message: event.message,
    timestamp: event.timestamp,
    data: event.data ?? null
  };
}

function createPlanDb(concepts: Array<{ slug: string; name: string; status?: ConceptStatus }>): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-plan-db-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    for (const concept of concepts) {
      createConcept(db, concept);
    }
  } finally {
    db.close();
  }

  return dbPath;
}

function createReviewDb(
  reviews: Array<{
    slug: string;
    name: string;
    status?: ConceptStatus;
    fsrsState: Record<string, unknown>;
    dueAt: string;
  }>
): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-review-db-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    for (const review of reviews) {
      const concept = createConcept(db, {
        slug: review.slug,
        name: review.name,
        status: review.status ?? "generated"
      });
      upsertPersistentReviewSchedule(db, {
        conceptId: concept.id,
        fsrsState: review.fsrsState,
        dueAt: review.dueAt
      });
    }
  } finally {
    db.close();
  }

  return dbPath;
}

function createDiagnoseDb(
  concepts: Array<{
    slug: string;
    name: string;
    score: number;
    confidence?: number;
    attemptsN?: number;
    status?: ConceptStatus;
  }>
): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-diagnose-db-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    for (const conceptInput of concepts) {
      const concept = createConcept(db, {
        slug: conceptInput.slug,
        name: conceptInput.name,
        status: conceptInput.status ?? "generated"
      });
      recordMasteryUpdate(db, {
        conceptId: concept.id,
        score: conceptInput.score,
        confidence: conceptInput.confidence ?? 0.5,
        attemptsN: conceptInput.attemptsN ?? 1,
        lastSeenAt: `2026-06-12T0${concept.id}:00:00.000Z`
      });
    }
  } finally {
    db.close();
  }

  return dbPath;
}

function createTeachbackDb(input: {
  slug: string;
  name: string;
  pageMarkdown?: string;
  chunkText?: string;
  createPage?: boolean;
}): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-teachback-db-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    const concept = createConcept(db, { slug: input.slug, name: input.name, status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: `${input.slug}.md`,
      title: `${input.name} notes`,
      fingerprint: `fingerprint-${input.slug}`,
      chunkText: input.chunkText ?? "Teachback fixtures need grounded citation chunks."
    });

    if (input.createPage ?? true) {
      createPage(db, {
        conceptId: concept.id,
        version: 1,
        markdown:
          input.pageMarkdown ?? "Retrieval practice uses active recall before review to strengthen durable memory.",
        citationIds: [chunk.id],
        visibility: "private"
      });
    }
  } finally {
    db.close();
  }

  return dbPath;
}

function createApplicationDb(input: {
  slug: string;
  name: string;
  pageMarkdown?: string;
  chunkText?: string;
  createPage?: boolean;
}): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-application-db-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    const concept = createConcept(db, { slug: input.slug, name: input.name, status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: `${input.slug}.md`,
      title: `${input.name} notes`,
      fingerprint: `fingerprint-${input.slug}`,
      chunkText:
        input.chunkText ??
        "Retrieval practice transfers knowledge into realistic planning scenarios with constraints and feedback."
    });

    if (input.createPage ?? true) {
      createPage(db, {
        conceptId: concept.id,
        version: 1,
        markdown:
          input.pageMarkdown ??
          "Retrieval practice transfers knowledge into realistic planning scenarios with constraints and feedback.",
        citationIds: [chunk.id],
        visibility: "private"
      });
    }
  } finally {
    db.close();
  }

  return dbPath;
}

function createTraceDb(): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-trace-db-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    persistTraceEvent(db, {
      runId: "run-alpha",
      stage: "chunk",
      level: "info",
      message: "Chunked source",
      timestamp: "2026-06-12T00:00:00.000Z",
      data: { source: "alpha.md", chunks: 2 }
    });
    persistTraceEvent(db, {
      runId: "run-beta",
      stage: "chunk",
      level: "warn",
      message: "Skipped empty source",
      timestamp: "2026-06-12T00:01:00.000Z",
      data: { source: "beta.md" }
    });
    persistTraceEvent(db, {
      runId: "run-alpha",
      stage: "plan",
      level: "info",
      message: "Created study plan",
      timestamp: "2026-06-12T00:02:00.000Z",
      data: ["learn", "quiz"]
    });
  } finally {
    db.close();
  }

  return dbPath;
}

function createBackupSourceDb(): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-db-backup-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    db.prepare(
      `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
       VALUES (?, ?, ?, ?, ?)`
    ).run("m5-cli-drill", "README.md", "M5 CLI Drill", "sha256-cli-drill", "ingested");
  } finally {
    db.close();
  }

  return dbPath;
}

function createOpsDashboardDb(): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-ops-dashboard-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    const concept = createConcept(db, { slug: "ops-dashboard", name: "Ops Dashboard", status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "ops-cli",
      docRef: "ops.md",
      title: "Ops",
      fingerprint: "ops-cli-fingerprint",
      chunkText: "Ops dashboard CLI fixture."
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "Ops dashboard CLI page",
      citationIds: [chunk.id],
      visibility: "private"
    });
    recordMasteryUpdate(db, {
      conceptId: concept.id,
      score: 0.4,
      confidence: 0.6,
      attemptsN: 1,
      lastSeenAt: "2026-06-15T11:00:00.000Z"
    });
    persistTraceEvent(db, {
      runId: "ops-cli-run",
      stage: "plan",
      level: "info",
      message: "Ops CLI trace",
      timestamp: "2026-06-15T11:30:00.000Z",
      data: { fixture: true }
    });
  } finally {
    db.close();
  }

  return dbPath;
}

function createHealthMetricDb(): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-health-metric-db-"));
  const dbPath = path.join(dbDir, "metrics.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
  } finally {
    db.close();
  }

  return dbPath;
}

function readQuizRows(dbPath: string): {
  items: Array<{ id: number; conceptSlug: string; statement: string; answerSpec: unknown }>;
  attempts: Array<{ id: number; itemId: number; response: string; verdict: string; gradingMethod: string }>;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const items = db
      .prepare(
        `SELECT
           items.id,
           concepts.slug AS conceptSlug,
           items.statement,
           items.answer_spec AS answerSpec
         FROM items
         INNER JOIN concepts ON concepts.id = items.concept_id
         ORDER BY items.id`
      )
      .all() as Array<{ id: number; conceptSlug: string; statement: string; answerSpec: string }>;
    const attempts = db
      .prepare(
        `SELECT id, item_id AS itemId, response, verdict, grading_method AS gradingMethod
         FROM attempts
         ORDER BY id`
      )
      .all() as Array<{ id: number; itemId: number; response: string; verdict: string; gradingMethod: string }>;

    return {
      items: items.map((item) => ({
        ...item,
        answerSpec: JSON.parse(item.answerSpec) as unknown
      })),
      attempts
    };
  } finally {
    db.close();
  }
}

function readTeachbackRows(dbPath: string): Array<{
  id: number;
  conceptSlug: string;
  transcript: string;
  rubricReport: unknown;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT
           teachbacks.id,
           concepts.slug AS conceptSlug,
           teachbacks.transcript,
           teachbacks.rubric_report AS rubricReport
         FROM teachbacks
         INNER JOIN concepts ON concepts.id = teachbacks.concept_id
         ORDER BY teachbacks.id`
      )
      .all() as Array<{ id: number; conceptSlug: string; transcript: string; rubricReport: string }>;

    return rows.map((row) => ({
      ...row,
      rubricReport: JSON.parse(row.rubricReport) as unknown
    }));
  } finally {
    db.close();
  }
}

function readApplicationRows(dbPath: string): {
  items: Array<{
    id: number;
    conceptSlug: string;
    conceptIds: number[];
    type: string;
    difficulty: number;
    statement: string;
    answerSpec: unknown;
  }>;
  attempts: Array<{ id: number; itemId: number; response: string; verdict: string; gradingMethod: string }>;
  mastery: Array<{ conceptSlug: string; score: number; confidence: number; attemptsN: number }>;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const items = db
      .prepare(
        `SELECT
           items.id,
           concepts.slug AS conceptSlug,
           items.concept_ids AS conceptIds,
           items.type,
           items.difficulty,
           items.statement,
           items.answer_spec AS answerSpec
         FROM items
         INNER JOIN concepts ON concepts.id = items.concept_id
         ORDER BY items.id`
      )
      .all() as Array<{
      id: number;
      conceptSlug: string;
      conceptIds: string;
      type: string;
      difficulty: number;
      statement: string;
      answerSpec: string;
    }>;
    const attempts = db
      .prepare(
        `SELECT id, item_id AS itemId, response, verdict, grading_method AS gradingMethod
         FROM attempts
         ORDER BY id`
      )
      .all() as Array<{ id: number; itemId: number; response: string; verdict: string; gradingMethod: string }>;
    const mastery = db
      .prepare(
        `SELECT concepts.slug AS conceptSlug, mastery.score, mastery.confidence, mastery.attempts_n AS attemptsN
         FROM mastery
         INNER JOIN concepts ON concepts.id = mastery.concept_id
         ORDER BY mastery.id`
      )
      .all() as Array<{ conceptSlug: string; score: number; confidence: number; attemptsN: number }>;

    return {
      items: items.map((item) => ({
        ...item,
        conceptIds: JSON.parse(item.conceptIds) as number[],
        answerSpec: JSON.parse(item.answerSpec) as unknown
      })),
      attempts,
      mastery
    };
  } finally {
    db.close();
  }
}

function readReviewRows(dbPath: string): Array<{
  conceptSlug: string;
  fsrsState: unknown;
  dueAt: string;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT
           concepts.slug AS conceptSlug,
           reviews.fsrs_state AS fsrsState,
           reviews.due_at AS dueAt
         FROM reviews
         INNER JOIN concepts ON concepts.id = reviews.concept_id
         ORDER BY reviews.id`
      )
      .all() as Array<{ conceptSlug: string; fsrsState: string; dueAt: string }>;

    return rows.map((row) => ({
      conceptSlug: row.conceptSlug,
      fsrsState: JSON.parse(row.fsrsState) as unknown,
      dueAt: row.dueAt
    }));
  } finally {
    db.close();
  }
}

function countMutableRows(dbPath: string): Record<CountableTable, number> {
  return {
    schema_migrations: countRows(dbPath, "schema_migrations"),
    sources: countRows(dbPath, "sources"),
    chunks: countRows(dbPath, "chunks"),
    concepts: countRows(dbPath, "concepts"),
    concept_edges: countRows(dbPath, "concept_edges"),
    pages: countRows(dbPath, "pages"),
    study_plans: countRows(dbPath, "study_plans"),
    items: countRows(dbPath, "items"),
    attempts: countRows(dbPath, "attempts"),
    teachbacks: countRows(dbPath, "teachbacks"),
    mastery: countRows(dbPath, "mastery"),
    reviews: countRows(dbPath, "reviews"),
    trace_events: countRows(dbPath, "trace_events")
  };
}

function countDomainRows(dbPath: string): Record<(typeof DOMAIN_COUNTABLE_TABLES)[number], number> {
  const counts = {} as Record<(typeof DOMAIN_COUNTABLE_TABLES)[number], number>;

  for (const table of DOMAIN_COUNTABLE_TABLES) {
    counts[table] = countRows(dbPath, table);
  }

  return counts;
}

function listTableNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

describe("kl CLI handler", () => {
  test("unknown command lists diagnose db-backup ops-dashboard and agent as expected commands", async () => {
    await expect(handleKlCommand(["unknown"])).rejects.toThrow(
      /Expected one of: ingest, plan, quiz, teachback, diagnose, trace, db-backup, ops-dashboard, health-metric, health-exercise, health-sedentary, health-break-reminder, health-coach-digest, health-windows-logger, health-live-evidence, application, review, agent, agent-day, agent-schedule, agent-live-smoke, agent-preflight, agent-board-config, agent-board-evidence, agent-failure-smoke/
    );
  });

  test("ops-dashboard with a db returns the summary and writes JSON", async () => {
    const dbPath = createOpsDashboardDb();
    const stdout = createCapture();

    const result = (await handleKlCommand(["ops-dashboard", "--db", dbPath], {
      stdout: stdout.sink
    })) as KlOpsDashboardCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "ops-dashboard",
      mode: "mock-persistent",
      result: {
        tableCounts: {
          sources: 1,
          chunks: 1,
          concepts: 1,
          pages: 1,
          mastery: 1,
          trace_events: 1
        },
        sourceAdapters: [{ adapterId: "ops-cli", sourceCount: 1, failedCount: 0 }],
        publicPageCount: 0,
        privatePageCount: 1,
        masteryCount: 1,
        recentTraceEventCount: expect.any(Number)
      }
    });
    expect(result.result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("ops-dashboard rejects a missing db without creating it", async () => {
    const missingDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-ops-dashboard-missing-")), "missing.db");

    await expect(handleKlCommand(["ops-dashboard", "--db", missingDbPath])).rejects.toThrow();

    expect(existsSync(missingDbPath)).toBe(false);
  });

  test("ops-dashboard rejects missing duplicate db and unknown options", async () => {
    const dbPath = createOpsDashboardDb();
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(handleKlCommand(["ops-dashboard"])).rejects.toThrow(/requires exactly one --db/);
    await expect(handleKlCommand(["ops-dashboard", "--db"])).rejects.toThrow(
      /Option --db for ops-dashboard requires a value/
    );
    await expect(handleKlCommand(["ops-dashboard", "--db", dbPath, "--db", otherDbPath])).rejects.toThrow(
      /requires exactly one --db/
    );
    await expect(handleKlCommand(["ops-dashboard", "--db", dbPath, "--bogus", "1"])).rejects.toThrow(
      /Unknown option for ops-dashboard: --bogus/
    );
  });

  test("db-backup create returns a manifest with a sha256 hash and writes JSON", async () => {
    const dbPath = createBackupSourceDb();
    const backupPath = path.join(path.dirname(dbPath), "backups", "knowledge-loop.backup.db");
    const stdout = createCapture();

    const result = await handleKlCommand(
      ["db-backup", "create", "--db", dbPath, "--out", backupPath],
      { stdout: stdout.sink }
    );

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "db-backup",
      action: "create",
      result: {
        sourcePath: path.resolve(dbPath),
        backupPath: path.resolve(backupPath),
        tableCounts: {
          sources: 1
        }
      }
    });
    if (result.command !== "db-backup" || result.action !== "create") {
      throw new Error("Expected db-backup create result.");
    }
    expect(result.result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.result.byteSize).toBeGreaterThan(0);
  });

  test("db-backup restore-drill reports integrity for an existing backup", async () => {
    const dbPath = createBackupSourceDb();
    const backupPath = path.join(path.dirname(dbPath), "backups", "knowledge-loop.backup.db");
    await handleKlCommand(["db-backup", "create", "--db", dbPath, "--out", backupPath]);

    const result = await handleKlCommand(["db-backup", "restore-drill", "--backup", backupPath]);

    expect(result).toMatchObject({
      command: "db-backup",
      action: "restore-drill",
      result: {
        backupPath: path.resolve(backupPath),
        integrityOk: true,
        tableCounts: {
          sources: 1
        }
      }
    });
    if (result.command !== "db-backup" || result.action !== "restore-drill") {
      throw new Error("Expected db-backup restore-drill result.");
    }
    expect(result.result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("db-backup rejects unknown actions and missing option values with usage errors", async () => {
    await expect(handleKlCommand(["db-backup", "bogus"])).rejects.toThrow(
      /Command db-backup requires one action: create or restore-drill/
    );
    await expect(handleKlCommand(["db-backup", "bogus"])).rejects.toHaveProperty("exitCode", 2);
    await expect(handleKlCommand(["db-backup", "create", "--db"])).rejects.toThrow(
      /Option --db for db-backup create requires a value/
    );
    await expect(handleKlCommand(["db-backup", "create", "--db"])).rejects.toHaveProperty("exitCode", 2);
  });

  test("db-backup create rejects source and destination resolving to the same path", async () => {
    const dbPath = createBackupSourceDb();

    await expect(
      handleKlCommand(["db-backup", "create", "--db", dbPath, "--out", path.join(path.dirname(dbPath), ".", path.basename(dbPath))])
    ).rejects.toThrow(/same path/i);
  });

  test("health-coach-digest dry-run creates an offline snapshot on a new database without fetch", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-coach-digest-offline-")), "digest.db");
    const stdout = createCapture();
    const fetchCalls: FetchCall[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ input, init });
      throw new Error("offline health-coach-digest must not fetch");
    };

    const result = (await handleKlCommand(
      [
        "health-coach-digest",
        "--db",
        dbPath,
        "--date",
        "2026-06-15",
        "--dry-run",
        "--offline",
        "--compass-base-url",
        "https://compass.example/root",
        "--now",
        "2026-06-15T12:34:56.000Z"
      ],
      { stdout: stdout.sink, fetch }
    )) as unknown as HealthCoachDigestCliCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "health-coach-digest",
      mode: "dry-run",
      result: {
        snapshot: {
          date: "2026-06-15"
        },
        renderedMarkdown: expect.stringContaining("# Coach daily health digest"),
        sourceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        traceEvents: [
          {
            runId: "health-coach-digest-cli-2026-06-15",
            stage: "coach",
            timestamp: "2026-06-15T12:34:56.000Z"
          }
        ]
      }
    });
    expect(result.result.renderedMarkdown).toContain("- Availability: unavailable");
    expect(fetchCalls).toEqual([]);
    expect(existsSync(dbPath)).toBe(true);
    expect(countHealthRows(dbPath, "coach_digest_snapshots")).toBe(1);
    expect(countHealthRows(dbPath, "health_trace_events")).toBe(1);
  });

  test("health-coach-digest dry-run reads compass context over injected fetch without bearer headers", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-coach-digest-online-")), "digest.db");
    const fetchCalls: FetchCall[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ input, init });
      return jsonResponse({ meals: [{ name: "Breakfast" }] });
    };

    const result = (await handleKlCommand(
      [
        "health-coach-digest",
        "--db",
        dbPath,
        "--date",
        "2026-06-15",
        "--dry-run",
        "--compass-base-url",
        "https://compass.example/root"
      ],
      { fetch }
    )) as unknown as HealthCoachDigestCliCommandResult;

    expect(result.result.renderedMarkdown).toContain("- Availability: available");
    expect(result.result.renderedMarkdown).toContain("- Meal entries: 1");
    expect(fetchCalls.map((call) => String(call.input))).toEqual([
      "https://compass.example/root/api/meal-plan/daily-context?date=2026-06-15"
    ]);
    expect(fetchCalls[0]?.init).toEqual({ method: "GET" });
    expect(authorizationHeader(fetchCalls[0])).toBeUndefined();
  });

  test("health-coach-digest publish dry-run returns intended publish action without live board writes", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-coach-digest-publish-")), "digest.db");
    const generated = (await handleKlCommand([
      "health-coach-digest",
      "--db",
      dbPath,
      "--date",
      "2026-06-15",
      "--dry-run",
      "--offline",
      "--now",
      "2026-06-15T12:34:56.000Z"
    ])) as unknown as HealthCoachDigestCliCommandResult;
    const stdout = createCapture();

    const result = (await handleKlCommand(
      [
        "health-coach-digest",
        "publish",
        "--db",
        dbPath,
        "--snapshot-id",
        String(generated.result.snapshot.id),
        "--dry-run"
      ],
      { stdout: stdout.sink }
    )) as unknown as HealthCoachDigestPublishCliCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "health-coach-digest",
      mode: "dry-run",
      action: "publish",
      result: {
        snapshotId: generated.result.snapshot.id,
        status: "dry_run",
        intendedAction: {
          target: "multica",
          type: "add_comment",
          title: "Coach health digest for 2026-06-15",
          body: expect.stringContaining("# Coach daily health digest"),
          checklist: [],
          sourceEndpoints: ["POST /api/health/coach-digest/publish"]
        }
      }
    });
    expect(result.result.intendedAction).not.toHaveProperty("sourceHash");
    expect(result.result.intendedAction).not.toHaveProperty("renderedMarkdown");
    expect(readCoachDigestSnapshotPublishState(dbPath, generated.result.snapshot.id)).toEqual({
      publishedAt: null,
      publishResultJson: null
    });
  });

  test("health-coach-digest publish rejects live mode and invalid snapshot ids before live publishing", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-coach-digest-publish-invalid-")), "digest.db");

    await handleKlCommand([
      "health-coach-digest",
      "--db",
      dbPath,
      "--date",
      "2026-06-15",
      "--dry-run",
      "--offline"
    ]);

    await expect(
      handleKlCommand(["health-coach-digest", "publish", "--db", dbPath, "--snapshot-id", "1", "--live"])
    ).rejects.toThrow(/does not support --live/);
    await expect(
      handleKlCommand(["health-coach-digest", "publish", "--db", dbPath, "--snapshot-id", "0", "--dry-run"])
    ).rejects.toThrow(/Invalid --snapshot-id value "0"/);
    await expect(
      handleKlCommand(["health-coach-digest", "publish", "--db", dbPath, "--snapshot-id", "1"])
    ).rejects.toThrow(/requires --dry-run/);
    await expect(
      handleKlCommand(["health-coach-digest", "publish", "--db", dbPath, "--snapshot-id", "1", "--dry-run", "--dry-run"])
    ).rejects.toThrow(/requires exactly one --dry-run flag/);
  });

  test("health-coach-digest rejects missing duplicate unknown and live-publish options before creating a database", async () => {
    const cases: Array<{
      readonly name: string;
      readonly argv: readonly string[];
      readonly error: RegExp;
    }> = [
      {
        name: "missing dry-run",
        argv: ["--db", "{db}", "--date", "2026-06-15"],
        error: /Command health-coach-digest requires --dry-run/
      },
      {
        name: "duplicate dry-run",
        argv: ["--db", "{db}", "--date", "2026-06-15", "--dry-run", "--dry-run"],
        error: /requires exactly one --dry-run flag/
      },
      {
        name: "duplicate date",
        argv: ["--db", "{db}", "--date", "2026-06-15", "--date", "2026-06-16", "--dry-run"],
        error: /requires exactly one --date value/
      },
      {
        name: "invalid date",
        argv: ["--db", "{db}", "--date", "2026-02-31", "--dry-run"],
        error: /Invalid --date value "2026-02-31"/
      },
      {
        name: "invalid now",
        argv: ["--db", "{db}", "--date", "2026-06-15", "--dry-run", "--now", "2026-06-15"],
        error: /Invalid --now value "2026-06-15"/
      },
      {
        name: "offline value",
        argv: ["--db", "{db}", "--date", "2026-06-15", "--dry-run", "--offline", "true"],
        error: /Unexpected positional argument for health-coach-digest: true/
      },
      {
        name: "bad compass url",
        argv: ["--db", "{db}", "--date", "2026-06-15", "--dry-run", "--compass-base-url", "file:///tmp/compass"],
        error: /Invalid --compass-base-url value/
      },
      {
        name: "publish flag",
        argv: ["--db", "{db}", "--date", "2026-06-15", "--dry-run", "--publish"],
        error: /Unknown option for health-coach-digest: --publish/
      },
      {
        name: "live flag",
        argv: ["--db", "{db}", "--date", "2026-06-15", "--dry-run", "--live"],
        error: /Unknown option for health-coach-digest: --live/
      },
      {
        name: "snapshot id",
        argv: ["--db", "{db}", "--date", "2026-06-15", "--dry-run", "--snapshot-id", "1"],
        error: /Unknown option for health-coach-digest: --snapshot-id/
      }
    ];

    for (const testCase of cases) {
      const dbPath = path.join(
        mkdtempSync(path.join(tmpdir(), `kl-cli-health-coach-digest-invalid-${testCase.name.replace(/\s+/g, "-")}-`)),
        "missing.db"
      );
      const argv = testCase.argv.map((arg) => (arg === "{db}" ? dbPath : arg));

      await expect(handleKlCommand(["health-coach-digest", ...argv])).rejects.toThrow(testCase.error);
      expect(existsSync(dbPath)).toBe(false);
    }
  });

  test("health-windows-logger config-check validates the repo-owned example without exposing secrets", async () => {
    const stdout = createCapture();
    const result = (await handleKlCommand(
      [
        "health-windows-logger",
        "config-check",
        "--config",
        "config/health/windows-logger.example.json"
      ],
      { stdout: stdout.sink }
    )) as KlHealthWindowsLoggerCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toEqual({
      command: "health-windows-logger",
      mode: "dry-run",
      action: "config-check",
      result: {
        configPath: "config/health/windows-logger.example.json",
        valid: true,
        loggerId: "knowledge-loop-windows",
        pollIntervalMs: 30_000,
        idleThresholdMs: 60_000,
        heartbeatIntervalMs: 300_000,
        visibleAlertChannel: "stdout"
      }
    });
  });

  test("health-windows-logger startup-command renders schtasks without registering it", async () => {
    const stdout = createCapture();
    const result = (await handleKlCommand(
      [
        "health-windows-logger",
        "startup-command",
        "--config",
        "config/health/windows-logger.example.json",
        "--script",
        "scripts/health-windows-logger.ts"
      ],
      { stdout: stdout.sink }
    )) as KlHealthWindowsLoggerCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "health-windows-logger",
      mode: "dry-run",
      action: "startup-command",
      result: {
        configPath: "config/health/windows-logger.example.json",
        scriptPath: "scripts/health-windows-logger.ts"
      }
    });
    if (result.action !== "startup-command") {
      throw new Error("expected startup-command result");
    }
    expect(result.result.commandLine).toContain("schtasks /Create");
    expect(result.result.commandLine).toContain("knowledge-loop-health-windows-logger");
    expect(result.result.commandLine).toContain("scripts/health-windows-logger.ts");
    expect(result.result.commandLine).toContain("config/health/windows-logger.example.json");
  });

  test("health-live-evidence windows-logger dry-run validates the example evidence", async () => {
    const stdout = createCapture();
    const result = (await handleKlCommand(
      [
        "health-live-evidence",
        "windows-logger",
        "--dry-run",
        "--evidence",
        "config/health/windows-logger-evidence.example.json"
      ],
      { stdout: stdout.sink }
    )) as KlHealthLiveEvidenceCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "health-live-evidence",
      mode: "dry-run",
      result: {
        kind: "windows-logger",
        evidencePath: "config/health/windows-logger-evidence.example.json",
        status: "observed_evidence_valid",
        valid: true,
        validation: {
          errors: [],
          warnings: [],
          summary: {
            longestSedentaryMinutes: 65,
            reminderDelayMinutes: 3,
            liveGate: "windows_logger_alert_observed"
          }
        }
      }
    });
  });

  test("health-live-evidence windows-logger reports blocked validation and enforces checkout-local paths", async () => {
    const invalidEvidencePath = "config/health/windows-logger-evidence.invalid.test.json";
    writeFileSync(
      invalidEvidencePath,
      JSON.stringify(
        {
          contractStatus: "observed_live_alert_pending_review",
          evidenceMode: "live-observation",
          date: "2026-06-14",
          logger: {
            loggerId: "knowledge-loop-windows",
            startupObserved: false,
            startupCommand: "schtasks /Create /TN knowledge-loop-health-windows-logger",
            sleepWakeSurvived: true,
            version: "health-windows-logger/0.1.0"
          },
          sedentaryStreak: {
            windowStart: "2026-06-14T08:00:00.000Z",
            windowEnd: "2026-06-14T08:59:00.000Z",
            durationMinutes: 59,
            source: "windows-logger:knowledge-loop-windows"
          },
          breakReminder: {
            eligibleAt: "2026-06-14T09:00:00.000Z",
            recordedAt: "2026-06-14T09:06:00.000Z",
            deliveryChannel: "windows-notification",
            visibleAlertObserved: false
          }
        },
        null,
        2
      )
    );

    try {
      const result = (await handleKlCommand([
        "health-live-evidence",
        "windows-logger",
        "--dry-run",
        "--evidence",
        invalidEvidencePath
      ])) as KlHealthLiveEvidenceCommandResult;

      expect(result.result.status).toBe("blocked");
      expect(result.result.valid).toBe(false);
      expect(result.result.validation.errors).toEqual(
        expect.arrayContaining([
          "logger.startupObserved must be true for the live gate",
          "sedentaryStreak.durationMinutes must be at least 60",
          "breakReminder.recordedAt must be within 5 minutes of eligibleAt",
          "breakReminder.visibleAlertObserved must be true for the live gate"
        ])
      );
    } finally {
      unlinkIfExists(invalidEvidencePath);
    }

    await expect(
      handleKlCommand([
        "health-live-evidence",
        "windows-logger",
        "--dry-run",
        "--evidence",
        "..\\outside.json"
      ])
    ).rejects.toThrow(/must stay inside the knowledge-loop checkout/);
  });

  test("health-live-evidence m4-review dry-run validates the example evidence", async () => {
    const stdout = createCapture();
    const result = (await handleKlCommand(
      [
        "health-live-evidence",
        "m4-review",
        "--dry-run",
        "--evidence",
        "config/health/m4-live-review-evidence.example.json"
      ],
      { stdout: stdout.sink }
    )) as KlHealthLiveEvidenceCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "health-live-evidence",
      mode: "dry-run",
      result: {
        kind: "m4-review",
        evidencePath: "config/health/m4-live-review-evidence.example.json",
        status: "observed_evidence_valid",
        valid: true,
        validation: {
          errors: [],
          warnings: []
        }
      }
    });
  });

  test("health-live-evidence m4-review returns blocked validation for invalid evidence", async () => {
    const invalidEvidencePath = "config/health/m4-live-review-evidence.invalid.test.json";
    writeFileSync(
      invalidEvidencePath,
      JSON.stringify(
        {
          contractStatus: "m4_complete",
          evidenceMode: "live-review",
          windowsLogger: {
            contractStatus: "observed_live_alert_pending_review",
            evidenceMode: "live-observation",
            date: "2026-06-14",
            logger: {
              loggerId: "knowledge-loop-windows",
              startupObserved: true,
              startupCommand:
                'schtasks /Create /TN knowledge-loop-health-windows-logger /SC ONLOGON /TR "npm exec tsx scripts/health-windows-logger.ts -- --config config/health/windows-logger.example.json" /F',
              sleepWakeSurvived: true,
              version: "health-windows-logger/0.1.0"
            },
            sedentaryStreak: {
              windowStart: "2026-06-14T08:00:00.000Z",
              windowEnd: "2026-06-14T09:05:00.000Z",
              durationMinutes: 65,
              source: "windows-logger:knowledge-loop-windows"
            },
            breakReminder: {
              eligibleAt: "2026-06-14T09:00:00.000Z",
              recordedAt: "2026-06-14T09:03:00.000Z",
              deliveryChannel: "windows-notification",
              visibleAlertObserved: false
            }
          },
          coachDigest: {
            date: "2026-06-14",
            snapshotId: 1,
            boardUrl: "http://127.0.0.1:8080/issues/health-digest-1",
            publishedAt: "2026-06-14T20:00:00.000Z"
          },
          compassHealthHashProof: {
            algorithm: "sha256",
            collectedOutsideHealthExtensions: true,
            before: {
              date: "2026-06-14",
              hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            afterOneWeek: {
              date: "2026-06-21",
              hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          }
        },
        null,
        2
      )
    );

    try {
      const result = (await handleKlCommand([
        "health-live-evidence",
        "m4-review",
        "--dry-run",
        "--evidence",
        invalidEvidencePath
      ])) as KlHealthLiveEvidenceCommandResult;

      expect(result.result.kind).toBe("m4-review");
      expect(result.result.status).toBe("blocked");
      expect(result.result.valid).toBe(false);
      expect(result.result.validation.errors).toEqual(
        expect.arrayContaining([
          "contractStatus must be m4_live_review_pending_verification",
          "windowsLogger.breakReminder.visibleAlertObserved must be true for the live gate"
        ])
      );
    } finally {
      unlinkIfExists(invalidEvidencePath);
    }
  });

  test("health-live-evidence m4-review enforces checkout-local evidence paths", async () => {
    await expect(
      handleKlCommand([
        "health-live-evidence",
        "m4-review",
        "--dry-run",
        "--evidence",
        "..\\outside-m4-review.json"
      ])
    ).rejects.toThrow(/must stay inside the knowledge-loop checkout/);
  });

  test("health-metric add creates a manual metric and writes health trace JSON", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-metric-add-")), "metrics.db");
    const stdout = createCapture();

    const result = (await handleKlCommand(
      [
        "health-metric",
        "add",
        "--db",
        dbPath,
        "--metric",
        "weight",
        "--label",
        "Weight",
        "--value",
        "58.2",
        "--unit",
        "kg",
        "--observed-at",
        "2026-06-14T08:00:00.000Z"
      ],
      { stdout: stdout.sink }
    )) as unknown as HealthMetricCliCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "health-metric",
      mode: "mock-persistent",
      action: "add",
      result: {
        metric: {
          id: 1,
          metricKey: "weight",
          metricLabel: "Weight",
          value: 58.2,
          unit: "kg",
          observedAt: "2026-06-14T08:00:00.000Z",
          source: "manual"
        },
        traceEvents: [{ stage: "metric", message: "Health metric created" }]
      }
    });
    expect(countHealthRows(dbPath, "health_metrics")).toBe(1);
    expect(countHealthRows(dbPath, "health_trace_events")).toBe(1);
    expect(countRows(dbPath, "trace_events")).toBe(0);
  });

  test("health-metric list filters metrics with date-only bounds without mutating the db", async () => {
    const dbPath = createHealthMetricDb();
    await handleKlCommand([
      "health-metric",
      "add",
      "--db",
      dbPath,
      "--metric",
      "weight",
      "--label",
      "Weight",
      "--value",
      "58.2",
      "--unit",
      "kg",
      "--observed-at",
      "2026-06-14T08:00:00.000Z"
    ]);
    await handleKlCommand([
      "health-metric",
      "add",
      "--db",
      dbPath,
      "--metric",
      "sleep",
      "--label",
      "Sleep",
      "--value",
      "7.5",
      "--unit",
      "hours",
      "--observed-at",
      "2026-06-14T22:00:00.000Z"
    ]);
    const beforeRows = {
      metrics: countHealthRows(dbPath, "health_metrics"),
      audits: countHealthRows(dbPath, "health_metric_audit_events"),
      imports: countHealthRows(dbPath, "health_metric_imports"),
      healthTraces: countHealthRows(dbPath, "health_trace_events"),
      legacyTraces: countRows(dbPath, "trace_events")
    };
    const stdout = createCapture();

    const result = (await handleKlCommand(
      [
        "health-metric",
        "list",
        "--db",
        dbPath,
        "--metric",
        "weight",
        "--from",
        "2026-06-14",
        "--to",
        "2026-06-15"
      ],
      { stdout: stdout.sink }
    )) as unknown as HealthMetricCliCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toEqual({
      command: "health-metric",
      mode: "mock-persistent",
      action: "list",
      result: [
        expect.objectContaining({
          id: 1,
          metricKey: "weight",
          metricLabel: "Weight",
          value: 58.2,
          unit: "kg",
          observedAt: "2026-06-14T08:00:00.000Z",
          source: "manual"
        })
      ]
    });
    expect({
      metrics: countHealthRows(dbPath, "health_metrics"),
      audits: countHealthRows(dbPath, "health_metric_audit_events"),
      imports: countHealthRows(dbPath, "health_metric_imports"),
      healthTraces: countHealthRows(dbPath, "health_trace_events"),
      legacyTraces: countRows(dbPath, "trace_events")
    }).toEqual(beforeRows);
  });

  test("health-metric update records a CLI audit and health trace", async () => {
    const dbPath = createHealthMetricDb();
    await handleKlCommand([
      "health-metric",
      "add",
      "--db",
      dbPath,
      "--metric",
      "weight",
      "--label",
      "Weight",
      "--value",
      "58.2",
      "--unit",
      "kg",
      "--observed-at",
      "2026-06-14T08:00:00.000Z"
    ]);
    const stdout = createCapture();

    const result = (await handleKlCommand(
      [
        "health-metric",
        "update",
        "--db",
        dbPath,
        "--id",
        "1",
        "--value",
        "58.0",
        "--reason",
        "corrected morning reading"
      ],
      { stdout: stdout.sink }
    )) as unknown as HealthMetricCliCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "health-metric",
      mode: "mock-persistent",
      action: "update",
      result: {
        metric: {
          id: 1,
          value: 58.0,
          updatedAt: expect.any(String)
        },
        audit: {
          id: 1,
          metricId: 1,
          changedBy: "cli",
          reason: "corrected morning reading",
          previous: { value: 58.2 },
          next: { value: 58.0 }
        },
        traceEvents: [{ stage: "metric", message: "Health metric updated" }]
      }
    });
    expect(countHealthRows(dbPath, "health_metric_audit_events")).toBe(1);
    expect(countHealthRows(dbPath, "health_trace_events")).toBe(2);
    expect(countRows(dbPath, "trace_events")).toBe(0);
  });

  test("health-metric import-csv imports an existing checkout-local csv file", async () => {
    const dbPath = createHealthMetricDb();
    const csvPath = path.join(path.dirname(dbPath), "metrics.csv");
    writeFileSync(
      csvPath,
      [
        "metric_key,metric_label,value,unit,observed_at,note",
        "weight,Weight,58.2,kg,2026-06-14T08:00:00.000Z,morning reading",
        "sleep,Sleep,7.5,hours,2026-06-14T22:00:00.000Z,"
      ].join("\n"),
      "utf8"
    );
    const stdout = createCapture();

    const result = (await handleKlCommand(
      ["health-metric", "import-csv", "--db", dbPath, "--file", csvPath],
      { stdout: stdout.sink }
    )) as unknown as HealthMetricCliCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "health-metric",
      mode: "mock-persistent",
      action: "import-csv",
      result: {
        importRecord: {
          id: 1,
          sourceFilename: "metrics.csv",
          rowCount: 2,
          acceptedCount: 2,
          rejectedCount: 0
        },
        duplicate: false,
        rows: [
          { rowNumber: 2, status: "accepted", metric: { metricKey: "weight", source: "csv" } },
          { rowNumber: 3, status: "accepted", metric: { metricKey: "sleep", source: "csv" } }
        ],
        traceEvents: [{ stage: "metric", message: "Health metrics CSV imported" }]
      }
    });
    expect(countHealthRows(dbPath, "health_metric_imports")).toBe(1);
    expect(countHealthRows(dbPath, "health_metrics")).toBe(2);
    expect(countHealthRows(dbPath, "health_trace_events")).toBe(1);
    expect(countRows(dbPath, "trace_events")).toBe(0);
  });

  test("health-metric import-csv rejects a non-csv regular file before inserting imports", async () => {
    const dbPath = createHealthMetricDb();
    const textPath = path.join(path.dirname(dbPath), "metrics.txt");
    writeFileSync(
      textPath,
      "metric_key,metric_label,value,unit,observed_at\nweight,Weight,58.2,kg,2026-06-14T08:00:00.000Z\n",
      "utf8"
    );

    await expect(handleKlCommand(["health-metric", "import-csv", "--db", dbPath, "--file", textPath])).rejects.toThrow(
      /CSV file must use a \.csv extension/
    );

    expect(countHealthRows(dbPath, "health_metric_imports")).toBe(0);
    expect(countHealthRows(dbPath, "health_metrics")).toBe(0);
  });

  test("health-metric import-csv rejects compass-health paths before inserting imports", async () => {
    const dbPath = createHealthMetricDb();
    const compassDir = mkdtempSync(path.join(tmpdir(), "compass-health-fixture-"));
    const csvPath = path.join(compassDir, "metrics.csv");
    writeFileSync(
      csvPath,
      "metric_key,metric_label,value,unit,observed_at\nweight,Weight,58.2,kg,2026-06-14T08:00:00.000Z\n",
      "utf8"
    );

    await expect(handleKlCommand(["health-metric", "import-csv", "--db", dbPath, "--file", csvPath])).rejects.toThrow(
      /Health metric CSV must not be read from compass-health files/
    );
    await expect(handleKlCommand(["health-metric", "import-csv", "--db", dbPath, "--file", csvPath])).rejects.not.toThrow(
      csvPath
    );

    expect(countHealthRows(dbPath, "health_metric_imports")).toBe(0);
    expect(countHealthRows(dbPath, "health_metrics")).toBe(0);
  });

  test("health-metric add rejects invalid domain inputs before creating a missing db", async () => {
    const cases: Array<{
      readonly name: string;
      readonly option: "--metric" | "--label" | "--unit" | "--observed-at" | "--now";
      readonly value: string;
      readonly error: RegExp;
    }> = [
      {
        name: "invalid observed instant",
        option: "--observed-at",
        value: "2026-06-14",
        error: /observedAt must be an ISO instant|Invalid --observed-at/
      },
      {
        name: "invalid now instant",
        option: "--now",
        value: "2026-06-14",
        error: /Invalid --now value "2026-06-14"/
      },
      {
        name: "blank label",
        option: "--label",
        value: "   ",
        error: /metricLabel is required/
      },
      {
        name: "blank metric",
        option: "--metric",
        value: "   ",
        error: /metricKey is required/
      },
      {
        name: "invalid metric",
        option: "--metric",
        value: "!!!",
        error: /metricKey must contain at least one alphanumeric character/
      },
      {
        name: "blank unit",
        option: "--unit",
        value: "   ",
        error: /unit is required/
      },
      {
        name: "unsafe unit",
        option: "--unit",
        value: "kg\u0001",
        error: /unit contains unsupported control characters/
      }
    ];

    for (const testCase of cases) {
      const dbPath = path.join(
        mkdtempSync(path.join(tmpdir(), `kl-cli-health-metric-invalid-${testCase.name.replace(/\s+/g, "-")}-`)),
        "missing.db"
      );
      const argv = [
        "health-metric",
        "add",
        "--db",
        dbPath,
        "--metric",
        "weight",
        "--label",
        "Weight",
        "--value",
        "58.2",
        "--unit",
        "kg",
        "--observed-at",
        "2026-06-14T08:00:00.000Z"
      ];

      if (testCase.option === "--now") {
        argv.push("--now", testCase.value);
      } else {
        argv[argv.indexOf(testCase.option) + 1] = testCase.value;
      }

      await expect(handleKlCommand(argv)).rejects.toThrow(testCase.error);
      expect(existsSync(dbPath)).toBe(false);
    }
  });

  test("health-metric validates options before creating missing databases where possible", async () => {
    const addDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-metric-invalid-add-")), "missing.db");
    const updateDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-metric-invalid-update-")), "missing.db");

    await expect(
      handleKlCommand([
        "health-metric",
        "add",
        "--db",
        addDbPath,
        "--metric",
        "weight",
        "--label",
        "Weight",
        "--value",
        "not-a-number",
        "--unit",
        "kg",
        "--observed-at",
        "2026-06-14T08:00:00.000Z"
      ])
    ).rejects.toThrow(/Invalid --value value "not-a-number"/);
    await expect(
      handleKlCommand([
        "health-metric",
        "update",
        "--db",
        updateDbPath,
        "--id",
        "0",
        "--value",
        "58.0",
        "--reason",
        "corrected morning reading"
      ])
    ).rejects.toThrow(/Invalid --id value "0"/);

    expect(existsSync(addDbPath)).toBe(false);
    expect(existsSync(updateDbPath)).toBe(false);
  });

  test("health-metric list update and import-csv do not create missing databases", async () => {
    const listDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-metric-missing-list-")), "missing.db");
    const updateDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-metric-missing-update-")), "missing.db");
    const importDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-metric-missing-import-")), "missing.db");
    const csvPath = path.join(path.dirname(importDbPath), "metrics.csv");
    writeFileSync(
      csvPath,
      "metric_key,metric_label,value,unit,observed_at\nweight,Weight,58.2,kg,2026-06-14T08:00:00.000Z\n",
      "utf8"
    );

    await expect(
      handleKlCommand([
        "health-metric",
        "list",
        "--db",
        listDbPath,
        "--metric",
        "weight",
        "--from",
        "2026-06-14",
        "--to",
        "2026-06-15"
      ])
    ).rejects.toThrow();
    await expect(
      handleKlCommand([
        "health-metric",
        "update",
        "--db",
        updateDbPath,
        "--id",
        "1",
        "--value",
        "58.0",
        "--reason",
        "corrected morning reading"
      ])
    ).rejects.toThrow();
    await expect(handleKlCommand(["health-metric", "import-csv", "--db", importDbPath, "--file", csvPath])).rejects.toThrow();

    expect(existsSync(listDbPath)).toBe(false);
    expect(existsSync(updateDbPath)).toBe(false);
    expect(existsSync(importDbPath)).toBe(false);
  });

  test("health-metric rejects missing duplicate and unknown options", async () => {
    const dbPath = createHealthMetricDb();
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(handleKlCommand(["health-metric", "list", "--metric", "weight"])).rejects.toThrow(
      /requires exactly one --db/
    );
    await expect(
      handleKlCommand(["health-metric", "list", "--db", dbPath, "--db", otherDbPath, "--metric", "weight"])
    ).rejects.toThrow(/requires exactly one --db/);
    await expect(
      handleKlCommand(["health-metric", "add", "--db", dbPath, "--metric", "weight", "--bogus", "1"])
    ).rejects.toThrow(/Unknown option for health-metric add: --bogus/);
  });

  test("health-exercise creates a template plan completion and read summary without legacy traces", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-exercise-flow-")), "exercise.db");
    const templateStdout = createCapture();

    const template = (await handleKlCommand(
      [
        "health-exercise",
        "template",
        "create",
        "--db",
        dbPath,
        "--slug",
        "starter-strength",
        "--name",
        "Starter Strength",
        "--day",
        "0:push:Push:20",
        "--day",
        "2:pull:Pull:30"
      ],
      { stdout: templateStdout.sink }
    )) as unknown as HealthExerciseCliCommandResult;

    expect(parseCapturedJson(templateStdout)).toEqual(template);
    expect(template).toMatchObject({
      command: "health-exercise",
      mode: "mock-persistent",
      action: "template.create",
      result: {
        created: true,
        template: {
          id: 1,
          slug: "starter-strength",
          name: "Starter Strength",
          defaultDays: [
            { dayOffset: 0, sessionKey: "push", title: "Push", targetMinutes: 20 },
            { dayOffset: 2, sessionKey: "pull", title: "Pull", targetMinutes: 30 }
          ]
        }
      }
    });

    const plan = (await handleKlCommand([
      "health-exercise",
      "plan",
      "create",
      "--db",
      dbPath,
      "--template",
      "starter-strength",
      "--week-start",
      "2026-06-15"
    ])) as unknown as HealthExerciseCliCommandResult;
    const planResult = plan.result as { sessions: Array<{ id: number; durationMinutes: number }> };

    expect(plan).toMatchObject({
      command: "health-exercise",
      mode: "mock-persistent",
      action: "plan.create",
      result: {
        plan: { id: 1, weekStart: "2026-06-15", status: "active" },
        sessions: [
          { id: 1, templateSessionKey: "push", status: "planned", durationMinutes: 20 },
          { id: 2, templateSessionKey: "pull", status: "planned", durationMinutes: 30 }
        ]
      }
    });

    const complete = (await handleKlCommand([
      "health-exercise",
      "complete",
      "--db",
      dbPath,
      "--session-id",
      String(planResult.sessions[0]!.id),
      "--completed-at",
      "2026-06-15T09:00:00.000Z",
      "--duration-minutes",
      "20",
      "--intensity",
      "moderate"
    ])) as unknown as HealthExerciseCliCommandResult;

    expect(complete).toMatchObject({
      command: "health-exercise",
      mode: "mock-persistent",
      action: "complete",
      result: {
        session: {
          id: 1,
          status: "completed",
          completedAt: "2026-06-15T09:00:00.000Z",
          durationMinutes: 20,
          intensity: "moderate"
        }
      }
    });

    const completionStdout = createCapture();
    const completion = (await handleKlCommand(
      [
        "health-exercise",
        "completion",
        "--db",
        dbPath,
        "--from",
        "2026-06-15",
        "--to",
        "2026-06-22"
      ],
      { stdout: completionStdout.sink }
    )) as unknown as HealthExerciseCliCommandResult;

    expect(parseCapturedJson(completionStdout)).toEqual(completion);
    expect(completion).toMatchObject({
      command: "health-exercise",
      mode: "mock-persistent",
      action: "completion",
      result: {
        planned: 2,
        completed: 1,
        missed: 1,
        rate: 0.5,
        sessions: [{ status: "completed" }, { status: "missed" }],
        adHocSessions: []
      }
    });
    expect(countHealthExerciseRows(dbPath)).toEqual({
      templates: 1,
      plans: 1,
      sessions: 2,
      healthTraces: 0,
      legacyTraces: 0
    });
  });

  test("health-exercise plan create does not create a missing database", async () => {
    const missingDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-exercise-missing-plan-")), "missing.db");

    await expect(
      handleKlCommand([
        "health-exercise",
        "plan",
        "create",
        "--db",
        missingDbPath,
        "--template",
        "starter-strength",
        "--week-start",
        "2026-06-15"
      ])
    ).rejects.toThrow(/Health exercise database does not exist/);

    expect(existsSync(missingDbPath)).toBe(false);
  });

  test("health-exercise completion opens read-only and does not mutate database rows", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-exercise-readonly-")), "exercise.db");
    await handleKlCommand([
      "health-exercise",
      "template",
      "create",
      "--db",
      dbPath,
      "--slug",
      "starter-strength",
      "--name",
      "Starter Strength",
      "--day",
      "0:push:Push:20"
    ]);
    await handleKlCommand([
      "health-exercise",
      "plan",
      "create",
      "--db",
      dbPath,
      "--template",
      "starter-strength",
      "--week-start",
      "2026-06-15"
    ]);
    const beforeRows = countHealthExerciseRows(dbPath);

    const result = (await handleKlCommand([
      "health-exercise",
      "completion",
      "--db",
      dbPath,
      "--from",
      "2026-06-15",
      "--to",
      "2026-06-22"
    ])) as unknown as HealthExerciseCliCommandResult;

    expect(result).toMatchObject({
      command: "health-exercise",
      mode: "mock-persistent",
      action: "completion",
      result: { planned: 1, completed: 0, missed: 1, rate: 0 }
    });
    expect(countHealthExerciseRows(dbPath)).toEqual(beforeRows);
  });

  test("health-exercise rejects invalid day target mode intensity and dates before creating missing databases", async () => {
    const cases: Array<{
      readonly name: string;
      readonly argv: readonly string[];
      readonly error: RegExp;
    }> = [
      {
        name: "day target",
        argv: [
          "health-exercise",
          "template",
          "create",
          "--slug",
          "starter-strength",
          "--name",
          "Starter Strength",
          "--day",
          "0:push:Push:not-a-number"
        ],
        error: /Invalid --day value/
      },
      {
        name: "negative day",
        argv: [
          "health-exercise",
          "template",
          "create",
          "--slug",
          "starter-strength",
          "--name",
          "Starter Strength",
          "--day",
          "-1:push:Push:20"
        ],
        error: /Invalid --day value/
      },
      {
        name: "partial target",
        argv: [
          "health-exercise",
          "complete",
          "--plan-id",
          "1",
          "--completed-at",
          "2026-06-15T09:00:00.000Z"
        ],
        error: /completion target must be sessionId, planId with templateSessionKey, or omitted/
      },
      {
        name: "mixed target",
        argv: [
          "health-exercise",
          "complete",
          "--session-id",
          "1",
          "--plan-id",
          "1",
          "--template-session-key",
          "push",
          "--completed-at",
          "2026-06-15T09:00:00.000Z"
        ],
        error: /completion target must be sessionId, planId with templateSessionKey, or omitted/
      },
      {
        name: "intensity",
        argv: [
          "health-exercise",
          "complete",
          "--completed-at",
          "2026-06-15T09:00:00.000Z",
          "--intensity",
          "extreme"
        ],
        error: /Invalid --intensity value/
      },
      {
        name: "completed-at",
        argv: ["health-exercise", "complete", "--completed-at", "2026-06-15"],
        error: /Invalid --completed-at value/
      },
      {
        name: "completion from",
        argv: ["health-exercise", "completion", "--from", "2026-02-31", "--to", "2026-06-22"],
        error: /Invalid --from value/
      }
    ];

    for (const testCase of cases) {
      const dbPath = path.join(
        mkdtempSync(path.join(tmpdir(), `kl-cli-health-exercise-invalid-${testCase.name.replace(/\s+/g, "-")}-`)),
        "missing.db"
      );
      const dbInsertIndex = testCase.argv[1] === "template" || testCase.argv[1] === "plan" ? 3 : 2;
      const argv = [
        ...testCase.argv.slice(0, dbInsertIndex),
        "--db",
        dbPath,
        ...testCase.argv.slice(dbInsertIndex)
      ];

      await expect(handleKlCommand(argv)).rejects.toThrow(testCase.error);
      expect(existsSync(dbPath)).toBe(false);
    }
  });

  test("health-exercise rejects unknown missing and duplicate options", async () => {
    const dbPath = createHealthMetricDb();
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(handleKlCommand(["health-exercise"])).rejects.toThrow(/requires one action/);
    await expect(
      handleKlCommand([
        "health-exercise",
        "template",
        "create",
        "--db",
        dbPath,
        "--slug",
        "starter-strength",
        "--name",
        "Starter Strength",
        "--day",
        "0:push:Push:20",
        "--bogus",
        "1"
      ])
    ).rejects.toThrow(/Unknown option for health-exercise template create: --bogus/);
    await expect(
      handleKlCommand([
        "health-exercise",
        "template",
        "create",
        "--db",
        dbPath,
        "--db",
        otherDbPath,
        "--slug",
        "starter-strength",
        "--name",
        "Starter Strength",
        "--day",
        "0:push:Push:20"
      ])
    ).rejects.toThrow(/requires exactly one --db/);
    await expect(
      handleKlCommand([
        "health-exercise",
        "template",
        "create",
        "--db",
        dbPath,
        "--slug",
        "starter-strength",
        "--name",
        "Starter Strength"
      ])
    ).rejects.toThrow(/requires at least one --day/);
    await expect(
      handleKlCommand([
        "health-exercise",
        "completion",
        "--db",
        dbPath,
        "--from",
        "2026-06-15",
        "--from",
        "2026-06-16",
        "--to",
        "2026-06-22"
      ])
    ).rejects.toThrow(/requires exactly one --from/);
  });

  test("health-sedentary ingests spans summarizes read-only and evaluates deterministic reminders", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-sedentary-flow-")), "sedentary.db");
    const ingestStdout = createCapture();

    const firstIngest = (await handleKlCommand(
      [
        "health-sedentary",
        "ingest-span",
        "--db",
        dbPath,
        "--source-id",
        "desk-idle-1",
        "--start",
        "2026-06-15T10:00:00.000Z",
        "--end",
        "2026-06-15T11:10:00.000Z",
        "--state",
        "idle",
        "--confidence",
        "0.95",
        "--received-at",
        "2026-06-15T11:10:00.000Z"
      ],
      { stdout: ingestStdout.sink }
    )) as unknown as HealthSedentaryCliCommandResult;

    expect(parseCapturedJson(ingestStdout)).toEqual(firstIngest);
    expect(firstIngest).toMatchObject({
      command: "health-sedentary",
      mode: "mock-persistent",
      action: "ingest-span",
      result: {
        id: 1,
        sourceId: "desk-idle-1",
        spanStart: "2026-06-15T10:00:00.000Z",
        spanEnd: "2026-06-15T11:10:00.000Z",
        state: "idle",
        confidence: 0.95,
        receivedAt: "2026-06-15T11:10:00.000Z"
      }
    });
    expect(existsSync(dbPath)).toBe(true);

    await handleKlCommand([
      "health-sedentary",
      "ingest-span",
      "--db",
      dbPath,
      "--source-id",
      "desk-active-break",
      "--start",
      "2026-06-15T11:10:00.000Z",
      "--end",
      "2026-06-15T11:14:00.000Z",
      "--state",
      "active"
    ]);
    await handleKlCommand([
      "health-sedentary",
      "ingest-span",
      "--db",
      dbPath,
      "--source-id",
      "desk-idle-2",
      "--start",
      "2026-06-15T11:14:00.000Z",
      "--end",
      "2026-06-15T11:40:00.000Z",
      "--state",
      "idle"
    ]);

    const beforeSummaryRows = {
      spans: countHealthRows(dbPath, "sedentary_spans"),
      streaks: countHealthRows(dbPath, "sedentary_streaks"),
      reminders: countHealthRows(dbPath, "break_reminders")
    };
    const summaryStdout = createCapture();

    const summary = (await handleKlCommand(
      [
        "health-sedentary",
        "summary",
        "--db",
        dbPath,
        "--from",
        "2026-06-15T10:00:00.000Z",
        "--to",
        "2026-06-15T11:40:00.000Z",
        "--active-break-minutes",
        "5",
        "--merge-unknown-gaps",
        "false"
      ],
      { stdout: summaryStdout.sink }
    )) as unknown as HealthSedentaryCliCommandResult;

    expect(parseCapturedJson(summaryStdout)).toEqual(summary);
    expect(summary).toMatchObject({
      command: "health-sedentary",
      mode: "mock-persistent",
      action: "summary",
      result: {
        from: "2026-06-15T10:00:00.000Z",
        to: "2026-06-15T11:40:00.000Z",
        idleMinutes: 96,
        activeMinutes: 4,
        unknownMinutes: 0,
        longestIdleStreakMinutes: 100,
        currentIdleStreakMinutes: 100,
        currentIdleStreak: {
          windowStart: "2026-06-15T10:00:00.000Z",
          windowEnd: "2026-06-15T11:40:00.000Z",
          durationMinutes: 100,
          idleMinutes: 96,
          sourceSpanIds: [1, 2, 3]
        },
        idleStreaks: [
          {
            windowStart: "2026-06-15T10:00:00.000Z",
            windowEnd: "2026-06-15T11:40:00.000Z",
            durationMinutes: 100,
            idleMinutes: 96,
            sourceSpanIds: [1, 2, 3]
          }
        ],
        spans: [
          { id: 1, sourceId: "desk-idle-1", state: "idle" },
          { id: 2, sourceId: "desk-active-break", state: "active" },
          { id: 3, sourceId: "desk-idle-2", state: "idle" }
        ]
      }
    });
    expect({
      spans: countHealthRows(dbPath, "sedentary_spans"),
      streaks: countHealthRows(dbPath, "sedentary_streaks"),
      reminders: countHealthRows(dbPath, "break_reminders")
    }).toEqual(beforeSummaryRows);

    const reminderStdout = createCapture();
    const firstReminder = (await handleKlCommand(
      [
        "health-break-reminder",
        "evaluate",
        "--db",
        dbPath,
        "--from",
        "2026-06-15T10:00:00.000Z",
        "--to",
        "2026-06-15T11:40:00.000Z",
        "--threshold-minutes",
        "60",
        "--cooldown-minutes",
        "30",
        "--evaluated-at",
        "2026-06-15T11:40:00.000Z",
        "--active-break-minutes",
        "5",
        "--merge-unknown-gaps",
        "false",
        "--delivery-channel",
        "desktop"
      ],
      { stdout: reminderStdout.sink }
    )) as unknown as HealthBreakReminderCliCommandResult;

    expect(parseCapturedJson(reminderStdout)).toEqual(firstReminder);
    expect(firstReminder).toMatchObject({
      command: "health-break-reminder",
      mode: "mock-persistent",
      action: "evaluate",
      result: {
        status: "eligible",
        summary: { currentIdleStreakMinutes: 100 },
        streak: {
          id: 1,
          windowStart: "2026-06-15T10:00:00.000Z",
          windowEnd: "2026-06-15T11:40:00.000Z",
          durationMinutes: 100,
          sourceSpanIds: [1, 2, 3],
          computedAt: "2026-06-15T11:40:00.000Z"
        },
        reminder: {
          id: 1,
          streakId: 1,
          eligibleAt: "2026-06-15T11:00:00.000Z",
          status: "eligible",
          reason: "sedentary streak reached 60 minutes",
          deliveryChannel: "desktop"
        }
      }
    });
    expect(countHealthRows(dbPath, "sedentary_streaks")).toBe(1);
    expect(countHealthRows(dbPath, "break_reminders")).toBe(1);

    const secondReminder = (await handleKlCommand([
      "health-break-reminder",
      "evaluate",
      "--db",
      dbPath,
      "--from",
      "2026-06-15T10:00:00.000Z",
      "--to",
      "2026-06-15T11:40:00.000Z",
      "--threshold-minutes",
      "60",
      "--cooldown-minutes",
      "30",
      "--evaluated-at",
      "2026-06-15T11:45:00.000Z"
    ])) as unknown as HealthBreakReminderCliCommandResult;

    expect(secondReminder).toMatchObject({
      command: "health-break-reminder",
      mode: "mock-persistent",
      action: "evaluate",
      result: {
        status: "eligible",
        streak: { id: 1 },
        reminder: { id: 1, status: "eligible" }
      }
    });
    expect(countHealthRows(dbPath, "sedentary_streaks")).toBe(1);
    expect(countHealthRows(dbPath, "break_reminders")).toBe(1);
  });

  test("health-sedentary summary and break reminder evaluate do not create missing databases", async () => {
    const summaryDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-sedentary-missing-summary-")), "missing.db");
    const reminderDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-health-break-reminder-missing-evaluate-")), "missing.db");

    await expect(
      handleKlCommand([
        "health-sedentary",
        "summary",
        "--db",
        summaryDbPath,
        "--from",
        "2026-06-15T10:00:00.000Z",
        "--to",
        "2026-06-15T11:00:00.000Z"
      ])
    ).rejects.toThrow(/Health sedentary database does not exist/);
    await expect(
      handleKlCommand([
        "health-break-reminder",
        "evaluate",
        "--db",
        reminderDbPath,
        "--from",
        "2026-06-15T10:00:00.000Z",
        "--to",
        "2026-06-15T11:00:00.000Z"
      ])
    ).rejects.toThrow(/Health sedentary database does not exist/);

    expect(existsSync(summaryDbPath)).toBe(false);
    expect(existsSync(reminderDbPath)).toBe(false);
  });

  test("health-sedentary and break reminder validate options before creating missing databases where possible", async () => {
    const cases: Array<{
      readonly name: string;
      readonly argv: (dbPath: string) => readonly string[];
      readonly error: RegExp;
    }> = [
      {
        name: "sedentary-state",
        argv: (dbPath) => [
          "health-sedentary",
          "ingest-span",
          "--db",
          dbPath,
          "--source-id",
          "desk-idle-1",
          "--start",
          "2026-06-15T10:00:00.000Z",
          "--end",
          "2026-06-15T11:00:00.000Z",
          "--state",
          "away"
        ],
        error: /Invalid --state value "away"/
      },
      {
        name: "sedentary-confidence",
        argv: (dbPath) => [
          "health-sedentary",
          "ingest-span",
          "--db",
          dbPath,
          "--source-id",
          "desk-idle-1",
          "--start",
          "2026-06-15T10:00:00.000Z",
          "--end",
          "2026-06-15T11:00:00.000Z",
          "--state",
          "idle",
          "--confidence",
          "1.1"
        ],
        error: /Invalid --confidence value "1.1"/
      },
      {
        name: "sedentary-span-order",
        argv: (dbPath) => [
          "health-sedentary",
          "ingest-span",
          "--db",
          dbPath,
          "--source-id",
          "desk-idle-1",
          "--start",
          "2026-06-15T11:00:00.000Z",
          "--end",
          "2026-06-15T10:00:00.000Z",
          "--state",
          "idle"
        ],
        error: /Invalid --end value "2026-06-15T10:00:00.000Z"/
      },
      {
        name: "sedentary-active-break",
        argv: (dbPath) => [
          "health-sedentary",
          "summary",
          "--db",
          dbPath,
          "--from",
          "2026-06-15T10:00:00.000Z",
          "--to",
          "2026-06-15T11:00:00.000Z",
          "--active-break-minutes",
          "-1"
        ],
        error: /Invalid --active-break-minutes value "-1"/
      },
      {
        name: "sedentary-boolean",
        argv: (dbPath) => [
          "health-sedentary",
          "summary",
          "--db",
          dbPath,
          "--from",
          "2026-06-15T10:00:00.000Z",
          "--to",
          "2026-06-15T11:00:00.000Z",
          "--merge-unknown-gaps",
          "maybe"
        ],
        error: /Invalid --merge-unknown-gaps value "maybe"/
      },
      {
        name: "break-threshold",
        argv: (dbPath) => [
          "health-break-reminder",
          "evaluate",
          "--db",
          dbPath,
          "--from",
          "2026-06-15T10:00:00.000Z",
          "--to",
          "2026-06-15T11:00:00.000Z",
          "--threshold-minutes",
          "0"
        ],
        error: /Invalid --threshold-minutes value "0"/
      },
      {
        name: "break-cooldown",
        argv: (dbPath) => [
          "health-break-reminder",
          "evaluate",
          "--db",
          dbPath,
          "--from",
          "2026-06-15T10:00:00.000Z",
          "--to",
          "2026-06-15T11:00:00.000Z",
          "--cooldown-minutes",
          "-1"
        ],
        error: /Invalid --cooldown-minutes value "-1"/
      },
      {
        name: "break-evaluated-at",
        argv: (dbPath) => [
          "health-break-reminder",
          "evaluate",
          "--db",
          dbPath,
          "--from",
          "2026-06-15T10:00:00.000Z",
          "--to",
          "2026-06-15T11:00:00.000Z",
          "--evaluated-at",
          "2026-06-15"
        ],
        error: /Invalid --evaluated-at value "2026-06-15"/
      }
    ];

    for (const testCase of cases) {
      const dbPath = path.join(
        mkdtempSync(path.join(tmpdir(), `kl-cli-health-sedentary-invalid-${testCase.name}-`)),
        "missing.db"
      );

      await expect(handleKlCommand(testCase.argv(dbPath))).rejects.toThrow(testCase.error);
      expect(existsSync(dbPath)).toBe(false);
    }
  });

  test("health-sedentary and break reminder reject missing duplicate and unknown options", async () => {
    const dbPath = createHealthMetricDb();
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(handleKlCommand(["health-sedentary"])).rejects.toThrow(/requires one action/);
    await expect(
      handleKlCommand([
        "health-sedentary",
        "summary",
        "--from",
        "2026-06-15T10:00:00.000Z",
        "--to",
        "2026-06-15T11:00:00.000Z"
      ])
    ).rejects.toThrow(/requires exactly one --db/);
    await expect(
      handleKlCommand([
        "health-sedentary",
        "summary",
        "--db",
        dbPath,
        "--db",
        otherDbPath,
        "--from",
        "2026-06-15T10:00:00.000Z",
        "--to",
        "2026-06-15T11:00:00.000Z"
      ])
    ).rejects.toThrow(/requires exactly one --db/);
    await expect(
      handleKlCommand([
        "health-sedentary",
        "ingest-span",
        "--db",
        dbPath,
        "--source-id",
        "desk-idle-1",
        "--start",
        "2026-06-15T10:00:00.000Z",
        "--end",
        "2026-06-15T11:00:00.000Z",
        "--state",
        "idle",
        "--bogus",
        "1"
      ])
    ).rejects.toThrow(/Unknown option for health-sedentary ingest-span: --bogus/);

    await expect(handleKlCommand(["health-break-reminder"])).rejects.toThrow(/requires action evaluate/);
    await expect(handleKlCommand(["health-break-reminder", "send", "--db", dbPath])).rejects.toThrow(
      /requires action evaluate/
    );
    await expect(
      handleKlCommand([
        "health-break-reminder",
        "evaluate",
        "--db",
        dbPath,
        "--from",
        "2026-06-15T10:00:00.000Z",
        "--from",
        "2026-06-15T10:05:00.000Z",
        "--to",
        "2026-06-15T11:00:00.000Z"
      ])
    ).rejects.toThrow(/requires exactly one --from/);
    await expect(
      handleKlCommand([
        "health-break-reminder",
        "evaluate",
        "--db",
        dbPath,
        "--from",
        "2026-06-15T10:00:00.000Z",
        "--to",
        "2026-06-15T11:00:00.000Z",
        "--bogus",
        "1"
      ])
    ).rejects.toThrow(/Unknown option for health-break-reminder evaluate: --bogus/);
  });

  test("agent dry-run prints planned Multica actions without requiring API keys", async () => {
    const envNames = ["DEEPSEEK_API_KEY", "QWEN_API_KEY", "OPENAI_API_KEY", "LLM_PROVIDER"] as const;
    const savedEnv = new Map<(typeof envNames)[number], string | undefined>(
      envNames.map((name) => [name, process.env[name]])
    );
    const stdout = createCapture();

    try {
      for (const name of envNames) {
        delete process.env[name];
      }

      const result = (await handleKlCommand(
        [
          "agent",
          "--dry-run",
          "--role",
          "scholar",
          "--phase",
          "morning-plan",
          "--date",
          "2026-06-13",
          "--knowledge-loop-url",
          "http://127.0.0.1:3124/",
          "--board",
          "Holly Daily"
        ],
        { stdout: stdout.sink }
      )) as KlAgentDryRunCommandResult;

      expect(parseCapturedJson(stdout)).toEqual(result);
      expect(result).toMatchObject({
        command: "agent",
        mode: "dry-run",
        result: {
          mode: "dry-run",
          role: "scholar",
          phase: "morning-plan",
          date: "2026-06-13",
          multicaBoard: "Holly Daily",
          externalWrites: [],
          llmCost: { estimatedUsd: 0, source: "dry-run-no-llm" }
        }
      });
      expect(result.result.externalReads).toEqual([
        expect.objectContaining({
          method: "GET",
          url: "http://127.0.0.1:3124/api/plan/today"
        })
      ]);
      expect(result.result.intendedActions).toEqual([
        expect.objectContaining({
          target: "multica",
          type: "create_task",
          title: "Scholar study plan for 2026-06-13"
        })
      ]);
    } finally {
      for (const [name, value] of savedEnv) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  test("agent command requires dry-run mode and validates role phase combinations", async () => {
    await expect(handleKlCommand(["agent", "--role", "librarian", "--date", "2026-06-13"])).rejects.toThrow(
      /supports only --dry-run/
    );
    await expect(handleKlCommand(["agent", "--dry-run", "--role", "mentor", "--date", "2026-06-13"])).rejects.toThrow(
      /Invalid agent role/
    );
    await expect(
      handleKlCommand(["agent", "--dry-run", "--role", "coach", "--date", "2026-06-13"])
    ).resolves.toMatchObject({
      command: "agent",
      mode: "dry-run",
      result: {
        role: "coach",
        phase: "daily-health",
        date: "2026-06-13",
        externalWrites: [],
        intendedActions: [
          expect.objectContaining({
            title: "Coach health digest for 2026-06-13",
            type: "add_comment"
          })
        ]
      }
    });
    await expect(
      handleKlCommand(["agent", "--dry-run", "--role", "librarian", "--phase", "morning-plan", "--date", "2026-06-13"])
    ).rejects.toThrow(/cannot run phase/);
  });

  test("agent command rejects duplicate options, missing values, and invalid dates", async () => {
    await expect(
      handleKlCommand(["agent", "--dry-run", "--role", "librarian", "--role", "scholar", "--date", "2026-06-13"])
    ).rejects.toThrow(/requires exactly one --role/);
    await expect(handleKlCommand(["agent", "--dry-run", "--role", "librarian", "--date"])).rejects.toThrow(
      /Option --date for agent requires a value/
    );
    await expect(handleKlCommand(["agent", "--dry-run", "--role", "librarian", "--date", "2026-02-31"])).rejects.toThrow(
      /Invalid agent date/
    );
    await expect(
      handleKlCommand(["agent", "--dry-run", "--role", "nutritionist", "--date", "2026-06-13", "--bogus", "1"])
    ).rejects.toThrow(/Unknown option for agent: --bogus/);
  });

  test("agent-day dry-run prints the board-day sequence with Coach health digest", async () => {
    const stdout = createCapture();
    const result = (await handleKlCommand(
      [
        "agent-day",
        "--dry-run",
        "--date",
        "2026-06-13",
        "--knowledge-loop-url",
        "http://127.0.0.1:3124",
        "--compass-health-url",
        "http://compass.local/",
        "--board",
        "Holly Daily"
      ],
      { stdout: stdout.sink }
    )) as KlAgentDayDryRunCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "agent-day",
      mode: "dry-run",
      result: {
        mode: "dry-run",
        date: "2026-06-13",
        multicaBoard: "Holly Daily",
        externalWrites: []
      }
    });
    expect(result.result.sequence.map((entry) => `${entry.role}:${entry.phase}`)).toEqual([
      "librarian:nightly-ingest",
      "scholar:morning-plan",
      "nutritionist:daily-meals",
      "coach:daily-health",
      "scholar:evening-mastery"
    ]);
    expect(result.result.intendedActions.map((action) => action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Scholar study plan for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Coach health digest for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
  });

  test("agent-day live mode uses service-specific read bearers and board bearer", async () => {
    const stdout = createCapture();
    const calls: FetchCall[] = [];
    const result = (await handleKlCommand(
      [
        "agent-day",
        "--live",
        "--date",
        "2026-06-13",
        "--knowledge-loop-url",
        "http://knowledge.local",
        "--compass-health-url",
        "http://compass.local",
        "--board",
        "Holly Daily",
        "--multica-create-task-url",
        "http://multica.local/api/tasks",
        "--multica-add-comment-url",
        "http://multica.local/api/comments"
      ],
      {
        stdout: stdout.sink,
        env: {
          KL_AGENT_READ_BEARER_TOKEN: "fallback-read-secret",
          KL_AGENT_KNOWLEDGE_LOOP_BEARER_TOKEN: "knowledge-read-secret",
          KL_AGENT_COMPASS_HEALTH_BEARER_TOKEN: "compass-read-secret",
          KL_MULTICA_BEARER_TOKEN: "board-secret"
        },
        async fetch(input, init) {
          calls.push({ input, init });
          const url = String(input);
          if (url.startsWith("http://multica.local/")) {
            return jsonResponse({
              id: `item-${calls.filter((call) => String(call.input).startsWith("http://multica.local/")).length}`,
              url: `${url}/published`
            });
          }

          return jsonResponse(successfulApiBodyForUrl(url));
        }
      }
    )) as KlAgentDayLiveCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "agent-day",
      mode: "live",
      result: {
        mode: "live",
        date: "2026-06-13",
        multicaBoard: "Holly Daily",
        status: "completed",
        totals: {
          reads: 6,
          publishedActions: 5,
          blockers: 0,
          publishFailures: 0
        },
        llmCost: {
          estimatedUsd: 0,
          source: "not_configured",
          perAgent: [
            {
              role: "librarian",
              phase: "nightly-ingest",
              estimatedUsd: 0,
              source: "not_configured",
              detail: "No pi-harness cost snapshot client is configured for this run."
            },
            {
              role: "scholar",
              phase: "morning-plan",
              estimatedUsd: 0,
              source: "not_configured"
            },
            {
              role: "nutritionist",
              phase: "daily-meals",
              estimatedUsd: 0,
              source: "not_configured"
            },
            {
              role: "coach",
              phase: "daily-health",
              estimatedUsd: 0,
              source: "not_configured"
            },
            {
              role: "scholar",
              phase: "evening-mastery",
              estimatedUsd: 0,
              source: "not_configured"
            }
          ]
        }
      }
    });
    expect(result.result.publishedActions.map((publish) => publish.action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Scholar study plan for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Coach health digest for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
    expect(calls.map((call) => String(call.input))).toEqual([
      "http://knowledge.local/api/ingest/run?adapter=holly-vault",
      "http://multica.local/api/comments",
      "http://knowledge.local/api/plan/today",
      "http://multica.local/api/tasks",
      "http://compass.local/api/meal-plan/today?date=2026-06-13",
      "http://compass.local/api/meal-engine/procurement",
      "http://multica.local/api/tasks",
      "http://knowledge.local/api/health/coach-digest/generate",
      "http://multica.local/api/comments",
      "http://knowledge.local/api/mastery/summary",
      "http://multica.local/api/comments"
    ]);
    expect(calls.map(authorizationHeader)).toEqual([
      "Bearer knowledge-read-secret",
      "Bearer board-secret",
      "Bearer knowledge-read-secret",
      "Bearer board-secret",
      "Bearer compass-read-secret",
      "Bearer compass-read-secret",
      "Bearer board-secret",
      "Bearer knowledge-read-secret",
      "Bearer board-secret",
      "Bearer knowledge-read-secret",
      "Bearer board-secret"
    ]);
    expect(calls[5]?.init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer compass-read-secret"
      },
      body: JSON.stringify({ start_date: "2026-06-13" })
    });
    expect(calls[7]?.init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer knowledge-read-secret"
      },
      body: JSON.stringify({ date: "2026-06-13", offline: true })
    });
    for (const secret of ["knowledge-read-secret", "compass-read-secret", "fallback-read-secret", "board-secret"]) {
      expect(stdout.text()).not.toContain(secret);
    }
  });

  test("agent-day live mode falls back to the legacy read bearer when service bearers are unset", async () => {
    const calls: FetchCall[] = [];
    await handleKlCommand(
      [
        "agent-day",
        "--live",
        "--date",
        "2026-06-13",
        "--knowledge-loop-url",
        "http://knowledge.local",
        "--compass-health-url",
        "http://compass.local",
        "--multica-create-task-url",
        "http://multica.local/api/tasks",
        "--multica-add-comment-url",
        "http://multica.local/api/comments"
      ],
      {
        env: {
          KL_AGENT_READ_BEARER_TOKEN: "legacy-read-secret",
          KL_MULTICA_BEARER_TOKEN: "board-secret"
        },
        async fetch(input, init) {
          calls.push({ input, init });
          const url = String(input);
          if (url.startsWith("http://multica.local/")) {
            return jsonResponse({ id: `item-${calls.length}` });
          }

          return jsonResponse(successfulApiBodyForUrl(url));
        }
      }
    );

    expect(calls.map(authorizationHeader)).toEqual([
      "Bearer legacy-read-secret",
      "Bearer board-secret",
      "Bearer legacy-read-secret",
      "Bearer board-secret",
      "Bearer legacy-read-secret",
      "Bearer legacy-read-secret",
      "Bearer board-secret",
      "Bearer legacy-read-secret",
      "Bearer board-secret",
      "Bearer legacy-read-secret",
      "Bearer board-secret"
    ]);
  });

  test("agent-day live mode rejects conflicting service read bearers on the same origin", async () => {
    const calls: FetchCall[] = [];
    const runCommand = () =>
      handleKlCommand(
        [
          "agent-day",
          "--live",
          "--date",
          "2026-06-13",
          "--knowledge-loop-url",
          "http://local.reverse-proxy",
          "--compass-health-url",
          "http://local.reverse-proxy",
          "--multica-create-task-url",
          "http://multica.local/api/tasks",
          "--multica-add-comment-url",
          "http://multica.local/api/comments"
        ],
        {
          env: {
            KL_AGENT_READ_BEARER_TOKEN: "legacy-read-secret",
            KL_AGENT_KNOWLEDGE_LOOP_BEARER_TOKEN: "knowledge-read-secret",
            KL_AGENT_COMPASS_HEALTH_BEARER_TOKEN: "compass-read-secret",
            KL_MULTICA_BEARER_TOKEN: "board-secret"
          },
          async fetch(input, init) {
            calls.push({ input, init });
            return jsonResponse(successfulApiBodyForUrl(String(input)));
          }
        }
      );

    await expect(runCommand()).rejects.toThrow(/share origin .* but require different read bearer tokens/);
    await expect(runCommand()).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining("knowledge-read-secret") }));
    await expect(runCommand()).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining("compass-read-secret") }));
    expect(calls).toEqual([]);
  });

  test("agent-day live mode rejects same-origin service bearer conflicts against fallback", async () => {
    const calls: FetchCall[] = [];
    await expect(
      handleKlCommand(
        [
          "agent-day",
          "--live",
          "--date",
          "2026-06-13",
          "--knowledge-loop-url",
          "http://local.reverse-proxy",
          "--compass-health-url",
          "http://local.reverse-proxy",
          "--multica-create-task-url",
          "http://multica.local/api/tasks",
          "--multica-add-comment-url",
          "http://multica.local/api/comments"
        ],
        {
          env: {
            KL_AGENT_READ_BEARER_TOKEN: "legacy-read-secret",
            KL_AGENT_KNOWLEDGE_LOOP_BEARER_TOKEN: "knowledge-read-secret",
            KL_MULTICA_BEARER_TOKEN: "board-secret"
          },
          async fetch(input, init) {
            calls.push({ input, init });
            return jsonResponse(successfulApiBodyForUrl(String(input)));
          }
        }
      )
    ).rejects.toThrow(/share origin .* but require different read bearer tokens/);
    expect(calls).toEqual([]);
  });

  test("agent-day live mode rejects same-origin service bearer conflicts against no token", async () => {
    const calls: FetchCall[] = [];
    await expect(
      handleKlCommand(
        [
          "agent-day",
          "--live",
          "--date",
          "2026-06-13",
          "--knowledge-loop-url",
          "http://local.reverse-proxy",
          "--compass-health-url",
          "http://local.reverse-proxy",
          "--multica-create-task-url",
          "http://multica.local/api/tasks",
          "--multica-add-comment-url",
          "http://multica.local/api/comments"
        ],
        {
          env: {
            KL_AGENT_KNOWLEDGE_LOOP_BEARER_TOKEN: "knowledge-read-secret",
            KL_MULTICA_BEARER_TOKEN: "board-secret"
          },
          async fetch(input, init) {
            calls.push({ input, init });
            return jsonResponse(successfulApiBodyForUrl(String(input)));
          }
        }
      )
    ).rejects.toThrow(/share origin .* but require different read bearer tokens/);
    expect(calls).toEqual([]);
  });

  test("agent-day live mode is explicit and requires board publish endpoints", async () => {
    await expect(handleKlCommand(["agent-day", "--date", "2026-06-13"])).rejects.toThrow(
      /requires exactly one of --dry-run or --live/
    );
    await expect(handleKlCommand(["agent-day", "--dry-run", "--live", "--date", "2026-06-13"])).rejects.toThrow(
      /requires exactly one of --dry-run or --live/
    );
    await expect(handleKlCommand(["agent-day", "--live", "--date", "2026-06-13"])).rejects.toThrow(
      /requires exactly one --multica-create-task-url/
    );
    await expect(
      handleKlCommand([
        "agent-day",
        "--live",
        "--date",
        "2026-06-13",
        "--multica-create-task-url",
        "http://multica.local/api/tasks"
      ])
    ).rejects.toThrow(/requires exactly one --multica-add-comment-url/);
  });

  test("agent-day live mode rejects Multica endpoint URLs with credentials", async () => {
    const rawCredentialUrl = "https://user:real-secret@multica.local/api/tasks";
    const runCredentialEndpointCommand = () =>
      handleKlCommand(
        [
          "agent-day",
          "--live",
          "--date",
          "2026-06-13",
          "--multica-create-task-url",
          rawCredentialUrl,
          "--multica-add-comment-url",
          "http://multica.local/api/comments"
        ],
        {
          async fetch(input) {
            if (String(input).startsWith("https://user:")) {
              throw new Error("credential endpoint must be rejected before publish fetch");
            }

            return jsonResponse({ ok: true });
          }
        }
      );

    await expect(runCredentialEndpointCommand()).rejects.toThrow(/must not include URL credentials/);
    await expect(runCredentialEndpointCommand()).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(rawCredentialUrl)
      })
    );
    await expect(runCredentialEndpointCommand()).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("real-secret")
      })
    );
    await expect(runCredentialEndpointCommand()).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("user:")
      })
    );
  });

  test("agent-day command validates mode and options", async () => {
    await expect(handleKlCommand(["agent-day", "--dry-run", "--date", "2026-02-31"])).rejects.toThrow(
      /Invalid agent date/
    );
    await expect(
      handleKlCommand(["agent-day", "--dry-run", "--date", "2026-06-13", "--date", "2026-06-14"])
    ).rejects.toThrow(/requires exactly one --date/);
    await expect(handleKlCommand(["agent-day", "--dry-run", "--bogus", "1", "--date", "2026-06-13"])).rejects.toThrow(
      /Unknown option for agent-day: --bogus/
    );
  });

  test("agent-schedule dry-run prints deterministic scheduler intent without executing the day", async () => {
    const stdout = createCapture();
    const result = (await handleKlCommand(
      [
        "agent-schedule",
        "--dry-run",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--config",
        "config/agents.example.json",
        "--board",
        "Holly Daily"
      ],
      {
        stdout: stdout.sink,
        async fetch() {
          throw new Error("schedule dry-run must not fetch");
        }
      }
    )) as KlAgentScheduleDryRunCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "agent-schedule",
      mode: "dry-run",
      result: {
        timezone: "Asia/Shanghai",
        dailyAt: "07:30",
        now: "2026-06-14T07:30:00+08:00",
        due: true,
        date: "2026-06-14",
        window: {
          startsAt: "2026-06-14T07:30:00+08:00",
          endsBefore: "2026-06-15T07:30:00+08:00"
        },
        wouldRun: {
          command: "agent-day",
          mode: "dry-run",
          argv: [
            "agent-day",
            "--dry-run",
            "--date",
            "2026-06-14",
            "--config",
            "config/agents.example.json",
            "--board",
            "Holly Daily"
          ]
        },
        plan: {
          mode: "dry-run",
          date: "2026-06-14",
          multicaBoard: "Holly Daily",
          externalWrites: []
        }
      }
    });
  });

  test("agent-schedule live mode executes the existing live agent-day path when due", async () => {
    const stdout = createCapture();
    const calls: FetchCall[] = [];
    const result = (await handleKlCommand(
      [
        "agent-schedule",
        "--live",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--knowledge-loop-url",
        "http://knowledge.local",
        "--compass-health-url",
        "http://compass.local",
        "--board",
        "Holly Daily",
        "--multica-create-task-url",
        "http://multica.local/api/tasks",
        "--multica-add-comment-url",
        "http://multica.local/api/comments"
      ],
      {
        stdout: stdout.sink,
        env: {
          KL_AGENT_READ_BEARER_TOKEN: "fallback-read-secret",
          KL_AGENT_KNOWLEDGE_LOOP_BEARER_TOKEN: "knowledge-read-secret",
          KL_AGENT_COMPASS_HEALTH_BEARER_TOKEN: "compass-read-secret",
          KL_MULTICA_BEARER_TOKEN: "board-secret"
        },
        async fetch(input, init) {
          calls.push({ input, init });
          const url = String(input);
          if (url.startsWith("http://multica.local/")) {
            return jsonResponse({
              id: `item-${calls.filter((call) => String(call.input).startsWith("http://multica.local/")).length}`,
              url: `${url}/published`
            });
          }

          return jsonResponse(successfulApiBodyForUrl(url));
        }
      }
    )) as KlAgentScheduleLiveCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "agent-schedule",
      mode: "live",
      result: {
        status: "completed",
        schedule: {
          timezone: "Asia/Shanghai",
          dailyAt: "07:30",
          now: "2026-06-14T07:30:00+08:00",
          due: true,
          date: "2026-06-14",
          window: {
            startsAt: "2026-06-14T07:30:00+08:00",
            endsBefore: "2026-06-15T07:30:00+08:00"
          }
        },
        dayRunReport: {
          mode: "live",
          date: "2026-06-14",
          multicaBoard: "Holly Daily",
          status: "completed",
          totals: {
            reads: 6,
            publishedActions: 5,
            blockers: 0,
            publishFailures: 0
          }
        }
      }
    });
    if (!("dayRunReport" in result.result)) {
      throw new Error("Expected due schedule live result to include a day run report.");
    }
    expect(result.result.dayRunReport.publishedActions.map((publish) => publish.action.title)).toEqual([
      "Librarian ingest report for 2026-06-14",
      "Scholar study plan for 2026-06-14",
      "Nutrition plan for 2026-06-14",
      "Coach health digest for 2026-06-14",
      "Scholar mastery report for 2026-06-14"
    ]);
    expect(calls.map((call) => String(call.input))).toEqual([
      "http://knowledge.local/api/ingest/run?adapter=holly-vault",
      "http://multica.local/api/comments",
      "http://knowledge.local/api/plan/today",
      "http://multica.local/api/tasks",
      "http://compass.local/api/meal-plan/today?date=2026-06-14",
      "http://compass.local/api/meal-engine/procurement",
      "http://multica.local/api/tasks",
      "http://knowledge.local/api/health/coach-digest/generate",
      "http://multica.local/api/comments",
      "http://knowledge.local/api/mastery/summary",
      "http://multica.local/api/comments"
    ]);
    expect(calls.map(authorizationHeader)).toEqual([
      "Bearer knowledge-read-secret",
      "Bearer board-secret",
      "Bearer knowledge-read-secret",
      "Bearer board-secret",
      "Bearer compass-read-secret",
      "Bearer compass-read-secret",
      "Bearer board-secret",
      "Bearer knowledge-read-secret",
      "Bearer board-secret",
      "Bearer knowledge-read-secret",
      "Bearer board-secret"
    ]);
    for (const secret of ["knowledge-read-secret", "compass-read-secret", "fallback-read-secret", "board-secret"]) {
      expect(stdout.text()).not.toContain(secret);
    }
  });

  test("agent-schedule live mode skips without fetching when not due", async () => {
    const stdout = createCapture();
    const calls: FetchCall[] = [];
    const result = (await handleKlCommand(
      [
        "agent-schedule",
        "--live",
        "--now",
        "2026-06-14T07:29:59+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--knowledge-loop-url",
        "http://knowledge.local",
        "--compass-health-url",
        "http://compass.local",
        "--board",
        "Holly Daily"
      ],
      {
        stdout: stdout.sink,
        async fetch(input, init) {
          calls.push({ input, init });
          throw new Error("schedule live not-due path must not fetch");
        }
      }
    )) as KlAgentScheduleLiveCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "agent-schedule",
      mode: "live",
      result: {
        status: "skipped",
        reason: "not_due",
        schedule: {
          timezone: "Asia/Shanghai",
          dailyAt: "07:30",
          now: "2026-06-14T07:29:59+08:00",
          due: false,
          date: "2026-06-14",
          window: {
            startsAt: "2026-06-14T07:30:00+08:00",
            endsBefore: "2026-06-15T07:30:00+08:00"
          }
        }
      }
    });
    expect("dayRunReport" in result.result).toBe(false);
    expect(calls).toEqual([]);
  });

  test("agent-schedule command validates exactly one mode, live endpoints, and schedule inputs", async () => {
    await expect(handleKlCommand(["agent-schedule", "--now", "2026-06-14T07:30:00+08:00"])).rejects.toThrow(
      /requires exactly one of --dry-run or --live/
    );
    await expect(
      handleKlCommand([
        "agent-schedule",
        "--dry-run",
        "--live",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30"
      ])
    ).rejects.toThrow(/requires exactly one of --dry-run or --live/);
    await expect(
      handleKlCommand([
        "agent-schedule",
        "--live",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30"
      ])
    ).rejects.toThrow(/requires exactly one --multica-create-task-url/);
    await expect(
      handleKlCommand([
        "agent-schedule",
        "--live",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--multica-create-task-url",
        "http://multica.local/api/tasks"
      ])
    ).rejects.toThrow(/requires exactly one --multica-add-comment-url/);
    await expect(
      handleKlCommand([
        "agent-schedule",
        "--live",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--multica-create-task-url",
        "http://multica.local/api/tasks",
        "--multica-add-comment-url",
        "http://multica.local/api/comments",
        "--multica-add-comment-url",
        "http://multica.local/api/comments/2"
      ])
    ).rejects.toThrow(/requires exactly one --multica-add-comment-url/);
    await expect(
      handleKlCommand([
        "agent-schedule",
        "--dry-run",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--multica-create-task-url",
        "http://multica.local/api/tasks",
        "--multica-add-comment-url",
        "http://multica.local/api/comments"
      ])
    ).resolves.toMatchObject({
      command: "agent-schedule",
      mode: "dry-run"
    });
    await expect(
      handleKlCommand([
        "agent-schedule",
        "--dry-run",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "7:30"
      ])
    ).rejects.toThrow(/Invalid agent schedule --daily-at/);
    await expect(
      handleKlCommand([
        "agent-schedule",
        "--dry-run",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Mars/Base",
        "--daily-at",
        "07:30"
      ])
    ).rejects.toThrow(/Invalid agent schedule timezone/);
  });

  test("agent-failure-smoke dry-run simulates a visible blocker without fetching", async () => {
    const stdout = createCapture();
    const result = (await handleKlCommand(
      ["agent-failure-smoke", "--dry-run", "--date", "2026-06-13"],
      {
        stdout: stdout.sink,
        async fetch() {
          throw new Error("failure smoke dry-run must not fetch");
        },
        env: {
          KL_AGENT_READ_BEARER_TOKEN: "read-secret",
          KL_MULTICA_BEARER_TOKEN: "board-secret"
        }
      }
    )) as KlAgentFailureSmokeDryRunCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "agent-failure-smoke",
      mode: "dry-run",
      result: {
        mode: "offline-failure-smoke",
        date: "2026-06-13",
        status: "blocked",
        blockerPublished: true,
        failedEndpoint: {
          role: "scholar",
          phase: "morning-plan",
          method: "GET",
          url: "http://127.0.0.1:3000/api/plan/today"
        },
        totals: {
          reads: 5,
          publishedActions: 5,
          blockers: 2,
          publishFailures: 0
        },
        nonCompletionNotice:
          "This offline failure smoke does not kill real API services. It does not call Multica. It does not prove live blocker behavior. It does not close M2."
      }
    });
    expect(result.result.dayRunReport.entries.map((entry) => `${entry.role}:${entry.phase}:${entry.status}`)).toEqual([
      "librarian:nightly-ingest:completed",
      "scholar:morning-plan:blocked",
      "nutritionist:daily-meals:completed",
      "coach:daily-health:blocked",
      "scholar:evening-mastery:completed"
    ]);
    expect(result.result.blockerTitle).toBe("Agent blocked for 2026-06-13");
    expect(result.result.blockerSourceEndpoints).toEqual(["GET http://127.0.0.1:3000/api/plan/today"]);
    expect(JSON.stringify(result)).not.toContain("read-secret");
    expect(JSON.stringify(result)).not.toContain("board-secret");
  });

  test("agent-failure-smoke dry-run accepts a bounded endpoint selector", async () => {
    const result = (await handleKlCommand([
      "agent-failure-smoke",
      "--dry-run",
      "--date",
      "2026-06-13",
      "--role",
      "nutritionist",
      "--phase",
      "daily-meals",
      "--method",
      "GET",
      "--url-includes",
      "/api/meal-plan/today"
    ])) as KlAgentFailureSmokeDryRunCommandResult;

    expect(result.result.failedEndpoint).toMatchObject({
      role: "nutritionist",
      phase: "daily-meals",
      method: "GET",
      url: "http://127.0.0.1:8000/api/meal-plan/today?date=2026-06-13"
    });
    expect(result.result.dayRunReport.entries.map((entry) => `${entry.role}:${entry.phase}:${entry.status}`)).toEqual([
      "librarian:nightly-ingest:completed",
      "scholar:morning-plan:completed",
      "nutritionist:daily-meals:blocked",
      "coach:daily-health:blocked",
      "scholar:evening-mastery:completed"
    ]);
  });

  test("agent-failure-smoke command validates mode, selector, and method", async () => {
    await expect(handleKlCommand(["agent-failure-smoke", "--date", "2026-06-13"])).rejects.toThrow(
      /supports only --dry-run/
    );
    await expect(handleKlCommand(["agent-failure-smoke", "--live", "--date", "2026-06-13"])).rejects.toThrow(
      /Unknown option for agent-failure-smoke: --live/
    );
    await expect(
      handleKlCommand(["agent-failure-smoke", "--dry-run", "--date", "2026-06-13", "--method", "PATCH"])
    ).rejects.toThrow(/Expected GET or POST/);
    await expect(
      handleKlCommand([
        "agent-failure-smoke",
        "--dry-run",
        "--date",
        "2026-06-13",
        "--role",
        "scholar",
        "--phase",
        "morning-plan",
        "--method",
        "GET",
        "--url-includes",
        "real-secret"
      ])
    ).rejects.toThrow("No endpoint matched failure smoke selector.");
  });

  test("agent-harness-dependency dry-run reports pi-harness package and dirty checkout status", async () => {
    const stdout = createCapture();
    const harnessRoot = path.join(tmpdir(), "pi-harness-fixture");
    const result = (await handleKlCommand(
      ["agent-harness-dependency", "--dry-run", "--harness-path", harnessRoot],
      {
        stdout: stdout.sink,
        execFile(file, args) {
          expect(file).toBe("git");
          expect(args).toEqual(["--no-optional-locks", "-C", harnessRoot, "status", "--short"]);
          return "?? .env.local\n?? secrets/private-key.pem\n";
        },
        fileSystem: {
          readJson(filePath) {
            expect(filePath).toBe(path.join(harnessRoot, "package.json"));
            return piHarnessPackageJson();
          },
          isFile(filePath) {
            return [
              path.join(harnessRoot, "dist", "index.js"),
              path.join(harnessRoot, "dist", "index.d.ts"),
              path.join(harnessRoot, "dist", "cli", "index.js"),
              path.join(harnessRoot, "dist", "cli", "index.d.ts"),
              path.join(harnessRoot, "scripts", "new-agent.mjs")
            ].includes(filePath);
          }
        }
      }
    )) as KlAgentHarnessDependencyDryRunCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toMatchObject({
      command: "agent-harness-dependency",
      mode: "dry-run",
      result: {
        harnessPath: "EXTERNAL_PATH_REDACTED",
        status: "blocked",
        package: {
          name: "pi-harness",
          version: "0.1.0"
        },
        gitStatusEntryCount: 2
      }
    });
    expect(JSON.stringify(result)).not.toContain(harnessRoot);
    expect(JSON.stringify(result)).not.toContain(".env.local");
    expect(JSON.stringify(result)).not.toContain("private-key.pem");
  });

  test("agent-harness-dependency can verify linked pi-harness runtime imports", async () => {
    const harnessRoot = path.join(tmpdir(), "pi-harness-fixture");
    const importedSpecifiers: string[] = [];
    const result = (await handleKlCommand(
      ["agent-harness-dependency", "--dry-run", "--harness-path", harnessRoot, "--runtime-package", "pi-harness"],
      {
        execFile() {
          return "";
        },
        async importModule(specifier) {
          importedSpecifiers.push(specifier);
          if (specifier === "pi-harness") {
            return {
              CostTracker: class CostTracker {},
              createGenericHarness() {
                return {};
              }
            };
          }
          if (specifier === "pi-harness/cli") {
            return {
              parseCliArgs() {
                return {};
              },
              formatCliHelp() {
                return "help";
              }
            };
          }
          throw new Error(`unexpected import: ${specifier}`);
        },
        fileSystem: {
          readJson() {
            return piHarnessPackageJson();
          },
          isFile() {
            return true;
          }
        }
      }
    )) as KlAgentHarnessDependencyDryRunCommandResult;

    expect(importedSpecifiers).toEqual(["pi-harness", "pi-harness/cli"]);
    expect(result.result.status).toBe("ready_for_live_dependency_proof");
    expect(result.result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime_root_import", status: "passed" }),
        expect.objectContaining({ id: "runtime_cli_import", status: "passed" })
      ])
    );
    expect(result.result.runtimeImport).toMatchObject({
      packageName: "pi-harness",
      root: {
        specifier: "pi-harness",
        status: "passed"
      },
      cli: {
        specifier: "pi-harness/cli",
        status: "passed"
      }
    });
  });

  test("agent-harness-dependency blocks and redacts failed pi-harness runtime imports", async () => {
    const harnessRoot = path.join(tmpdir(), "pi-harness-fixture");
    const result = (await handleKlCommand(
      ["agent-harness-dependency", "--dry-run", "--harness-path", harnessRoot, "--runtime-package", "pi-harness"],
      {
        execFile() {
          return "";
        },
        async importModule(specifier) {
          throw new Error(`Cannot find ${specifier} from ${path.join(harnessRoot, "node_modules")}`);
        },
        fileSystem: {
          readJson() {
            return piHarnessPackageJson();
          },
          isFile() {
            return true;
          }
        }
      }
    )) as KlAgentHarnessDependencyDryRunCommandResult;

    expect(result.result.status).toBe("blocked");
    expect(result.result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime_root_import", status: "blocked" }),
        expect.objectContaining({ id: "runtime_cli_import", status: "blocked" })
      ])
    );
    expect(JSON.stringify(result)).not.toContain(harnessRoot);
    expect(JSON.stringify(result)).toContain("pi-harness runtime import failed");
  });

  test("agent-harness-dependency blocks when an expected dist path is not a file", async () => {
    const harnessRoot = path.join(tmpdir(), "pi-harness-fixture");
    const result = (await handleKlCommand(
      ["agent-harness-dependency", "--dry-run", "--harness-path", harnessRoot],
      {
        execFile() {
          return "";
        },
        fileSystem: {
          readJson() {
            return piHarnessPackageJson();
          },
          isFile(filePath) {
            return filePath !== path.join(harnessRoot, "dist", "index.js");
          }
        }
      }
    )) as KlAgentHarnessDependencyDryRunCommandResult;

    expect(result.result.status).toBe("blocked");
    expect(result.result.checks).toContainEqual(
      expect.objectContaining({
        id: "dist_main_exists",
        status: "blocked"
      })
    );
  });

  test("agent-harness-dependency redacts harness path from package and git failures", async () => {
    const harnessRoot = path.join(tmpdir(), "secret-harness-root");

    await expect(
      handleKlCommand(["agent-harness-dependency", "--dry-run", "--harness-path", harnessRoot], {
        fileSystem: {
          readJson() {
            throw new Error(`ENOENT: no such file, open '${path.join(harnessRoot, "package.json")}'`);
          },
          isFile() {
            return false;
          }
        }
      })
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(harnessRoot)
      })
    );

    await expect(
      handleKlCommand(["agent-harness-dependency", "--dry-run", "--harness-path", harnessRoot], {
        execFile() {
          throw new Error(`git --no-optional-locks -C ${harnessRoot} status --short failed`);
        },
        fileSystem: {
          readJson() {
            return piHarnessPackageJson();
          },
          isFile() {
            return true;
          }
        }
      })
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(harnessRoot)
      })
    );
  });

  test("agent-harness-dependency command validates dry-run mode and harness path", async () => {
    await expect(handleKlCommand(["agent-harness-dependency", "--harness-path", "G:\\pi-harness"])).rejects.toThrow(
      /supports only --dry-run/
    );
    await expect(handleKlCommand(["agent-harness-dependency", "--dry-run"])).rejects.toThrow(
      /requires exactly one --harness-path/
    );
    await expect(
      handleKlCommand(["agent-harness-dependency", "--dry-run", "--harness-path", "G:\\pi-harness", "--live", "1"])
    ).rejects.toThrow(/Unknown option for agent-harness-dependency: --live/);
    await expect(
      handleKlCommand([
        "agent-harness-dependency",
        "--dry-run",
        "--harness-path",
        "G:\\pi-harness",
        "--runtime-package",
        "file:///G:/pi-harness/dist/index.js"
      ])
    ).rejects.toThrow(/only supports --runtime-package pi-harness/);
  });

  test("agent-live-smoke dry-run validates a current manifest without fetching", async () => {
    const manifestPath = "config/multica/live-smoke.valid.test.json";
    writeValidLiveSmokeManifestFixture(manifestPath, ["2026-06-14", "2026-06-15"]);
    const stdout = createCapture();

    try {
      const result = (await handleKlCommand(
        [
          "agent-live-smoke",
          "--dry-run",
          "--manifest",
          manifestPath,
          "--date",
          "2026-06-14",
          "--board",
          "daily-plan"
        ],
        {
          stdout: stdout.sink,
          async fetch() {
            throw new Error("live-smoke dry-run must not fetch");
          }
        }
      )) as KlAgentLiveSmokeDryRunCommandResult;

      expect(parseCapturedJson(stdout)).toEqual(result);
      expect(result).toMatchObject({
        command: "agent-live-smoke",
        mode: "dry-run",
        result: {
          manifestPath,
          date: "2026-06-14",
          valid: true,
          validation: {
            errors: [],
            summary: {
              contractStatus: "inferred_live_smoke_pending",
              requiredDays: 2,
              expectedItems: [
                "librarian:nightly-ingest:add_comment",
                "scholar:morning-plan:create_task",
                "nutritionist:daily-meals:create_task",
                "coach:daily-health:add_comment",
                "scholar:evening-mastery:add_comment"
              ]
            }
          },
          nonCompletionNotice:
            "This manifest is an offline live-smoke contract. It does not execute Multica, install a scheduler, prove live board posting, or close M2.",
          plan: {
            mode: "dry-run",
            date: "2026-06-14",
            multicaBoard: "daily-plan",
            externalWrites: []
          }
        }
      });
    } finally {
      unlinkIfExists(manifestPath);
    }
  });

  test("agent-live-smoke dry-run returns validation errors for an invalid manifest", async () => {
    const manifestPath = path.join("config", "multica", "live-smoke.invalid.test.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          contractStatus: "inferred_live_smoke_pending",
          requiredConsecutiveDays: 2,
          boardPublishConfig: "config/multica/board-publish.example.json",
          smokeMode: "offline-contract-only",
          evidence: {
            days: [
              { date: "2026-06-14", items: [] },
              { date: "2026-06-15", items: [] }
            ]
          },
          nonCompletionNotice: "This invalid fixture does not execute Multica. Bearer real-token"
        },
        null,
        2
      ),
      "utf8"
    );

    try {
      const result = (await handleKlCommand([
        "agent-live-smoke",
        "--dry-run",
        "--manifest",
        manifestPath,
        "--date",
        "2026-06-14"
      ])) as KlAgentLiveSmokeDryRunCommandResult;

      expect(result.result.valid).toBe(false);
      expect(result.result.validation.summary).toBeUndefined();
      expect(result.result.validation.errors).toEqual(
        expect.arrayContaining([
          "live smoke manifest day 2026-06-14 is missing librarian:nightly-ingest:add_comment.",
          "live smoke manifest day 2026-06-14 is missing scholar:morning-plan:create_task.",
          "live smoke manifest must not contain secret-like value at nonCompletionNotice."
        ])
      );
      expect(result.result.nonCompletionNotice).toBe(
        "This offline validation does not execute Multica, install a scheduler, prove live board posting, or close M2."
      );
    } finally {
      unlinkIfExists(manifestPath);
    }
  });

  test("agent-live-smoke command validates dry-run mode, date, and manifest path", async () => {
    await expect(
      handleKlCommand([
        "agent-live-smoke",
        "--manifest",
        "config/multica/live-smoke.example.json",
        "--date",
        "2026-06-14"
      ])
    ).rejects.toThrow(/supports only --dry-run/);
    await expect(
      handleKlCommand([
        "agent-live-smoke",
        "--live",
        "--manifest",
        "config/multica/live-smoke.example.json",
        "--date",
        "2026-06-14"
      ])
    ).rejects.toThrow(/Unknown option for agent-live-smoke: --live/);
    await expect(
      handleKlCommand([
        "agent-live-smoke",
        "--dry-run",
        "--manifest",
        "config/multica/live-smoke.example.json",
        "--date",
        "2026-02-31"
      ])
    ).rejects.toThrow(/Invalid agent date/);
    await expect(
      handleKlCommand([
        "agent-live-smoke",
        "--dry-run",
        "--manifest",
        path.join("..", "outside.json"),
        "--date",
        "2026-06-14"
      ])
    ).rejects.toThrow(/must stay inside the knowledge-loop checkout/);
  });

  test("agent-preflight dry-run combines schedule intent and live-smoke validation without fetching", async () => {
    const manifestPath = "config/multica/live-smoke.valid.test.json";
    writeValidLiveSmokeManifestFixture(manifestPath, ["2026-06-14", "2026-06-15"]);
    const stdout = createCapture();

    try {
      const result = (await handleKlCommand(
        [
          "agent-preflight",
          "--dry-run",
          "--now",
          "2026-06-14T07:30:00+08:00",
          "--timezone",
          "Asia/Shanghai",
          "--daily-at",
          "07:30",
          "--manifest",
          manifestPath,
          "--config",
          "config/agents.example.json"
        ],
        {
          stdout: stdout.sink,
          async fetch() {
            throw new Error("preflight dry-run must not fetch");
          }
        }
      )) as KlAgentPreflightDryRunCommandResult;

      expect(parseCapturedJson(stdout)).toEqual(result);
      expect(result).toMatchObject({
        command: "agent-preflight",
        mode: "dry-run",
        result: {
          status: "ready_for_live_smoke",
          date: "2026-06-14",
          nonCompletionNotice:
            "This preflight is offline-only. It does not execute Multica, install a scheduler, prove live board posting, prove two hands-free days, or close M2.",
          schedule: {
            due: true,
            date: "2026-06-14",
            wouldRun: {
              command: "agent-day",
              mode: "dry-run"
            },
            plan: {
              mode: "dry-run",
              externalWrites: []
            }
          },
          liveSmoke: {
            manifestPath,
            valid: true,
            manifestEvidenceDays: ["2026-06-14", "2026-06-15"],
            validation: {
              errors: []
            }
          },
          boardConfig: {
            configPath: "config/multica/board-publish.example.json",
            valid: true,
            validation: {
              errors: [],
              summary: {
                contractStatus: "inferred_live_smoke_pending",
                apiBaseUrl: "http://127.0.0.1:8080",
                appBaseUrl: "http://127.0.0.1:3000",
                workspaceSlug: "daily-plan",
                actions: ["create_task", "add_comment"],
                commentRequiresIssueId: true
              }
            }
          }
        }
      });
      expect(result.result.offlineChecks).toEqual([
        expect.objectContaining({ id: "scheduler_due", status: "passed" }),
        expect.objectContaining({ id: "live_smoke_manifest_valid", status: "passed" }),
        expect.objectContaining({ id: "manifest_starts_on_schedule_date", status: "passed" }),
        expect.objectContaining({ id: "board_publish_config_valid", status: "passed" })
      ]);
      expect(result.result.requiredLiveProofs.map((proof) => proof.id)).toEqual([
        "multica_self_host_verified",
        "pi_harness_dependency_clean",
        "two_consecutive_hands_free_board_days",
        "failure_blocker_board_comment",
        "evening_mastery_delta_matches_api",
        "daily_cost_visible"
      ]);
      expect(result.result.requiredLiveProofs.every((proof) => proof.status === "not_verified_offline")).toBe(true);
    } finally {
      unlinkIfExists(manifestPath);
    }
  });

  test("agent-preflight blocks when the manifest first day differs from the scheduler date", async () => {
    const manifestPath = "config/multica/live-smoke.valid.test.json";
    writeValidLiveSmokeManifestFixture(manifestPath, ["2026-06-14", "2026-06-15"]);

    try {
      const result = (await handleKlCommand([
        "agent-preflight",
        "--dry-run",
        "--now",
        "2026-06-15T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--manifest",
        manifestPath,
        "--config",
        "config/agents.example.json"
      ])) as KlAgentPreflightDryRunCommandResult;

      expect(result.result.status).toBe("blocked");
      expect(result.result.date).toBe("2026-06-15");
      expect(result.result.liveSmoke.valid).toBe(true);
      expect(result.result.offlineChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "manifest_starts_on_schedule_date",
            status: "blocked",
            detail: "Manifest first evidence day 2026-06-14 must match scheduler date 2026-06-15."
          })
        ])
      );
    } finally {
      unlinkIfExists(manifestPath);
    }
  });

  test("agent-preflight blocks for an invalid board publish config without fetching", async () => {
    const manifestPath = "config/multica/live-smoke.valid.test.json";
    const boardConfigPath = path.join("config", "multica", "board-publish.preflight-invalid.test.json");
    writeValidLiveSmokeManifestFixture(manifestPath, ["2026-06-14", "2026-06-15"]);
    writeFileSync(
      boardConfigPath,
      JSON.stringify(
        {
          contractStatus: "inferred_live_smoke_pending",
          apiBaseUrl: "http://127.0.0.1:8080",
          appBaseUrl: "http://127.0.0.1:3000",
          workspace: {
            slug: "daily-plan",
            id: ""
          },
          actions: {
            create_task: {
              method: "GET",
              endpointUrl: "http://127.0.0.1:8080/api/issues",
              payload: {
                title: "$action.title"
              }
            },
            add_comment: {
              method: "POST",
              endpointTemplate: "http://127.0.0.1:8080/api/issues/comments?token=real-token",
              payload: {
                content: "$action.body"
              }
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    try {
      const result = (await handleKlCommand(
        [
          "agent-preflight",
          "--dry-run",
          "--now",
          "2026-06-14T07:30:00+08:00",
          "--timezone",
          "Asia/Shanghai",
          "--daily-at",
          "07:30",
          "--manifest",
          manifestPath,
          "--board-config",
          boardConfigPath,
          "--config",
          "config/agents.example.json"
        ],
        {
          async fetch() {
            throw new Error("preflight dry-run must not fetch");
          }
        }
      )) as KlAgentPreflightDryRunCommandResult;

      expect(result.result.status).toBe("blocked");
      expect(result.result.boardConfig.configPath).toBe("config/multica/board-publish.preflight-invalid.test.json");
      expect(result.result.boardConfig.valid).toBe(false);
      expect(result.result.boardConfig.validation.summary).toBeUndefined();
      expect(result.result.boardConfig.validation.errors).toEqual(
        expect.arrayContaining([
          "board publish config actions.create_task.method must be POST.",
          "board publish config actions.create_task.payload.description must be $action.body.",
          "board publish config must not contain secret-like value at actions.add_comment.endpointTemplate.",
          "board publish config actions.add_comment.endpointTemplate must include {issueId}."
        ])
      );
      expect(result.result.offlineChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "board_publish_config_valid",
            status: "blocked",
            detail: "Board publish config has errors."
          })
        ])
      );
    } finally {
      unlinkIfExists(manifestPath);
      unlinkIfExists(boardConfigPath);
    }
  });

  test("agent-preflight returns load errors for malformed board publish config JSON", async () => {
    const manifestPath = "config/multica/live-smoke.valid.test.json";
    const boardConfigPath = path.join("config", "multica", "board-publish.preflight-malformed.test.json");
    writeValidLiveSmokeManifestFixture(manifestPath, ["2026-06-14", "2026-06-15"]);
    writeFileSync(boardConfigPath, "{\n  \"contractStatus\":\n", "utf8");

    try {
      const result = (await handleKlCommand([
        "agent-preflight",
        "--dry-run",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--manifest",
        manifestPath,
        "--board-config",
        boardConfigPath
      ])) as KlAgentPreflightDryRunCommandResult;

      expect(result.result.status).toBe("blocked");
      expect(result.result.boardConfig.valid).toBe(false);
      expect(result.result.boardConfig.validation.summary).toBeUndefined();
      expect(result.result.boardConfig.validation.errors).toEqual(expect.arrayContaining([expect.stringContaining("JSON")]));
      expect(result.result.offlineChecks).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "board_publish_config_valid", status: "blocked" })])
      );
    } finally {
      unlinkIfExists(manifestPath);
      unlinkIfExists(boardConfigPath);
    }
  });

  test("agent-preflight command validates dry-run mode and rejects live mode", async () => {
    await expect(
      handleKlCommand([
        "agent-preflight",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--manifest",
        "config/multica/live-smoke.example.json"
      ])
    ).rejects.toThrow(/supports only --dry-run/);
    await expect(
      handleKlCommand([
        "agent-preflight",
        "--live",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--manifest",
        "config/multica/live-smoke.example.json"
      ])
    ).rejects.toThrow(/Unknown option for agent-preflight: --live/);
    await expect(
      handleKlCommand([
        "agent-preflight",
        "--dry-run",
        "--now",
        "2026-06-14T07:30:00+08:00",
        "--timezone",
        "Asia/Shanghai",
        "--daily-at",
        "07:30",
        "--manifest",
        "config/multica/live-smoke.example.json",
        "--board-config",
        path.join("..", "board-publish.json")
      ])
    ).rejects.toThrow(/must stay inside the knowledge-loop checkout/);
  });

  test("agent-board-config dry-run validates the checked-in Multica publish contract without fetching", async () => {
    const stdout = createCapture();
    const result = (await handleKlCommand(
      ["agent-board-config", "--dry-run", "--config", "config/multica/board-publish.example.json"],
      {
        stdout: stdout.sink,
        async fetch() {
          throw new Error("board config dry-run must not fetch");
        }
      }
    )) as KlAgentBoardConfigDryRunCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toEqual({
      command: "agent-board-config",
      mode: "dry-run",
      result: {
        configPath: "config/multica/board-publish.example.json",
        valid: true,
        validation: {
          errors: [],
          warnings: [
            "board publish config is an offline candidate; agent-day --live currently uses explicit endpoint flags and built-in Multica issue/comment payloads rather than reading this config file."
          ],
          summary: {
            contractStatus: "inferred_live_smoke_pending",
            apiBaseUrl: "http://127.0.0.1:8080",
            appBaseUrl: "http://127.0.0.1:3000",
            workspaceSlug: "daily-plan",
            actions: ["create_task", "add_comment"],
            commentRequiresIssueId: true
          }
        },
        nonCompletionNotice:
          "This board publish config validation is offline-only. It does not call Multica, prove the board contract, prove live posting, or close M2."
      }
    });
  });

  test("agent-board-config dry-run returns validation errors for an unsafe config", async () => {
    const configPath = path.join("config", "multica", "board-publish.invalid.test.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          contractStatus: "inferred_live_smoke_pending",
          apiBaseUrl: "http://127.0.0.1:8080",
          appBaseUrl: "http://127.0.0.1:3000",
          workspace: {
            slug: "daily-plan",
            id: ""
          },
          actions: {
            create_task: {
              method: "GET",
              endpointUrl: "http://127.0.0.1:8080/api/issues",
              payload: {
                title: "$action.title"
              }
            },
            add_comment: {
              method: "POST",
              endpointTemplate: "http://127.0.0.1:8080/api/issues/comments?token=real-token",
              payload: {
                content: "$action.body"
              }
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    try {
      const result = (await handleKlCommand([
        "agent-board-config",
        "--dry-run",
        "--config",
        configPath
      ])) as KlAgentBoardConfigDryRunCommandResult;

      expect(result.result.valid).toBe(false);
      expect(result.result.validation.summary).toBeUndefined();
      expect(result.result.validation.errors).toEqual(
        expect.arrayContaining([
          "board publish config actions.create_task.method must be POST.",
          "board publish config actions.create_task.payload.description must be $action.body.",
          "board publish config must not contain secret-like value at actions.add_comment.endpointTemplate.",
          "board publish config actions.add_comment.endpointTemplate must include {issueId}."
        ])
      );
    } finally {
      unlinkIfExists(configPath);
    }
  });

  test("agent-board-config command validates dry-run mode and config path", async () => {
    await expect(
      handleKlCommand(["agent-board-config", "--config", "config/multica/board-publish.example.json"])
    ).rejects.toThrow(/supports only --dry-run/);
    await expect(
      handleKlCommand([
        "agent-board-config",
        "--live",
        "--config",
        "config/multica/board-publish.example.json"
      ])
    ).rejects.toThrow(/Unknown option for agent-board-config: --live/);
    await expect(
      handleKlCommand(["agent-board-config", "--dry-run", "--config", path.join("..", "board.json")])
    ).rejects.toThrow(/must stay inside the knowledge-loop checkout/);
  });

  test("agent-board-config command returns validation errors for duplicate JSON keys", async () => {
    const configPath = path.join("config", "multica", "board-publish.duplicate.test.json");
    writeFileSync(
      configPath,
      [
        "{",
        '  "contractStatus": "inferred_live_smoke_pending",',
        '  "contractStatus": "inferred_live_smoke_pending"',
        "}"
      ].join("\n"),
      "utf8"
    );

    try {
      const result = (await handleKlCommand([
        "agent-board-config",
        "--dry-run",
        "--config",
        configPath
      ])) as KlAgentBoardConfigDryRunCommandResult;

      expect(result.result.valid).toBe(false);
      expect(result.result.validation.summary).toBeUndefined();
      expect(result.result.validation.errors).toEqual(["Duplicate JSON key contractStatus."]);
      expect(result.result.validation.warnings).toEqual([
        "board publish config is an offline candidate; agent-day --live currently uses explicit endpoint flags and built-in Multica issue/comment payloads rather than reading this config file."
      ]);
    } finally {
      unlinkIfExists(configPath);
    }
  });

  test("agent-board-config command catches nested duplicate JSON keys", async () => {
    const configPath = path.join("config", "multica", "board-publish.nested-duplicate.test.json");
    writeFileSync(
      configPath,
      [
        "{",
        '  "contractStatus": "inferred_live_smoke_pending",',
        '  "apiBaseUrl": "http://127.0.0.1:8080",',
        '  "appBaseUrl": "http://127.0.0.1:3000",',
        '  "workspace": {',
        '    "slug": "daily-plan",',
        '    "slug": "duplicate-plan",',
        '    "id": ""',
        "  },",
        '  "actions": {}',
        "}"
      ].join("\n"),
      "utf8"
    );

    try {
      const result = (await handleKlCommand([
        "agent-board-config",
        "--dry-run",
        "--config",
        configPath
      ])) as KlAgentBoardConfigDryRunCommandResult;

      expect(result.result.valid).toBe(false);
      expect(result.result.validation.summary).toBeUndefined();
      expect(result.result.validation.errors).toEqual(["Duplicate JSON key slug."]);
    } finally {
      unlinkIfExists(configPath);
    }
  });

  test("agent-board-config command ignores JSON-looking text inside string values", async () => {
    const configPath = path.join("config", "multica", "board-publish.string-literal.test.json");
    writeFileSync(
      configPath,
      [
        "{",
        '  "contractStatus": "inferred_live_smoke_pending",',
        '  "apiBaseUrl": "http://127.0.0.1:8080",',
        '  "appBaseUrl": "http://127.0.0.1:3000",',
        '  "workspace": {',
        '    "slug": "daily-plan",',
        '    "id": ""',
        "  },",
        '  "actions": {',
        '    "create_task": {',
        '      "method": "POST",',
        '      "endpointUrl": "http://127.0.0.1:8080/api/issues",',
        '      "payload": {',
        '        "title": "$action.title",',
        '        "description": "$action.body"',
        "      }",
        "    },",
        '    "add_comment": {',
        '      "method": "POST",',
        '      "endpointTemplate": "http://127.0.0.1:8080/api/issues/{issueId}/comments",',
        '      "payload": {',
        '        "content": "$action.body"',
        "      }",
        "    }",
        "  },",
        '  "notes": "literal braces { } colon : and escaped quote \\"apiBaseUrl\\": inside a string"',
        "}"
      ].join("\n"),
      "utf8"
    );

    try {
      const result = (await handleKlCommand([
        "agent-board-config",
        "--dry-run",
        "--config",
        configPath
      ])) as KlAgentBoardConfigDryRunCommandResult;

      expect(result.result.valid).toBe(true);
      expect(result.result.validation.errors).toEqual([]);
      expect(result.result.validation.summary?.workspaceSlug).toBe("daily-plan");
    } finally {
      unlinkIfExists(configPath);
    }
  });

  test("agent-board-config command treats unicode-escaped key duplicates as duplicates", async () => {
    const configPath = path.join("config", "multica", "board-publish.unicode-duplicate.test.json");
    writeFileSync(
      configPath,
      [
        "{",
        '  "contractStatus": "inferred_live_smoke_pending",',
        '  "apiBaseUrl": "http://127.0.0.1:8080",',
        '  "\\u0061piBaseUrl": "http://127.0.0.1:8081",',
        '  "appBaseUrl": "http://127.0.0.1:3000"',
        "}"
      ].join("\n"),
      "utf8"
    );

    try {
      const result = (await handleKlCommand([
        "agent-board-config",
        "--dry-run",
        "--config",
        configPath
      ])) as KlAgentBoardConfigDryRunCommandResult;

      expect(result.result.valid).toBe(false);
      expect(result.result.validation.summary).toBeUndefined();
      expect(result.result.validation.errors).toEqual(["Duplicate JSON key apiBaseUrl."]);
    } finally {
      unlinkIfExists(configPath);
    }
  });

  test("agent-board-config command returns validation errors for malformed JSON", async () => {
    const configPath = path.join("config", "multica", "board-publish.malformed.test.json");
    writeFileSync(configPath, "{\n  \"contractStatus\":\n", "utf8");

    try {
      const result = (await handleKlCommand([
        "agent-board-config",
        "--dry-run",
        "--config",
        configPath
      ])) as KlAgentBoardConfigDryRunCommandResult;

      expect(result.result.valid).toBe(false);
      expect(result.result.validation.summary).toBeUndefined();
      expect(result.result.validation.errors).toEqual(expect.arrayContaining([expect.stringContaining("JSON")]));
      expect(result.result.validation.warnings).toEqual([
        "board publish config is an offline candidate; agent-day --live currently uses explicit endpoint flags and built-in Multica issue/comment payloads rather than reading this config file."
      ]);
    } finally {
      unlinkIfExists(configPath);
    }
  });

  test("agent-board-evidence dry-run validates observed board evidence without fetching", async () => {
    const stdout = createCapture();
    const result = (await handleKlCommand(
      [
        "agent-board-evidence",
        "--dry-run",
        "--evidence",
        "config/multica/board-day-evidence.example.json",
        "--manifest",
        "config/multica/live-smoke.example.json"
      ],
      {
        stdout: stdout.sink,
        async fetch() {
          throw new Error("board evidence dry-run must not fetch");
        }
      }
    )) as KlAgentBoardEvidenceDryRunCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toEqual({
      command: "agent-board-evidence",
      mode: "dry-run",
      result: {
        evidencePath: "config/multica/board-day-evidence.example.json",
        manifestPath: "config/multica/live-smoke.example.json",
        status: "observed_evidence_valid",
        valid: true,
        validation: {
          errors: [],
          warnings: [
            "board-day evidence is offline observed evidence only; it does not prove hands-free execution or close M2."
          ],
          summary: {
            contractStatus: "observed_live_smoke_pending_verification",
            evidenceMode: "offline-observation-only",
            requiredDays: 2,
            observedItems: [
              "2026-06-14 librarian:nightly-ingest:add_comment",
              "2026-06-14 scholar:morning-plan:create_task",
              "2026-06-14 nutritionist:daily-meals:create_task",
              "2026-06-14 coach:daily-health:add_comment",
              "2026-06-14 scholar:evening-mastery:add_comment",
              "2026-06-15 librarian:nightly-ingest:add_comment",
              "2026-06-15 scholar:morning-plan:create_task",
              "2026-06-15 nutritionist:daily-meals:create_task",
              "2026-06-15 coach:daily-health:add_comment",
              "2026-06-15 scholar:evening-mastery:add_comment"
            ]
          }
        },
        nonCompletionNotice:
          "This board-day evidence validation is offline-only. It does not call Multica, prove hands-free execution, prove live posting, or close M2."
      }
    });
  });

  test("agent-board-evidence dry-run returns validation errors for unsafe evidence", async () => {
    const evidencePath = path.join("config", "multica", "board-day-evidence.invalid.test.json");
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          contractStatus: "verified",
          evidenceMode: "offline-observation-only",
          status: "completed",
          m2Closed: true,
          days: []
        },
        null,
        2
      ),
      "utf8"
    );

    try {
      const result = (await handleKlCommand([
        "agent-board-evidence",
        "--dry-run",
        "--evidence",
        evidencePath,
        "--manifest",
        "config/multica/live-smoke.example.json"
      ])) as KlAgentBoardEvidenceDryRunCommandResult;

      expect(result.result.valid).toBe(false);
      expect(result.result.status).toBe("blocked");
      expect(result.result.validation.summary).toBeUndefined();
      expect(result.result.validation.errors).toEqual(
        expect.arrayContaining([
          "board-day evidence contractStatus must remain observed_live_smoke_pending_verification.",
          "board-day evidence must not contain fake closure status at status.",
          "board-day evidence must not contain fake closure field m2Closed.",
          "board-day evidence days length must match manifest requiredConsecutiveDays."
        ])
      );
    } finally {
      unlinkIfExists(evidencePath);
    }
  });

  test("agent-board-evidence command validates dry-run mode and checkout paths", async () => {
    await expect(
      handleKlCommand([
        "agent-board-evidence",
        "--evidence",
        "config/multica/board-day-evidence.example.json",
        "--manifest",
        "config/multica/live-smoke.example.json"
      ])
    ).rejects.toThrow(/supports only --dry-run/);
    await expect(
      handleKlCommand([
        "agent-board-evidence",
        "--live",
        "--evidence",
        "config/multica/board-day-evidence.example.json",
        "--manifest",
        "config/multica/live-smoke.example.json"
      ])
    ).rejects.toThrow(/Unknown option for agent-board-evidence: --live/);
    await expect(
      handleKlCommand([
        "agent-board-evidence",
        "--dry-run",
        "--evidence",
        path.join("..", "board-day-evidence.json"),
        "--manifest",
        "config/multica/live-smoke.example.json"
      ])
    ).rejects.toThrow(/must stay inside the knowledge-loop checkout/);
    await expect(
      handleKlCommand([
        "agent-board-evidence",
        "--dry-run",
        "--evidence",
        "config/multica/board-day-evidence.example.json",
        "--manifest",
        path.join("..", "live-smoke.json")
      ])
    ).rejects.toThrow(/must stay inside the knowledge-loop checkout/);
  });

  test("agent-board-evidence command returns validation errors for malformed evidence JSON", async () => {
    const evidencePath = path.join("config", "multica", "board-day-evidence.malformed.test.json");
    writeFileSync(evidencePath, "{\n  \"contractStatus\":\n", "utf8");

    try {
      const result = (await handleKlCommand([
        "agent-board-evidence",
        "--dry-run",
        "--evidence",
        evidencePath,
        "--manifest",
        "config/multica/live-smoke.example.json"
      ])) as KlAgentBoardEvidenceDryRunCommandResult;

      expect(result.result.valid).toBe(false);
      expect(result.result.status).toBe("blocked");
      expect(result.result.validation.summary).toBeUndefined();
      expect(result.result.validation.errors).toEqual(expect.arrayContaining([expect.stringContaining("JSON")]));
      expect(result.result.validation.warnings).toEqual([
        "board-day evidence is offline observed evidence only; it does not prove hands-free execution or close M2."
      ]);
    } finally {
      unlinkIfExists(evidencePath);
    }
  });

  test("agent-board-evidence command returns validation errors for malformed manifest JSON", async () => {
    const manifestPath = path.join("config", "multica", "live-smoke.malformed.test.json");
    writeFileSync(manifestPath, "{\n  \"requiredConsecutiveDays\":\n", "utf8");

    try {
      const result = (await handleKlCommand([
        "agent-board-evidence",
        "--dry-run",
        "--evidence",
        "config/multica/board-day-evidence.example.json",
        "--manifest",
        manifestPath
      ])) as KlAgentBoardEvidenceDryRunCommandResult;

      expect(result.result.valid).toBe(false);
      expect(result.result.status).toBe("blocked");
      expect(result.result.validation.summary).toBeUndefined();
      expect(result.result.validation.errors).toEqual(expect.arrayContaining([expect.stringContaining("JSON")]));
      expect(result.result.validation.warnings).toEqual([
        "board-day evidence is offline observed evidence only; it does not prove hands-free execution or close M2."
      ]);
    } finally {
      unlinkIfExists(manifestPath);
    }
  });

  test("with API key env vars deleted, CLI mock persistent flow runs ingest, plan, quiz, teachback, diagnose, and trace against one DB", async () => {
    const envNames = ["DEEPSEEK_API_KEY", "QWEN_API_KEY", "OPENAI_API_KEY", "LLM_PROVIDER"] as const;
    const savedEnv = new Map<(typeof envNames)[number], string | undefined>(
      envNames.map((name) => [name, process.env[name]])
    );
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-full-flow-vault-"));
    const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-full-flow-db-"));
    const dbPath = path.join(dbDir, "knowledge-loop.db");
    const sourcePath = path.join(vaultDir, "Learning.md");
    const conceptSlug = "retrieval-practice";

    writeFileSync(
      sourcePath,
      [
        "---",
        "title: Mock Full Flow",
        "---",
        "# Retrieval Practice",
        "Retrieval practice uses active recall before review to strengthen durable memory."
      ].join("\n"),
      "utf8"
    );

    try {
      for (const name of envNames) {
        delete process.env[name];
      }

      const ingest = await handleKlCommand(["ingest", "--vault", vaultDir, "--db", dbPath]);
      expect(ingest.command).toBe("ingest");
      expect(ingest.mode).toBe("mock-persistent");
      if (ingest.command !== "ingest" || ingest.mode !== "mock-persistent") {
        throw new Error("Expected persistent ingest result.");
      }
      expect(ingest.result).toMatchObject({
        sourcesSeen: 1,
        sourcesProcessed: 1,
        sourcesFailed: 0,
        chunksCreated: 1,
        conceptsCreated: 1,
        pagesCreated: 1
      });

      const plan = await handleKlCommand(["plan", "--date", "2026-06-13", "--db", dbPath]);
      expect(plan.command).toBe("plan");
      expect(plan.mode).toBe("mock-persistent");
      if (plan.command !== "plan" || plan.mode !== "mock-persistent") {
        throw new Error("Expected persistent plan result.");
      }
      expect(plan.result).toMatchObject({
        date: "2026-06-13",
        status: "planned"
      });
      expect(plan.result.queue.map((activity) => activity.conceptSlug)).toContain(conceptSlug);

      const quiz = (await handleKlCommand([
        "quiz",
        "--db",
        dbPath,
        "--item",
        "What does retrieval practice use before review?",
        "--concept",
        conceptSlug,
        "--answer",
        "active recall",
        "--response",
        "active recall"
      ])) as KlPersistentQuizCommandResult;
      expect(quiz.command).toBe("quiz");
      expect(quiz.mode).toBe("mock-persistent");
      expect(quiz.result).toMatchObject({
        conceptSlug,
        verdict: "correct",
        gradingMethod: "exact"
      });
      expect(quiz.result.itemId).toBeGreaterThan(0);
      expect(quiz.result.attemptId).toBeGreaterThan(0);

      const teachback = (await handleKlCommand([
        "teachback",
        "--db",
        dbPath,
        "--concept",
        conceptSlug,
        "--transcript",
        "Retrieval practice uses active recall before review to strengthen durable memory."
      ])) as KlPersistentTeachbackCommandResult;
      expect(teachback.command).toBe("teachback");
      expect(teachback.mode).toBe("mock-persistent");
      expect(teachback.result).toMatchObject({
        conceptSlug,
        gradingMethod: "rubric"
      });
      expect(teachback.result.rubricReport.score).toBeGreaterThan(0);
      expect(teachback.result.rubricReport.gaps).toEqual(expect.any(Array));
      expect(teachback.result.teachbackId).toBeGreaterThan(0);

      const diagnose = await handleKlCommand(["diagnose", "--db", dbPath]);
      expect(diagnose.command).toBe("diagnose");
      expect(diagnose.mode).toBe("mock-persistent");
      if (diagnose.command !== "diagnose" || diagnose.mode !== "mock-persistent") {
        throw new Error("Expected persistent diagnose result.");
      }
      expect(diagnose.result.weakSpots.map((weakSpot) => weakSpot.conceptSlug)).toContain(conceptSlug);
      expect(diagnose.result.summary.weakSpotCount).toBeGreaterThan(0);

      const trace = (await handleKlCommand(["trace", "--db", dbPath, "--run", ingest.result.runId])) as TraceCliCommandResult;
      expect(trace.command).toBe("trace");
      expect(trace.mode).toBe("mock-persistent");
      expect(trace.result.runId).toBe(ingest.result.runId);
      expect(trace.result.eventCount).toBe(ingest.result.traceEvents.length);
      expect(trace.result.events.map((event) => event.stage)).toEqual(
        expect.arrayContaining(["chunk", "extract", "merge", "link", "page-gen"])
      );
      expect(trace.result.events.every((event) => event.runId === ingest.result.runId)).toBe(true);

      expect(countRows(dbPath, "sources")).toBe(1);
      expect(countRows(dbPath, "chunks")).toBe(1);
      expect(countRows(dbPath, "concepts")).toBe(1);
      expect(countRows(dbPath, "pages")).toBe(1);
      expect(countRows(dbPath, "study_plans")).toBe(1);
      expect(countRows(dbPath, "items")).toBe(1);
      expect(countRows(dbPath, "attempts")).toBe(1);
      expect(countRows(dbPath, "teachbacks")).toBe(1);
      expect(countRows(dbPath, "mastery")).toBe(1);
      expect(countRows(dbPath, "trace_events")).toBe(
        ingest.result.traceEvents.length +
          plan.result.traceEvents.length +
          quiz.result.traceEvents.length +
          teachback.result.traceEvents.length +
          diagnose.result.traceEvents.length
      );
    } finally {
      for (const [name, value] of savedEnv) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }

      unlinkIfExists(sourcePath);
      unlinkIfExists(dbPath);
      unlinkIfExists(`${dbPath}-journal`);
      unlinkIfExists(`${dbPath}-wal`);
      unlinkIfExists(`${dbPath}-shm`);
      rmdirIfEmpty(vaultDir);
      rmdirIfEmpty(dbDir);
    }
  });

  test("trace returns persisted events for a run in insertion order and writes JSON", async () => {
    const dbPath = createTraceDb();
    const stdout = createCapture();

    const result = (await handleKlCommand(["trace", "--db", dbPath, "--run", "run-alpha"], {
      stdout: stdout.sink
    })) as unknown as TraceCliCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result).toEqual({
      command: "trace",
      mode: "mock-persistent",
      result: {
        runId: "run-alpha",
        eventCount: 2,
        events: [
          {
            id: 1,
            runId: "run-alpha",
            stage: "chunk",
            level: "info",
            message: "Chunked source",
            timestamp: "2026-06-12T00:00:00.000Z",
            data: { source: "alpha.md", chunks: 2 }
          },
          {
            id: 3,
            runId: "run-alpha",
            stage: "plan",
            level: "info",
            message: "Created study plan",
            timestamp: "2026-06-12T00:02:00.000Z",
            data: ["learn", "quiz"]
          }
        ]
      }
    });
  });

  test("trace filters persisted events by stage", async () => {
    const dbPath = createTraceDb();

    const result = (await handleKlCommand([
      "trace",
      "--db",
      dbPath,
      "--run",
      "run-alpha",
      "--stage",
      "plan"
    ])) as unknown as TraceCliCommandResult;

    expect(result).toEqual({
      command: "trace",
      mode: "mock-persistent",
      result: {
        runId: "run-alpha",
        stage: "plan",
        eventCount: 1,
        events: [
          {
            id: 3,
            runId: "run-alpha",
            stage: "plan",
            level: "info",
            message: "Created study plan",
            timestamp: "2026-06-12T00:02:00.000Z",
            data: ["learn", "quiz"]
          }
        ]
      }
    });
  });

  test("trace returns an empty event list when a run has no persisted events", async () => {
    const dbPath = createTraceDb();

    const result = (await handleKlCommand(["trace", "--db", dbPath, "--run", "run-missing"])) as unknown as TraceCliCommandResult;

    expect(result).toEqual({
      command: "trace",
      mode: "mock-persistent",
      result: {
        runId: "run-missing",
        eventCount: 0,
        events: []
      }
    });
  });

  test("trace is read-only from the CLI", async () => {
    const dbPath = createTraceDb();
    const beforeRows = countMutableRows(dbPath);

    await handleKlCommand(["trace", "--db", dbPath, "--run", "run-alpha", "--stage", "chunk"]);

    expect(countMutableRows(dbPath)).toEqual(beforeRows);
  });

  test("trace rejects a missing db without creating it", async () => {
    const missingDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-trace-missing-")), "missing.db");

    await expect(handleKlCommand(["trace", "--db", missingDbPath, "--run", "run-alpha"])).rejects.toThrow();

    expect(existsSync(missingDbPath)).toBe(false);
  });

  test("trace rejects an unmigrated db without writing schema", async () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-trace-unmigrated-"));
    const dbPath = path.join(dbDir, "empty.db");
    const db = new Database(dbPath);
    db.close();

    await expect(handleKlCommand(["trace", "--db", dbPath, "--run", "run-alpha"])).rejects.toThrow();

    expect(listTableNames(dbPath)).toEqual([]);
  });

  test("trace rejects missing and duplicate db run and stage options", async () => {
    const dbPath = createTraceDb();
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(handleKlCommand(["trace", "--run", "run-alpha"])).rejects.toThrow(/requires exactly one --db/);
    await expect(handleKlCommand(["trace", "--db"])).rejects.toThrow(/Option --db for trace requires a value/);
    await expect(
      handleKlCommand(["trace", "--db", dbPath, "--db", otherDbPath, "--run", "run-alpha"])
    ).rejects.toThrow(/requires exactly one --db/);
    await expect(handleKlCommand(["trace", "--db", dbPath])).rejects.toThrow(/requires exactly one --run/);
    await expect(handleKlCommand(["trace", "--db", dbPath, "--run"])).rejects.toThrow(
      /Option --run for trace requires a value/
    );
    await expect(
      handleKlCommand(["trace", "--db", dbPath, "--run", "run-alpha", "--run", "run-beta"])
    ).rejects.toThrow(/requires exactly one --run/);
    await expect(handleKlCommand(["trace", "--db", dbPath, "--run", "run-alpha", "--stage"])).rejects.toThrow(
      /Option --stage for trace requires a value/
    );
    await expect(
      handleKlCommand([
        "trace",
        "--db",
        dbPath,
        "--run",
        "run-alpha",
        "--stage",
        "chunk",
        "--stage",
        "plan"
      ])
    ).rejects.toThrow(/requires exactly one --stage/);
  });

  test("trace rejects blank run and invalid stage before opening db", async () => {
    const missingDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-trace-invalid-")), "missing.db");

    await expect(handleKlCommand(["trace", "--db", missingDbPath, "--run", ""])).rejects.toThrow(
      /requires a non-empty --run/
    );
    await expect(
      handleKlCommand(["trace", "--db", missingDbPath, "--run", "run-alpha", "--stage", "invalid-stage"])
    ).rejects.toThrow(/Invalid --stage value "invalid-stage".*chunk, extract, merge, link, page-gen, plan, grade, diagnose/);

    expect(existsSync(missingDbPath)).toBe(false);
  });

  test("trace rejects unknown options", async () => {
    const dbPath = createTraceDb();

    await expect(handleKlCommand(["trace", "--db", dbPath, "--run", "run-alpha", "--bogus", "1"])).rejects.toThrow(
      /Unknown option for trace: --bogus/
    );
  });

  test("ingest reads a markdown vault in mock mode and writes JSON", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    writeFileSync(
      path.join(vaultDir, "Learning.md"),
      [
        "---",
        "title: Learning Loop",
        "---",
        "# Alpha Concept",
        "Alpha concept body links to [[Beta Concept]]."
      ].join("\n"),
      "utf8"
    );
    const stdout = createCapture();

    const result = await handleKlCommand(["ingest", "--vault", vaultDir], { stdout: stdout.sink });

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("ingest");
    expect(result.mode).toBe("mock");
    if (result.command !== "ingest" || result.mode !== "mock") {
      throw new Error("Expected mock ingest result.");
    }
    expect(result.result.sources).toHaveLength(1);
    expect(result.result.sources[0]?.title).toBe("Learning Loop");
    expect(result.result.concepts.map((concept) => concept.slug)).toContain("alpha-concept");
  });

  test("ingest with a db persists sources and becomes a no-op on the second run", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    const dbPath = path.join(vaultDir, "knowledge-loop.db");
    writeFileSync(
      path.join(vaultDir, "Learning.md"),
      [
        "---",
        "title: Persistent Learning",
        "---",
        "# Alpha Concept",
        "Alpha concept body links to [[Beta Concept]].",
        "# Beta Concept",
        "Beta concept body."
      ].join("\n"),
      "utf8"
    );
    const firstStdout = createCapture();
    const secondStdout = createCapture();

    const first = await handleKlCommand(["ingest", "--vault", vaultDir, "--db", dbPath], { stdout: firstStdout.sink });
    const second = await handleKlCommand(["ingest", "--vault", vaultDir, "--db", dbPath], { stdout: secondStdout.sink });

    expect(parseCapturedJson(firstStdout)).toEqual(first);
    expect(parseCapturedJson(secondStdout)).toEqual(second);
    expect(first.command).toBe("ingest");
    expect(second.command).toBe("ingest");
    expect(first.mode).toBe("mock-persistent");
    expect(second.mode).toBe("mock-persistent");
    if (
      first.command !== "ingest" ||
      first.mode !== "mock-persistent" ||
      second.command !== "ingest" ||
      second.mode !== "mock-persistent"
    ) {
      throw new Error("Expected persistent ingest results.");
    }
    expect(first.result).toMatchObject({
      sourcesSeen: 1,
      sourcesProcessed: 1,
      sourcesSkipped: 0,
      chunksCreated: 2,
      conceptsCreated: 2,
      pagesCreated: 2
    });
    expect(second.result).toMatchObject({
      sourcesSeen: 1,
      sourcesProcessed: 0,
      sourcesSkipped: 1,
      chunksCreated: 0,
      conceptsCreated: 0,
      pagesCreated: 0
    });
    expect(countRows(dbPath, "sources")).toBe(1);
    expect(countRows(dbPath, "chunks")).toBe(2);
    expect(countRows(dbPath, "concepts")).toBe(2);
    expect(countRows(dbPath, "pages")).toBe(2);
  });

  test("ingest with a db persists returned trace events for trace queries", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    const dbPath = path.join(vaultDir, "knowledge-loop.db");
    writeFileSync(
      path.join(vaultDir, "Learning.md"),
      [
        "---",
        "title: Persistent Trace Learning",
        "---",
        "# Alpha Concept",
        "Alpha concept body links to [[Beta Concept]].",
        "# Beta Concept",
        "Beta concept body."
      ].join("\n"),
      "utf8"
    );

    const result = await handleKlCommand(["ingest", "--vault", vaultDir, "--db", dbPath]);

    expect(result.command).toBe("ingest");
    expect(result.mode).toBe("mock-persistent");
    if (result.command !== "ingest" || result.mode !== "mock-persistent") {
      throw new Error("Expected persistent ingest result.");
    }

    const trace = await expectPersistedTraceEventsMatchResult(dbPath, result.result.runId, result.result.traceEvents);
    expect(trace.result.events.map((event) => event.stage)).toEqual(
      expect.arrayContaining(["chunk", "extract", "merge", "link", "page-gen"])
    );
    expect(trace.result.events.map((event) => event.message)).toEqual(
      result.result.traceEvents.map((event) => event.message)
    );
  });

  test("ingest requires exactly one db path when db is provided", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    const firstDbPath = path.join(vaultDir, "first.db");
    const secondDbPath = path.join(vaultDir, "second.db");
    writeFileSync(path.join(vaultDir, "Learning.md"), "# Alpha Concept\nAlpha concept body.", "utf8");

    await expect(
      handleKlCommand(["ingest", "--vault", vaultDir, "--db", firstDbPath, "--db", secondDbPath])
    ).rejects.toThrow(/requires exactly one --db/);
  });

  test("ingest requires a db value when db is provided", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    writeFileSync(path.join(vaultDir, "Learning.md"), "# Alpha Concept\nAlpha concept body.", "utf8");

    await expect(handleKlCommand(["ingest", "--vault", vaultDir, "--db"])).rejects.toThrow(
      /Option --db for ingest requires a value/
    );
  });

  test("ingest rejects unknown options", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    writeFileSync(path.join(vaultDir, "Learning.md"), "# Alpha Concept\nAlpha concept body.", "utf8");

    await expect(handleKlCommand(["ingest", "--vault", vaultDir, "--bogus", "1"])).rejects.toThrow(
      /Unknown option for ingest: --bogus/
    );
  });

  test("plan returns deterministic mock output for a date and repeated concepts", async () => {
    const argv = [
      "plan",
      "--date",
      "2026-06-12",
      "--concept",
      "alpha:Alpha Concept",
      "--concept",
      "beta:Beta Concept"
    ];
    const firstStdout = createCapture();
    const secondStdout = createCapture();

    const first = await handleKlCommand(argv, { stdout: firstStdout.sink });
    const second = await handleKlCommand(argv, { stdout: secondStdout.sink });

    expect(parseCapturedJson(firstStdout)).toEqual(first);
    expect(first).toEqual(second);
    expect(first.command).toBe("plan");
    expect(second.command).toBe("plan");
    expect(first.mode).toBe("mock");
    expect(second.mode).toBe("mock");
    if (first.command !== "plan" || second.command !== "plan") {
      throw new Error("Expected plan results.");
    }
    expect(first.result.date).toBe("2026-06-12");
    expect(first.result.queue).toHaveLength(6);
    expect(first.result.queue.map((activity) => activity.id)).toEqual(second.result.queue.map((activity) => activity.id));
  });

  test("plan with a db creates a persistent study plan and writes JSON", async () => {
    const dbPath = createPlanDb([
      { slug: "algebra", name: "Algebra", status: "generated" },
      { slug: "geometry", name: "Geometry", status: "reviewed" }
    ]);
    const stdout = createCapture();

    const result = await handleKlCommand(["plan", "--date", "2026-06-12", "--db", dbPath], { stdout: stdout.sink });

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("plan");
    expect(result.mode).toBe("mock-persistent");
    if (result.command !== "plan" || result.mode !== "mock-persistent") {
      throw new Error("Expected persistent plan result.");
    }
    expect(result.result.date).toBe("2026-06-12");
    expect(result.result.status).toBe("planned");
    expect(result.result.queue).toHaveLength(6);
    expect(result.result.queue.map((activity) => activity.conceptSlug)).toEqual(
      expect.arrayContaining(["algebra", "geometry"])
    );
    expect(countRows(dbPath, "study_plans")).toBe(1);
  });

  test("plan with a db persists returned trace events for trace queries", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);

    const result = await handleKlCommand(["plan", "--date", "2026-06-12", "--db", dbPath]);

    expect(result.command).toBe("plan");
    expect(result.mode).toBe("mock-persistent");
    if (result.command !== "plan" || result.mode !== "mock-persistent") {
      throw new Error("Expected persistent plan result.");
    }

    const trace = await expectPersistedTraceEventsMatchResult(dbPath, result.result.runId, result.result.traceEvents);
    expect(trace.result.events).toHaveLength(1);
    expect(trace.result.events[0]).toMatchObject({
      runId: result.result.runId,
      stage: "plan",
      message: "Persistent daily plan created"
    });
  });

  test("plan with a db reuses the existing study plan for the same date", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);

    const first = await handleKlCommand(["plan", "--date", "2026-06-13", "--db", dbPath]);
    const second = await handleKlCommand(["plan", "--date", "2026-06-13", "--db", dbPath]);

    expect(first.command).toBe("plan");
    expect(second.command).toBe("plan");
    if (
      first.command !== "plan" ||
      first.mode !== "mock-persistent" ||
      second.command !== "plan" ||
      second.mode !== "mock-persistent"
    ) {
      throw new Error("Expected persistent plan results.");
    }
    expect(second.result.queue).toEqual(first.result.queue);
    expect(countRows(dbPath, "study_plans")).toBe(1);
  });

  test("repeated plan with a db uses distinct trace runs without aggregating events", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);

    const first = await handleKlCommand(["plan", "--date", "2026-06-14", "--db", dbPath]);
    const second = await handleKlCommand(["plan", "--date", "2026-06-14", "--db", dbPath]);

    expect(first.command).toBe("plan");
    expect(second.command).toBe("plan");
    if (
      first.command !== "plan" ||
      first.mode !== "mock-persistent" ||
      second.command !== "plan" ||
      second.mode !== "mock-persistent"
    ) {
      throw new Error("Expected persistent plan results.");
    }

    expect(second.result.runId).not.toBe(first.result.runId);

    const firstTrace = await expectPersistedTraceEventsMatchResult(dbPath, first.result.runId, first.result.traceEvents);
    const secondTrace = await expectPersistedTraceEventsMatchResult(dbPath, second.result.runId, second.result.traceEvents);

    expect(firstTrace.result.events).toHaveLength(first.result.traceEvents.length);
    expect(secondTrace.result.events).toHaveLength(second.result.traceEvents.length);
    expect(firstTrace.result.events.every((event) => event.runId === first.result.runId)).toBe(true);
    expect(secondTrace.result.events.every((event) => event.runId === second.result.runId)).toBe(true);
  });

  test("plan rejects db and manual concepts together", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);

    await expect(
      handleKlCommand(["plan", "--date", "2026-06-12", "--db", dbPath, "--concept", "algebra:Algebra"])
    ).rejects.toThrow(/cannot combine --db and --concept/);
  });

  test("plan requires exactly one db path when db is provided", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(
      handleKlCommand(["plan", "--date", "2026-06-12", "--db", dbPath, "--db", otherDbPath])
    ).rejects.toThrow(/requires exactly one --db/);
  });

  test("plan requires a db value when db is provided", async () => {
    await expect(handleKlCommand(["plan", "--date", "2026-06-12", "--db"])).rejects.toThrow(
      /Option --db for plan requires a value/
    );
  });

  test("plan rejects unknown options after db options", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);

    await expect(
      handleKlCommand(["plan", "--date", "2026-06-12", "--db", dbPath, "--bogus", "1"])
    ).rejects.toThrow(/Unknown option for plan: --bogus/);
  });

  test("plan requires at least one concept", async () => {
    await expect(handleKlCommand(["plan", "--date", "2026-06-12"])).rejects.toThrow(
      /requires at least one --concept/
    );
  });

  test("review due-list mode lists due reviews and writes JSON", async () => {
    const dbPath = createReviewDb([
      { slug: "beta", name: "Beta", fsrsState: { card: "beta" }, dueAt: "2026-06-13T23:00:00.000Z" },
      { slug: "gamma", name: "Gamma", status: "reviewed", fsrsState: { card: "gamma" }, dueAt: "2026-06-14T10:00:00.000Z" },
      { slug: "alpha", name: "Alpha", fsrsState: { card: "alpha" }, dueAt: "2026-06-14T10:00:00.000Z" },
      { slug: "future", name: "Future", fsrsState: { card: "future" }, dueAt: "2026-06-15T00:00:00.000Z" }
    ]);
    const stdout = createCapture();

    const result = (await handleKlCommand(["review", "--db", dbPath, "--due", "2026-06-14"], {
      stdout: stdout.sink
    })) as KlPersistentReviewCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("review");
    expect(result.mode).toBe("mock-persistent");
    if (!("reviews" in result.result)) {
      throw new Error("Expected review due-list result.");
    }
    const dueResult = result.result;
    expect(dueResult).toEqual({
      target: "2026-06-14",
      reviews: [
        expect.objectContaining({
          conceptSlug: "beta",
          conceptName: "Beta",
          dueAt: "2026-06-13T23:00:00.000Z",
          fsrsState: { card: "beta" }
        }),
        expect.objectContaining({
          conceptSlug: "alpha",
          conceptName: "Alpha",
          dueAt: "2026-06-14T10:00:00.000Z",
          fsrsState: { card: "alpha" }
        }),
        expect.objectContaining({
          conceptSlug: "gamma",
          conceptName: "Gamma",
          dueAt: "2026-06-14T10:00:00.000Z",
          fsrsState: { card: "gamma" }
        })
      ]
    });
    expect(dueResult.reviews.every((review) => Number.isSafeInteger(review.id))).toBe(true);
    expect(dueResult.reviews.every((review) => Number.isSafeInteger(review.conceptId))).toBe(true);
  });

  test("review due-list mode honors limit", async () => {
    const dbPath = createReviewDb([
      { slug: "alpha", name: "Alpha", fsrsState: { card: "alpha" }, dueAt: "2026-06-14T01:00:00.000Z" },
      { slug: "beta", name: "Beta", fsrsState: { card: "beta" }, dueAt: "2026-06-14T02:00:00.000Z" }
    ]);

    const result = (await handleKlCommand([
      "review",
      "--db",
      dbPath,
      "--due",
      "2026-06-14",
      "--limit",
      "1"
    ])) as KlPersistentReviewCommandResult;

    expect(result.command).toBe("review");
    expect(result.mode).toBe("mock-persistent");
    if (!("reviews" in result.result)) {
      throw new Error("Expected review due-list result.");
    }
    expect(result.result.reviews.map((review) => review.conceptSlug)).toEqual(["alpha"]);
  });

  test("review due-list rejects an unmigrated existing db without writing schema", async () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-review-unmigrated-"));
    const dbPath = path.join(dbDir, "empty.db");
    const db = new Database(dbPath);
    db.close();

    await expect(handleKlCommand(["review", "--db", dbPath, "--due", "2026-06-14"])).rejects.toThrow();

    expect(listTableNames(dbPath)).toEqual([]);
  });

  test("review attempt mode records attempt updates review mastery and persists trace events", async () => {
    const dbPath = createReviewDb([
      {
        slug: "spacing-effect",
        name: "Spacing Effect",
        fsrsState: { reviewCount: 2, lapses: 1, opaque: { scheduler: "mock" } },
        dueAt: "2026-06-13T00:00:00.000Z"
      }
    ]);
    const stdout = createCapture();

    const result = (await handleKlCommand(
      [
        "review",
        "--db",
        dbPath,
        "--concept",
        "spacing-effect",
        "--rating",
        "good",
        "--reviewed-at",
        "2026-06-14T08:00:00+08:00"
      ],
      { stdout: stdout.sink }
    )) as KlPersistentReviewCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("review");
    expect(result.mode).toBe("mock-persistent");
    if (!("traceEvents" in result.result)) {
      throw new Error("Expected review attempt result.");
    }
    const attemptResult = result.result;
    expect(attemptResult).toMatchObject({
      conceptSlug: "spacing-effect",
      rating: "good",
      reviewedAt: "2026-06-14T00:00:00.000Z",
      previousDueAt: "2026-06-13T00:00:00.000Z",
      nextDueAt: "2026-06-18T00:00:00.000Z",
      masteryDelta: 0.06,
      mastery: {
        score: 0.06,
        confidence: 0.8,
        attemptsN: 1,
        lastSeenAt: "2026-06-14T00:00:00.000Z"
      }
    });
    expect(attemptResult.fsrsState).toEqual({
      reviewCount: 3,
      lapses: 1,
      opaque: { scheduler: "mock" },
      lastRating: "good",
      lastReviewedAt: "2026-06-14T00:00:00.000Z",
      nextIntervalDays: 4
    });
    expect(readReviewRows(dbPath)).toMatchObject([
      {
        conceptSlug: "spacing-effect",
        dueAt: "2026-06-18T00:00:00.000Z",
        fsrsState: attemptResult.fsrsState
      }
    ]);
    const trace = await expectPersistedTraceEventsMatchResult(dbPath, attemptResult.runId, attemptResult.traceEvents);
    expect(trace.result.events.map((event) => event.message)).toEqual(["Review attempt recorded", "Mastery updated"]);
  });

  test("review rejects missing duplicate mixed and invalid options", async () => {
    const dbPath = createReviewDb([
      { slug: "spacing-effect", name: "Spacing Effect", fsrsState: {}, dueAt: "2026-06-13T00:00:00.000Z" }
    ]);
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(handleKlCommand(["review", "--due", "2026-06-14"])).rejects.toThrow(/requires exactly one --db/);
    await expect(
      handleKlCommand(["review", "--db", dbPath, "--db", otherDbPath, "--due", "2026-06-14"])
    ).rejects.toThrow(/requires exactly one --db/);
    await expect(
      handleKlCommand(["review", "--db", dbPath, "--due", "2026-06-14", "--due", "2026-06-15"])
    ).rejects.toThrow(/requires exactly one --due/);
    await expect(
      handleKlCommand(["review", "--db", dbPath, "--due", "2026-06-14", "--limit", "1", "--limit", "2"])
    ).rejects.toThrow(/requires exactly one --limit/);
    await expect(handleKlCommand(["review", "--db", dbPath])).rejects.toThrow(
      /requires either due-list mode \(--due\) or attempt mode \(--concept, --rating, and --reviewed-at\)/
    );
    await expect(
      handleKlCommand(["review", "--db", dbPath, "--due", "2026-06-14", "--concept", "spacing-effect"])
    ).rejects.toThrow(/cannot mix due-list options with attempt options/);
    await expect(
      handleKlCommand(["review", "--db", dbPath, "--concept", "spacing-effect", "--rating", "good"])
    ).rejects.toThrow(/attempt mode requires exactly one --concept, exactly one --rating, and exactly one --reviewed-at/);
    await expect(
      handleKlCommand([
        "review",
        "--db",
        dbPath,
        "--concept",
        "spacing-effect",
        "--concept",
        "active-recall",
        "--rating",
        "good",
        "--reviewed-at",
        "2026-06-14T00:00:00.000Z"
      ])
    ).rejects.toThrow(/attempt mode requires exactly one --concept/);
    await expect(
      handleKlCommand([
        "review",
        "--db",
        dbPath,
        "--concept",
        "spacing-effect",
        "--rating",
        "good",
        "--rating",
        "easy",
        "--reviewed-at",
        "2026-06-14T00:00:00.000Z"
      ])
    ).rejects.toThrow(/attempt mode requires exactly one --concept, exactly one --rating/);
    await expect(
      handleKlCommand([
        "review",
        "--db",
        dbPath,
        "--concept",
        "spacing-effect",
        "--rating",
        "good",
        "--reviewed-at",
        "2026-06-14T00:00:00.000Z",
        "--reviewed-at",
        "2026-06-15T00:00:00.000Z"
      ])
    ).rejects.toThrow(/exactly one --reviewed-at/);
    await expect(
      handleKlCommand([
        "review",
        "--db",
        dbPath,
        "--concept",
        "spacing-effect",
        "--rating",
        "later",
        "--reviewed-at",
        "2026-06-14T00:00:00.000Z"
      ])
    ).rejects.toThrow(/Invalid --rating value "later"/);
    await expect(
      handleKlCommand(["review", "--db", dbPath, "--due", "2026-06-14", "--limit", "0"])
    ).rejects.toThrow(/Invalid --limit value "0"/);
    await expect(handleKlCommand(["review", "--db", dbPath, "--due", "2026-06-14", "--bogus", "1"])).rejects.toThrow(
      /Unknown option for review: --bogus/
    );
  });

  test("review rejects invalid rating and limit before creating a missing db", async () => {
    const invalidRatingDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-review-invalid-rating-")), "missing.db");
    const invalidLimitDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-review-invalid-limit-")), "missing.db");

    await expect(
      handleKlCommand([
        "review",
        "--db",
        invalidRatingDbPath,
        "--concept",
        "spacing-effect",
        "--rating",
        "later",
        "--reviewed-at",
        "2026-06-14T00:00:00.000Z"
      ])
    ).rejects.toThrow(/Invalid --rating value "later"/);
    await expect(
      handleKlCommand(["review", "--db", invalidLimitDbPath, "--due", "2026-06-14", "--limit", "1.5"])
    ).rejects.toThrow(/Invalid --limit value "1.5"/);

    expect(existsSync(invalidRatingDbPath)).toBe(false);
    expect(existsSync(invalidLimitDbPath)).toBe(false);
  });

  test("quiz grades exact answers and returns verdict plus mastery delta", async () => {
    const stdout = createCapture();

    const result = await handleKlCommand(
      [
        "quiz",
        "--item",
        "capital-france",
        "--concept",
        "paris",
        "--answer",
        "Paris",
        "--response",
        " paris "
      ],
      { stdout: stdout.sink }
    );

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("quiz");
    expect(result.mode).toBe("mock");
    if (result.command !== "quiz") {
      throw new Error("Expected quiz result.");
    }
    expect(result.result.itemId).toBe("capital-france");
    expect(result.result.conceptSlug).toBe("paris");
    expect(result.result.verdict).toBe("correct");
    expect(result.result.masteryDelta).toBe(0.1);
  });

  test("quiz rejects blank exact answers in mock mode", async () => {
    await expect(
      handleKlCommand([
        "quiz",
        "--item",
        "blank-answer",
        "--concept",
        "validation",
        "--answer",
        "",
        "--response",
        ""
      ])
    ).rejects.toThrow(/non-empty answer/);
  });

  test("quiz with a db persists a correct answer attempt and returns persistent mode", async () => {
    const dbPath = createPlanDb([{ slug: "mitochondria", name: "Mitochondria", status: "generated" }]);
    const stdout = createCapture();

    const result = (await handleKlCommand(
      [
        "quiz",
        "--db",
        dbPath,
        "--item",
        "Which organelle is the powerhouse of the cell?",
        "--concept",
        "mitochondria",
        "--answer",
        "mitochondria",
        "--response",
        " mitochondria "
      ],
      { stdout: stdout.sink }
    )) as KlPersistentQuizCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("quiz");
    expect(result.mode).toBe("mock-persistent");
    expect(result.result).toMatchObject({
      conceptSlug: "mitochondria",
      verdict: "correct",
      masteryDelta: 0.1,
      mastery: {
        score: 0.1,
        attemptsN: 1
      }
    });
    expect(result.result.itemId).toBeGreaterThan(0);
    expect(result.result.attemptId).toBeGreaterThan(0);
    expect(readQuizRows(dbPath)).toMatchObject({
      items: [
        {
          id: result.result.itemId,
          conceptSlug: "mitochondria",
          statement: "Which organelle is the powerhouse of the cell?",
          answerSpec: { type: "exact", answers: ["mitochondria"] }
        }
      ],
      attempts: [
        {
          id: result.result.attemptId,
          itemId: result.result.itemId,
          response: " mitochondria ",
          verdict: "correct",
          gradingMethod: "exact"
        }
      ]
    });
    expect(countRows(dbPath, "mastery")).toBe(1);
  });

  test("quiz with a db persists returned grade trace events for trace queries", async () => {
    const dbPath = createPlanDb([{ slug: "mitochondria", name: "Mitochondria", status: "generated" }]);

    const result = (await handleKlCommand([
      "quiz",
      "--db",
      dbPath,
      "--item",
      "Which organelle is the powerhouse of the cell?",
      "--concept",
      "mitochondria",
      "--answer",
      "mitochondria",
      "--response",
      "mitochondria"
    ])) as KlPersistentQuizCommandResult;

    const trace = await expectPersistedTraceEventsMatchResult(dbPath, result.result.runId, result.result.traceEvents);

    expect(trace.result.events.length).toBeGreaterThan(0);
    expect(trace.result.events.every((event) => event.runId === result.result.runId)).toBe(true);
    expect(trace.result.events.map((event) => event.stage)).toEqual(expect.arrayContaining(["grade"]));
    expect(trace.result.events.map((event) => event.message)).toEqual(
      result.result.traceEvents.map((event) => event.message)
    );
  });

  test("second quiz with a db on the same concept increments mastery attempts and changes score", async () => {
    const dbPath = createPlanDb([{ slug: "photosynthesis", name: "Photosynthesis", status: "generated" }]);

    const first = (await handleKlCommand([
      "quiz",
      "--db",
      dbPath,
      "--item",
      "What gas do plants release during photosynthesis?",
      "--concept",
      "photosynthesis",
      "--answer",
      "oxygen",
      "--answer",
      "O2",
      "--response",
      "oxygen"
    ])) as KlPersistentQuizCommandResult;
    const second = (await handleKlCommand([
      "quiz",
      "--db",
      dbPath,
      "--item",
      "What gas do plants release during photosynthesis?",
      "--concept",
      "photosynthesis",
      "--answer",
      "oxygen",
      "--answer",
      "O2",
      "--response",
      "carbon dioxide"
    ])) as KlPersistentQuizCommandResult;

    expect(first.mode).toBe("mock-persistent");
    expect(second.mode).toBe("mock-persistent");
    expect(first.result.mastery).toMatchObject({ score: 0.1, attemptsN: 1 });
    expect(second.result).toMatchObject({
      verdict: "incorrect",
      masteryDelta: -0.05,
      mastery: {
        score: 0.05,
        attemptsN: 2
      }
    });
    expect(countRows(dbPath, "items")).toBe(2);
    expect(countRows(dbPath, "attempts")).toBe(2);
    expect(countRows(dbPath, "mastery")).toBe(1);
  });

  test("quiz with a db rejects a missing concept without partial quiz writes", async () => {
    const dbPath = createPlanDb([]);

    await expect(
      handleKlCommand([
        "quiz",
        "--db",
        dbPath,
        "--item",
        "Missing concept prompt",
        "--concept",
        "missing",
        "--answer",
        "yes",
        "--response",
        "yes"
      ])
    ).rejects.toThrow(/Concept missing was not found/);

    expect(countRows(dbPath, "items")).toBe(0);
    expect(countRows(dbPath, "attempts")).toBe(0);
    expect(countRows(dbPath, "mastery")).toBe(0);
  });

  test("quiz requires exactly one db path when db is provided", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(
      handleKlCommand([
        "quiz",
        "--db",
        dbPath,
        "--db",
        otherDbPath,
        "--item",
        "Algebra prompt",
        "--concept",
        "algebra",
        "--answer",
        "x",
        "--response",
        "x"
      ])
    ).rejects.toThrow(/requires exactly one --db/);
  });

  test("quiz requires a db value when db is provided", async () => {
    await expect(handleKlCommand(["quiz", "--db"])).rejects.toThrow(/Option --db for quiz requires a value/);
  });

  test("quiz rejects unknown options", async () => {
    await expect(
      handleKlCommand([
        "quiz",
        "--item",
        "capital-france",
        "--concept",
        "paris",
        "--answer",
        "Paris",
        "--response",
        "Paris",
        "--bogus",
        "1"
      ])
    ).rejects.toThrow(/Unknown option for quiz: --bogus/);
  });

  test("teachback with a db persists transcript/report and returns persistent mode", async () => {
    const dbPath = createTeachbackDb({ slug: "retrieval-practice", name: "Retrieval Practice" });
    const stdout = createCapture();

    const result = (await handleKlCommand(
      [
        "teachback",
        "--db",
        dbPath,
        "--concept",
        "retrieval-practice",
        "--transcript",
        "  Retrieval practice uses active recall before review to strengthen memory.  "
      ],
      { stdout: stdout.sink }
    )) as KlPersistentTeachbackCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("teachback");
    expect(result.mode).toBe("mock-persistent");
    expect(result.result).toMatchObject({
      conceptSlug: "retrieval-practice",
      transcript: "Retrieval practice uses active recall before review to strengthen memory.",
      gradingMethod: "rubric",
      mastery: {
        attemptsN: 1
      }
    });
    expect(result.result.teachbackId).toBeGreaterThan(0);
    expect(result.result.rubricReport.page).toMatchObject({
      conceptSlug: "retrieval-practice",
      version: 1
    });
    expect(result.result.rubricReport.score).toBeGreaterThan(0);
    expect(readTeachbackRows(dbPath)).toEqual([
      {
        id: result.result.teachbackId,
        conceptSlug: "retrieval-practice",
        transcript: "Retrieval practice uses active recall before review to strengthen memory.",
        rubricReport: result.result.rubricReport
      }
    ]);
    expect(countRows(dbPath, "teachbacks")).toBe(1);
    expect(countRows(dbPath, "mastery")).toBe(1);
  });

  test("teachback with a db persists returned grade trace events for trace queries", async () => {
    const dbPath = createTeachbackDb({ slug: "retrieval-practice", name: "Retrieval Practice" });

    const result = (await handleKlCommand([
      "teachback",
      "--db",
      dbPath,
      "--concept",
      "retrieval-practice",
      "--transcript",
      "Retrieval practice uses active recall before review to strengthen memory."
    ])) as KlPersistentTeachbackCommandResult;

    const trace = await expectPersistedTraceEventsMatchResult(dbPath, result.result.runId, result.result.traceEvents);

    expect(trace.result.events.length).toBeGreaterThan(0);
    expect(trace.result.events.every((event) => event.runId === result.result.runId)).toBe(true);
    expect(trace.result.events.map((event) => event.stage)).toEqual(expect.arrayContaining(["grade"]));
    expect(trace.result.events.map((event) => event.message)).toEqual(
      result.result.traceEvents.map((event) => event.message)
    );
  });

  test("second teachback with a db on same concept increments mastery attempts", async () => {
    const dbPath = createTeachbackDb({ slug: "active-recall", name: "Active Recall" });

    const first = (await handleKlCommand([
      "teachback",
      "--db",
      dbPath,
      "--concept",
      "active-recall",
      "--transcript",
      "Active recall asks you to recall knowledge before review."
    ])) as KlPersistentTeachbackCommandResult;
    const second = (await handleKlCommand([
      "teachback",
      "--db",
      dbPath,
      "--concept",
      "active-recall",
      "--transcript",
      "This answer is unrelated to the lesson."
    ])) as KlPersistentTeachbackCommandResult;

    expect(first.mode).toBe("mock-persistent");
    expect(second.mode).toBe("mock-persistent");
    expect(first.result.mastery.attemptsN).toBe(1);
    expect(second.result.mastery.attemptsN).toBe(2);
    expect(countRows(dbPath, "teachbacks")).toBe(2);
    expect(countRows(dbPath, "mastery")).toBe(1);
  });

  test("teachback with a db rejects missing page without partial writes", async () => {
    const dbPath = createTeachbackDb({ slug: "no-page", name: "No Page", createPage: false });

    await expect(
      handleKlCommand([
        "teachback",
        "--db",
        dbPath,
        "--concept",
        "no-page",
        "--transcript",
        "This explanation has no page to grade against."
      ])
    ).rejects.toThrow(/No page was found for concept no-page/);

    expect(countRows(dbPath, "teachbacks")).toBe(0);
    expect(countRows(dbPath, "mastery")).toBe(0);
  });

  test("teachback requires exactly one db and required options", async () => {
    const dbPath = createTeachbackDb({ slug: "retrieval-practice", name: "Retrieval Practice" });
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(
      handleKlCommand([
        "teachback",
        "--concept",
        "retrieval-practice",
        "--transcript",
        "A valid explanation."
      ])
    ).rejects.toThrow(/requires exactly one --db/);
    await expect(
      handleKlCommand([
        "teachback",
        "--db",
        dbPath,
        "--db",
        otherDbPath,
        "--concept",
        "retrieval-practice",
        "--transcript",
        "A valid explanation."
      ])
    ).rejects.toThrow(/requires exactly one --db/);
    await expect(
      handleKlCommand(["teachback", "--db", dbPath, "--transcript", "A valid explanation."])
    ).rejects.toThrow(/requires exactly one --concept/);
    await expect(
      handleKlCommand([
        "teachback",
        "--db",
        dbPath,
        "--concept",
        "retrieval-practice",
        "--concept",
        "active-recall",
        "--transcript",
        "A valid explanation."
      ])
    ).rejects.toThrow(/requires exactly one --concept/);
    await expect(
      handleKlCommand(["teachback", "--db", dbPath, "--concept", "retrieval-practice"])
    ).rejects.toThrow(/requires exactly one --transcript/);
    await expect(
      handleKlCommand([
        "teachback",
        "--db",
        dbPath,
        "--concept",
        "retrieval-practice",
        "--transcript",
        "A valid explanation.",
        "--transcript",
        "Another explanation."
      ])
    ).rejects.toThrow(/requires exactly one --transcript/);
  });

  test("teachback rejects unknown options", async () => {
    const dbPath = createTeachbackDb({ slug: "retrieval-practice", name: "Retrieval Practice" });

    await expect(
      handleKlCommand([
        "teachback",
        "--db",
        dbPath,
        "--concept",
        "retrieval-practice",
        "--transcript",
        "A valid explanation.",
        "--bogus",
        "1"
      ])
    ).rejects.toThrow(/Unknown option for teachback: --bogus/);
  });

  test("application with a db and concept creates a free-form task and persists plan trace events", async () => {
    const dbPath = createApplicationDb({ slug: "retrieval-practice", name: "Retrieval Practice" });
    const stdout = createCapture();

    const result = (await handleKlCommand(
      ["application", "--db", dbPath, "--concept", "retrieval-practice"],
      { stdout: stdout.sink }
    )) as KlPersistentApplicationCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("application");
    expect(result.mode).toBe("mock-persistent");
    if (!("answerSpec" in result.result)) {
      throw new Error("Expected persistent application task result.");
    }
    const taskResult = result.result;
    expect(taskResult).toMatchObject({
      conceptSlug: "retrieval-practice",
      difficulty: 3,
      answerSpec: {
        type: "rubric",
        kind: "application",
        conceptSlug: "retrieval-practice"
      }
    });
    expect(result.result.itemId).toBeGreaterThan(0);
    expect(readApplicationRows(dbPath)).toMatchObject({
      items: [
        {
          id: result.result.itemId,
          conceptSlug: "retrieval-practice",
          type: "free_form",
          difficulty: 3,
          statement: taskResult.statement,
          answerSpec: taskResult.answerSpec
        }
      ],
      attempts: [],
      mastery: []
    });

    const trace = await expectPersistedTraceEventsMatchResult(dbPath, result.result.runId, result.result.traceEvents);
    expect(trace.result.events).toHaveLength(1);
    expect(trace.result.events[0]).toMatchObject({
      runId: result.result.runId,
      stage: "plan",
      message: "Application task generated"
    });
  });

  test("application with a db item and response grades an attempt and persists mastery plus grade trace events", async () => {
    const dbPath = createApplicationDb({ slug: "retrieval-practice", name: "Retrieval Practice" });
    const created = (await handleKlCommand([
      "application",
      "--db",
      dbPath,
      "--concept",
      "retrieval-practice",
      "--difficulty",
      "4"
    ])) as KlPersistentApplicationCommandResult;

    const result = (await handleKlCommand([
      "application",
      "--db",
      dbPath,
      "--item",
      String(created.result.itemId),
      "--response",
      "Retrieval practice uses transfer of knowledge in realistic planning scenarios with constraints and feedback."
    ])) as KlPersistentApplicationCommandResult;

    expect(result.command).toBe("application");
    expect(result.mode).toBe("mock-persistent");
    if (!("attemptId" in result.result)) {
      throw new Error("Expected persistent application grade result.");
    }
    const gradeResult = result.result;
    expect(gradeResult).toMatchObject({
      itemId: created.result.itemId,
      conceptSlug: "retrieval-practice",
      verdict: "correct",
      gradingMethod: "rubric",
      masteryDelta: 0.12,
      mastery: {
        score: 0.12,
        confidence: 0.85,
        attemptsN: 1
      }
    });
    expect(gradeResult.attemptId).toBeGreaterThan(0);
    expect(readApplicationRows(dbPath)).toMatchObject({
      items: [
        {
          id: created.result.itemId,
          conceptSlug: "retrieval-practice",
          type: "free_form",
          difficulty: 4
        }
      ],
      attempts: [
        {
          id: gradeResult.attemptId,
          itemId: created.result.itemId,
          response:
            "Retrieval practice uses transfer of knowledge in realistic planning scenarios with constraints and feedback.",
          verdict: "correct",
          gradingMethod: "rubric"
        }
      ],
      mastery: [
        {
          conceptSlug: "retrieval-practice",
          score: 0.12,
          confidence: 0.85,
          attemptsN: 1
        }
      ]
    });

    const trace = await expectPersistedTraceEventsMatchResult(dbPath, gradeResult.runId, gradeResult.traceEvents);
    expect(trace.result.events.map((event) => event.message)).toEqual(["Mastery updated", "Application attempt graded"]);
    expect(trace.result.events.map((event) => event.stage)).toEqual(expect.arrayContaining(["grade"]));
  });

  test("application rejects missing and duplicate db plus missing or mixed mode options", async () => {
    const dbPath = createApplicationDb({ slug: "retrieval-practice", name: "Retrieval Practice" });
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(handleKlCommand(["application", "--concept", "retrieval-practice"])).rejects.toThrow(
      /Command application requires exactly one --db/
    );
    await expect(
      handleKlCommand(["application", "--db", dbPath, "--db", otherDbPath, "--concept", "retrieval-practice"])
    ).rejects.toThrow(/Command application requires exactly one --db/);
    await expect(handleKlCommand(["application", "--db", dbPath])).rejects.toThrow(
      /Command application requires either create mode \(--concept\) or grade mode \(--item and --response\)/
    );
    await expect(handleKlCommand(["application", "--db", dbPath, "--item", "1"])).rejects.toThrow(
      /Command application grade mode requires exactly one --item and exactly one --response/
    );
    await expect(
      handleKlCommand(["application", "--db", dbPath, "--concept", "retrieval-practice", "--response", "answer"])
    ).rejects.toThrow(/Command application cannot mix create options with grade options/);
    await expect(
      handleKlCommand([
        "application",
        "--db",
        dbPath,
        "--item",
        "1",
        "--response",
        "answer",
        "--difficulty",
        "2"
      ])
    ).rejects.toThrow(/Command application cannot mix grade options with create options/);
  });

  test("application rejects invalid values unknown options and missing pages without partial item writes", async () => {
    const dbPath = createApplicationDb({ slug: "retrieval-practice", name: "Retrieval Practice" });
    const missingPageDbPath = createApplicationDb({
      slug: "no-page",
      name: "No Page",
      createPage: false
    });

    await expect(
      handleKlCommand(["application", "--db", dbPath, "--item", "0", "--response", "answer"])
    ).rejects.toThrow(/Invalid --item value "0"/);
    await expect(
      handleKlCommand(["application", "--db", dbPath, "--concept", "retrieval-practice", "--difficulty", "0"])
    ).rejects.toThrow(/Invalid --difficulty value "0"/);
    await expect(
      handleKlCommand(["application", "--db", dbPath, "--concept", "retrieval-practice", "--bogus", "1"])
    ).rejects.toThrow(/Unknown option for application: --bogus/);
    await expect(
      handleKlCommand(["application", "--db", missingPageDbPath, "--concept", "no-page"])
    ).rejects.toThrow(/No page was found for concept no-page/);

    expect(countRows(missingPageDbPath, "items")).toBe(0);
    expect(countRows(missingPageDbPath, "attempts")).toBe(0);
    expect(countRows(missingPageDbPath, "mastery")).toBe(0);
  });

  test("application rejects difficulty above five before creating a missing db", async () => {
    const missingDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-application-invalid-")), "missing.db");
    const command = handleKlCommand([
      "application",
      "--db",
      missingDbPath,
      "--concept",
      "retrieval-practice",
      "--difficulty",
      "6"
    ]);

    await expect(command).rejects.toThrow(/Invalid --difficulty value/);
    await expect(command).rejects.toHaveProperty("exitCode", 2);

    expect(existsSync(missingDbPath)).toBe(false);
  });

  test("diagnose with a db returns weak spots and writes JSON", async () => {
    const dbPath = createDiagnoseDb([
      { slug: "alpha", name: "Alpha", score: 0.2, confidence: 0.4 },
      { slug: "mastered", name: "Mastered", score: 0.95, confidence: 0.9 }
    ]);
    const stdout = createCapture();

    const result = await handleKlCommand(["diagnose", "--db", dbPath], { stdout: stdout.sink });

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("diagnose");
    expect(result.mode).toBe("mock-persistent");
    if (result.command !== "diagnose" || result.mode !== "mock-persistent") {
      throw new Error("Expected persistent diagnose result.");
    }
    expect(result.result.masteryThreshold).toBe(0.8);
    expect(result.result.weakSpots).toMatchObject([
      {
        conceptSlug: "alpha",
        conceptName: "Alpha",
        score: 0.2,
        confidence: 0.4,
        attemptsN: 1
      }
    ]);
    expect(result.result.summary).toMatchObject({
      weakSpotCount: 1,
      threshold: 0.8,
      lowestScore: 0.2
    });
    expect(result.result.traceEvents).toHaveLength(1);
    const trace = await expectPersistedTraceEventsMatchResult(dbPath, result.result.runId, result.result.traceEvents);
    expect(trace.result.events[0]).toMatchObject({
      runId: result.result.runId,
      stage: "diagnose",
      message: "Persistent weak spots diagnosed"
    });
  });

  test("diagnose with threshold and limit applies options deterministically", async () => {
    const dbPath = createDiagnoseDb([
      { slug: "alpha", name: "Alpha", score: 0.2 },
      { slug: "beta", name: "Beta", score: 0.1 },
      { slug: "gamma", name: "Gamma", score: 0.6 }
    ]);

    const result = await handleKlCommand(["diagnose", "--db", dbPath, "--threshold", "0.5", "--limit", "1"]);

    expect(result.command).toBe("diagnose");
    expect(result.mode).toBe("mock-persistent");
    if (result.command !== "diagnose" || result.mode !== "mock-persistent") {
      throw new Error("Expected persistent diagnose result.");
    }
    expect(result.result.masteryThreshold).toBe(0.5);
    expect(result.result.weakSpots.map((weakSpot) => weakSpot.conceptSlug)).toEqual(["beta"]);
    expect(result.result.summary).toMatchObject({
      weakSpotCount: 1,
      threshold: 0.5,
      lowestScore: 0.1
    });
  });

  test("diagnose persists only returned trace events from the CLI", async () => {
    const dbPath = createDiagnoseDb([
      { slug: "alpha", name: "Alpha", score: 0.2 },
      { slug: "beta", name: "Beta", score: 0.9 }
    ]);
    const beforeDomainRows = countDomainRows(dbPath);
    const beforeTraceRows = countRows(dbPath, "trace_events");

    const result = await handleKlCommand(["diagnose", "--db", dbPath, "--threshold", "0.8"]);

    expect(result.command).toBe("diagnose");
    expect(result.mode).toBe("mock-persistent");
    if (result.command !== "diagnose" || result.mode !== "mock-persistent") {
      throw new Error("Expected persistent diagnose result.");
    }
    await expectPersistedTraceEventsMatchResult(dbPath, result.result.runId, result.result.traceEvents);
    expect(countDomainRows(dbPath)).toEqual(beforeDomainRows);
    expect(countRows(dbPath, "trace_events")).toBe(beforeTraceRows + result.result.traceEvents.length);
  });

  test("diagnose rejects a missing db without creating it", async () => {
    const missingDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-diagnose-missing-")), "missing.db");

    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--threshold", "0.8"])).rejects.toThrow();

    expect(existsSync(missingDbPath)).toBe(false);
  });

  test("diagnose rejects an unmigrated db without writing schema", async () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-diagnose-unmigrated-"));
    const dbPath = path.join(dbDir, "empty.db");
    const db = new Database(dbPath);
    db.close();

    await expect(handleKlCommand(["diagnose", "--db", dbPath, "--threshold", "0.8"])).rejects.toThrow();

    expect(listTableNames(dbPath)).toEqual([]);
  });

  test("diagnose rejects missing and duplicate db threshold and limit options", async () => {
    const dbPath = createDiagnoseDb([{ slug: "alpha", name: "Alpha", score: 0.2 }]);
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(handleKlCommand(["diagnose"])).rejects.toThrow(/requires exactly one --db/);
    await expect(handleKlCommand(["diagnose", "--db", dbPath, "--db", otherDbPath])).rejects.toThrow(
      /requires exactly one --db/
    );
    await expect(
      handleKlCommand(["diagnose", "--db", dbPath, "--threshold", "0.7", "--threshold", "0.8"])
    ).rejects.toThrow(/requires exactly one --threshold/);
    await expect(
      handleKlCommand(["diagnose", "--db", dbPath, "--limit", "1", "--limit", "2"])
    ).rejects.toThrow(/requires exactly one --limit/);
  });

  test("diagnose rejects invalid threshold and limit values before opening db", async () => {
    const missingDbPath = path.join(mkdtempSync(path.join(tmpdir(), "kl-cli-diagnose-invalid-")), "missing.db");

    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--threshold", "abc"])).rejects.toThrow(
      /Invalid --threshold value "abc"/
    );
    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--threshold", "Infinity"])).rejects.toThrow(
      /Invalid --threshold value "Infinity"/
    );
    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--threshold", ""])).rejects.toThrow(
      /Invalid --threshold value ""/
    );
    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--threshold", "   "])).rejects.toThrow(
      /Invalid --threshold value " {3}"/
    );
    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--threshold", "-0.1"])).rejects.toThrow(
      /Invalid --threshold value "-0.1"/
    );
    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--threshold", "2"])).rejects.toThrow(
      /Invalid --threshold value "2"/
    );
    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--limit", "0"])).rejects.toThrow(
      /Invalid --limit value "0"/
    );
    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--limit", "1.5"])).rejects.toThrow(
      /Invalid --limit value "1.5"/
    );
    await expect(handleKlCommand(["diagnose", "--db", missingDbPath, "--limit", "9007199254740992"])).rejects.toThrow(
      /Invalid --limit value "9007199254740992"/
    );
    expect(existsSync(missingDbPath)).toBe(false);
  });

  test("diagnose rejects unknown options", async () => {
    const dbPath = createDiagnoseDb([{ slug: "alpha", name: "Alpha", score: 0.2 }]);

    await expect(handleKlCommand(["diagnose", "--db", dbPath, "--bogus", "1"])).rejects.toThrow(
      /Unknown option for diagnose: --bogus/
    );
  });
});
