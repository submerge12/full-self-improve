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
  type KlAgentDryRunCommandResult,
  type KlAgentScheduleDryRunCommandResult,
  type KlCommandResult,
  type KlPersistentQuizCommandResult,
  type KlPersistentTeachbackCommandResult
} from "./kl.js";

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

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
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
  test("unknown command lists diagnose and agent as expected commands", async () => {
    await expect(handleKlCommand(["unknown"])).rejects.toThrow(
      /Expected one of: ingest, plan, quiz, teachback, diagnose, trace, agent, agent-day, agent-schedule/
    );
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
    await expect(handleKlCommand(["agent", "--dry-run", "--role", "coach", "--date", "2026-06-13"])).rejects.toThrow(
      /Invalid agent role/
    );
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

  test("agent-day dry-run prints the M2 board-day sequence", async () => {
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
      "scholar:evening-mastery"
    ]);
    expect(result.result.intendedActions.map((action) => action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Scholar study plan for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
  });

  test("agent-day live mode manually runs the day sequence through injected HTTP clients", async () => {
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
          KL_AGENT_READ_BEARER_TOKEN: "read-secret",
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

          return jsonResponse({ ok: true, url });
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
          reads: 4,
          publishedActions: 4,
          blockers: 0,
          publishFailures: 0
        }
      }
    });
    expect(result.result.publishedActions.map((publish) => publish.action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Scholar study plan for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
    expect(calls.map((call) => String(call.input))).toEqual([
      "http://knowledge.local/api/ingest/run?adapter=holly-vault",
      "http://multica.local/api/comments",
      "http://knowledge.local/api/plan/today",
      "http://multica.local/api/tasks",
      "http://compass.local/api/meal-plan/today?date=2026-06-13",
      "http://multica.local/api/tasks",
      "http://knowledge.local/api/mastery/summary",
      "http://multica.local/api/comments"
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer read-secret" });
    expect(calls[1]?.init?.headers).toMatchObject({ Authorization: "Bearer board-secret" });
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

  test("agent-schedule command validates dry-run mode and schedule inputs", async () => {
    await expect(handleKlCommand(["agent-schedule", "--now", "2026-06-14T07:30:00+08:00"])).rejects.toThrow(
      /supports only --dry-run/
    );
    await expect(handleKlCommand(["agent-schedule", "--live", "--now", "2026-06-14T07:30:00+08:00"])).rejects.toThrow(
      /Unknown option for agent-schedule: --live/
    );
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
