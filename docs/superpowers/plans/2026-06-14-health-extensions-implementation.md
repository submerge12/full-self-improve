# M4 Health Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build M4 health-extensions as deterministic TypeScript modules inside `knowledge-loop`, with CLI/API access, Coach dry-run/live publishing, Windows logger evidence, and compass-health read-only proof.

**Architecture:** Keep deterministic domain logic in `src/health-extensions` with no Next imports. Persist health data in the existing `knowledge-loop.db` migration flow, expose private routes through the current API manifest and pure handler dispatcher, use thin Next route wrappers through `createApiRouteHandler`, and extend the existing agent dry-run/live board path for Coach.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Next App Router route handlers, the existing `npm run kl -- ...` CLI entry point, and the existing Multica board client abstractions.

---

## Team Mode Rules

- Implement each task in team mode with a fresh worker, a spec reviewer, and a quality reviewer.
- Use this plan and `docs/superpowers/specs/2026-06-14-health-extensions-design.md` as the source of truth.
- Do not touch `docs/AUDIT-MANUAL.md`.
- Do not edit `PLAN.md` during implementation tasks.
- Do not modify, read from, or write into the `compass-health` repository or database from health-extensions code. The only health-extensions integration path is HTTP(S).
- Do not add dependencies unless the controller explicitly approves a separate dependency task.
- Do not run destructive filesystem commands or delete files. If cleanup is needed, stop and ask the controller.
- Every task ends with a checkpoint under the exact `.ai/checkpoints/.../step-1.md` path named in that task, focused tests, `npm run check`, review, commit, and push.
- M4 is not complete until the live gates in Tasks 6, 8, and 9 pass and `docs/reviews/M4.md` records the evidence.

## File Structure

Future implementation files and responsibilities:

- `src/health-extensions/schema.ts`: shared health domain types, enums, DTOs, finite-number checks, date/instant parsing, metric key normalization, CSV row validation, and URL validation primitives.
- `src/health-extensions/store.ts`: SQL statements and transactions for health tables. This file owns persistence, row mapping, and audit inserts.
- `src/health-extensions/metrics.ts`: metric create/list/update behavior, CSV import/export normalization, import idempotency, and metric audit trace projection.
- `src/health-extensions/exercise.ts`: exercise template creation, weekly plan generation, session completion, ad hoc session recording, and completion-rate queries.
- `src/health-extensions/sedentary.ts`: active/idle span ingestion, interval normalization, streak computation, reminder eligibility, and reminder persistence.
- `src/health-extensions/compass-client.ts`: HTTP-only read client for compass-health public endpoints. It rejects file URLs, local paths, URL credentials, and non-HTTP protocols.
- `src/health-extensions/coach-digest.ts`: deterministic daily digest snapshots from metrics, exercise, sedentary, and optional compass-health HTTP context.
- `src/health-extensions/windows-logger-contract.ts`: JSON contract and validator for Windows active/idle span posts, heartbeat evidence, and logger config.
- `src/health-extensions/windows-logger.ts`: repo-owned Windows logger companion loop with idle polling, span posting, heartbeat posting, visible alert trigger, startup command rendering, and sleep/wake recovery hooks.
- `src/health-extensions/live-evidence.ts`: validators for live evidence files: Windows logger proof, Multica Coach publish proof, and one-week compass-health hash proof.
- Health-extension test files: `src/health-extensions/store.test.ts`, `src/health-extensions/metrics.test.ts`, `src/health-extensions/exercise.test.ts`, `src/health-extensions/sedentary.test.ts`, `src/health-extensions/coach-digest.test.ts`, `src/health-extensions/compass-client.test.ts`, `src/health-extensions/windows-logger.test.ts`, `src/health-extensions/windows-logger-contract.test.ts`, and `src/health-extensions/live-evidence.test.ts`.
- `src/db/migrations.ts`: add health tables through a new migration entry after existing migrations.
- `src/db/migrations.test.ts`: assert health tables, constraints, replayability, and no-key deterministic schema behavior.
- `src/api/contracts.ts`: add health route IDs and route matching rules. Expand `ApiMethod` only when a task introduces `PATCH`.
- `src/api/contracts.test.ts`: assert manifest identity, auth mode, and concrete query/path matching for health routes.
- `src/api/handlers.ts`: parse health request bodies/queries, call health domain modules, return existing success/error envelopes, and preserve transaction boundaries.
- `src/api/handlers.test.ts`: API handler success, auth, malformed input, rollback, audit, and no-partial-write tests.
- `src/app/api/health/.../route.ts`: thin route wrappers with `runtime = "nodejs"` and `createApiRouteHandler`.
- `src/app/api/_shared/route-adapter.test.ts`: actual route module method/runtime/auth tests.
- `src/cli/kl.ts`: add `health-*` commands and Coach command plumbing using current JSON envelope style.
- `src/cli/kl.test.ts`: CLI command output, validation, persistent DB, and no-partial-write tests.
- `src/agents/dry-run.ts`: add `coach` role and `daily-health` phase in the Coach slice only.
- `src/agents/profiles.ts`: add a safe Coach profile in the Coach slice only.
- `src/agents/config.ts`: allow Coach config role and phase in the Coach slice only.
- `src/agents/executor.ts`: render Coach digest reads into Multica publish bodies and publish blockers on malformed digest bodies.
- `src/agents/day-runner.ts`: reuse existing execution sequencing and cost reporting for Coach.
- `src/agents/coach-report.ts`: render validated health digest API bodies into Multica board text.
- `src/agents/coach-report.test.ts`: renderer and malformed-body blocker tests.
- `config/agents.example.json`: add Coach dry-run defaults in the Coach slice only.
- `docs/reviews/M4.md`: created in the live review/evidence task as a pending review note, then updated to complete only after live gates pass.

---

## Task 1: Schema And Store Core

**Task id:** `part-m4-health-schema-store`

**Files:**
- Create: `src/health-extensions/schema.ts`
- Create: `src/health-extensions/store.ts`
- Create: `src/health-extensions/store.test.ts`
- Modify: `src/db/migrations.ts`
- Modify: `src/db/migrations.test.ts`
- Create checkpoint: `.ai/checkpoints/part-m4-health-schema-store/step-1.md`

- [ ] **Step 1: Write failing migration tests**

Add health table names to `EXPECTED_TABLES` in `src/db/migrations.test.ts` and add direct constraint tests for JSON, status enums, finite values, idempotent import hashes, and source-id dedupe.

Required test snippet:

```ts
test("creates health extension tables and enforces core constraints", () => {
  const db = new Database(":memory:");
  try {
    applyMigrations(db);
    expect(listTables(db)).toEqual(expect.arrayContaining([
      "health_metrics",
      "health_metric_audit_events",
      "health_metric_imports",
      "exercise_templates",
      "exercise_plans",
      "exercise_sessions",
      "sedentary_spans",
      "sedentary_streaks",
      "break_reminders",
      "coach_digest_snapshots",
      "health_trace_events"
    ]));
    expect(() =>
      db.prepare(
        "INSERT INTO health_metrics (metric_key, metric_label, value, unit, observed_at, source) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("sleep", "Sleep", Number.POSITIVE_INFINITY, "hours", "2026-06-14T00:00:00.000Z", "manual")
    ).toThrow();
  } finally {
    db.close();
  }
});
```

Run: `npm run test:unit -- src/db/migrations.test.ts`

Expected: FAIL because health tables do not exist.

- [ ] **Step 2: Write failing store tests**

Create `src/health-extensions/store.test.ts` with in-memory SQLite setup and tests for inserting/listing metrics, imports, exercise rows, sedentary spans, reminders, digest snapshots, and health trace rows.

Required test snippet:

```ts
test("inserts a metric observation and returns stable ordering", () => {
  const db = migratedDb();
  try {
    const first = insertHealthMetric(db, {
      metricKey: "sleep",
      metricLabel: "Sleep",
      value: 7.5,
      unit: "hours",
      observedAt: "2026-06-14T07:00:00.000Z",
      source: "manual",
      note: "good sleep"
    });
    const second = insertHealthMetric(db, {
      metricKey: "weight",
      metricLabel: "Weight",
      value: 58.2,
      unit: "kg",
      observedAt: "2026-06-14T08:00:00.000Z",
      source: "manual"
    });
    expect(listHealthMetrics(db, {})).toMatchObject([{ id: first.id }, { id: second.id }]);
  } finally {
    db.close();
  }
});
```

Run: `npm run test:unit -- src/health-extensions/store.test.ts`

Expected: FAIL with missing module or missing exported functions.

- [ ] **Step 3: Add domain types and validators**

Create `src/health-extensions/schema.ts` with these exports:

```ts
export type HealthMetricSource = "manual" | "csv" | "mock";
export type ExercisePlanStatus = "active" | "archived";
export type ExerciseSessionStatus = "planned" | "completed" | "missed" | "ad_hoc";
export type SedentaryState = "active" | "idle" | "unknown";
export type BreakReminderStatus = "eligible" | "suppressed" | "delivered" | "expired";

export interface HealthMetricInput {
  readonly metricKey: string;
  readonly metricLabel: string;
  readonly value: number;
  readonly unit: string;
  readonly observedAt: string;
  readonly source: HealthMetricSource;
  readonly note?: string;
}

export interface StoredHealthMetric extends HealthMetricInput {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function normalizeMetricKey(value: string): string;
export function assertIsoInstant(value: string, field: string): string;
export function assertIsoDate(value: string, field: string): string;
export function assertFiniteMetricValue(value: number, field: string): number;
export function assertSafeText(value: string, field: string): string;
export function normalizeHealthMetricInput(input: HealthMetricInput): HealthMetricInput;
```

Keep functions pure and deterministic.

- [ ] **Step 4: Add migration**

Append this complete migration to `MIGRATIONS` in `src/db/migrations.ts`:

```ts
{
  id: "0003_health_extensions",
  name: "Health extensions schema",
  sql: `
CREATE TABLE IF NOT EXISTS health_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_key TEXT NOT NULL CHECK (length(trim(metric_key)) > 0),
  metric_label TEXT NOT NULL CHECK (length(trim(metric_label)) > 0),
  value REAL NOT NULL CHECK (value = value AND abs(value) < 1.0e308),
  unit TEXT NOT NULL CHECK (length(trim(unit)) > 0 AND length(unit) <= 32),
  observed_at TEXT NOT NULL CHECK (length(trim(observed_at)) > 0),
  source TEXT NOT NULL CHECK (source IN ('manual', 'csv', 'mock')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS health_metrics_key_observed_idx ON health_metrics (metric_key, observed_at, id);
CREATE INDEX IF NOT EXISTS health_metrics_observed_idx ON health_metrics (observed_at, id);

CREATE TABLE IF NOT EXISTS health_metric_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id INTEGER NOT NULL,
  changed_at TEXT NOT NULL CHECK (length(trim(changed_at)) > 0),
  changed_by TEXT NOT NULL CHECK (changed_by IN ('cli', 'api')),
  previous_json TEXT NOT NULL CHECK (json_valid(previous_json)),
  next_json TEXT NOT NULL CHECK (json_valid(next_json)),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  FOREIGN KEY (metric_id) REFERENCES health_metrics(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS health_metric_audit_metric_changed_idx ON health_metric_audit_events (metric_id, changed_at, id);

CREATE TABLE IF NOT EXISTS health_metric_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_filename TEXT NOT NULL CHECK (length(trim(source_filename)) > 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
  imported_at TEXT NOT NULL CHECK (length(trim(imported_at)) > 0),
  content_hash TEXT NOT NULL UNIQUE CHECK (length(trim(content_hash)) > 0),
  CHECK (accepted_count + rejected_count = row_count)
);
CREATE INDEX IF NOT EXISTS health_metric_imports_imported_idx ON health_metric_imports (imported_at, id);

CREATE TABLE IF NOT EXISTS exercise_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE CHECK (length(trim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  default_days TEXT NOT NULL CHECK (json_valid(default_days) AND json_type(default_days) = 'array'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS exercise_templates_active_slug_idx ON exercise_templates (active, slug);

CREATE TABLE IF NOT EXISTS exercise_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  week_start TEXT NOT NULL CHECK (length(trim(week_start)) = 10),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  generated_from TEXT NOT NULL CHECK (length(trim(generated_from)) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id) REFERENCES exercise_templates(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS exercise_plans_active_week_idx ON exercise_plans (week_start) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS exercise_plans_template_week_idx ON exercise_plans (template_id, week_start, id);

CREATE TABLE IF NOT EXISTS exercise_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER,
  template_session_key TEXT,
  scheduled_for TEXT,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'completed', 'missed', 'ad_hoc')),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  intensity TEXT CHECK (intensity IS NULL OR intensity IN ('low', 'moderate', 'high')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status != 'planned' OR scheduled_for IS NOT NULL),
  CHECK (status != 'completed' OR completed_at IS NOT NULL),
  FOREIGN KEY (plan_id) REFERENCES exercise_plans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS exercise_sessions_plan_scheduled_idx ON exercise_sessions (plan_id, scheduled_for, id);
CREATE INDEX IF NOT EXISTS exercise_sessions_completed_idx ON exercise_sessions (completed_at, id);

CREATE TABLE IF NOT EXISTS sedentary_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT UNIQUE,
  span_start TEXT NOT NULL CHECK (length(trim(span_start)) > 0),
  span_end TEXT NOT NULL CHECK (length(trim(span_end)) > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'idle', 'unknown')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (span_end > span_start)
);
CREATE INDEX IF NOT EXISTS sedentary_spans_window_idx ON sedentary_spans (span_start, span_end, id);
CREATE INDEX IF NOT EXISTS sedentary_spans_state_window_idx ON sedentary_spans (state, span_start, span_end, id);

CREATE TABLE IF NOT EXISTS sedentary_streaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start TEXT NOT NULL CHECK (length(trim(window_start)) > 0),
  window_end TEXT NOT NULL CHECK (length(trim(window_end)) > 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  source_span_ids TEXT NOT NULL CHECK (json_valid(source_span_ids) AND json_type(source_span_ids) = 'array'),
  computed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (window_end > window_start)
);
CREATE INDEX IF NOT EXISTS sedentary_streaks_window_idx ON sedentary_streaks (window_start, window_end, id);
CREATE INDEX IF NOT EXISTS sedentary_streaks_duration_idx ON sedentary_streaks (duration_minutes, id);

CREATE TABLE IF NOT EXISTS break_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streak_id INTEGER NOT NULL,
  eligible_at TEXT NOT NULL CHECK (length(trim(eligible_at)) > 0),
  status TEXT NOT NULL CHECK (status IN ('eligible', 'suppressed', 'delivered', 'expired')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  delivered_at TEXT,
  delivery_channel TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (streak_id, eligible_at),
  FOREIGN KEY (streak_id) REFERENCES sedentary_streaks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS break_reminders_status_eligible_idx ON break_reminders (status, eligible_at, id);

CREATE TABLE IF NOT EXISTS coach_digest_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL CHECK (length(trim(date)) = 10),
  metrics_summary_json TEXT NOT NULL CHECK (json_valid(metrics_summary_json)),
  exercise_summary_json TEXT NOT NULL CHECK (json_valid(exercise_summary_json)),
  sedentary_summary_json TEXT NOT NULL CHECK (json_valid(sedentary_summary_json)),
  compass_context_json TEXT NOT NULL CHECK (json_valid(compass_context_json)),
  rendered_markdown TEXT NOT NULL CHECK (length(trim(rendered_markdown)) > 0),
  source_hash TEXT NOT NULL CHECK (length(trim(source_hash)) > 0),
  published_at TEXT,
  publish_result_json TEXT CHECK (publish_result_json IS NULL OR json_valid(publish_result_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (date, source_hash)
);
CREATE INDEX IF NOT EXISTS coach_digest_snapshots_date_idx ON coach_digest_snapshots (date, id);
CREATE INDEX IF NOT EXISTS coach_digest_snapshots_published_idx ON coach_digest_snapshots (published_at, id);

CREATE TABLE IF NOT EXISTS health_trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('metric', 'exercise', 'sedentary', 'coach', 'live-evidence')),
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(data))
);
CREATE INDEX IF NOT EXISTS health_trace_events_run_id_id_idx ON health_trace_events (run_id, id);
CREATE INDEX IF NOT EXISTS health_trace_events_run_id_stage_id_idx ON health_trace_events (run_id, stage, id);
`
}
```

- [ ] **Step 5: Add store helpers**

Create `src/health-extensions/store.ts` with these signatures:

```ts
import type Database from "better-sqlite3";

export function insertHealthMetric(db: Database.Database, input: HealthMetricInput): StoredHealthMetric;
export function getHealthMetricById(db: Database.Database, id: number): StoredHealthMetric | undefined;
export function listHealthMetrics(db: Database.Database, query: HealthMetricQuery): StoredHealthMetric[];
export function insertHealthTraceEvent(db: Database.Database, event: HealthTraceEventInput): StoredHealthTraceEvent;
export function insertMetricAuditEvent(db: Database.Database, input: MetricAuditInput): StoredMetricAuditEvent;
export function insertMetricImportRecord(db: Database.Database, input: MetricImportInput): StoredMetricImport;
export function findMetricImportByHash(db: Database.Database, contentHash: string): StoredMetricImport | undefined;
```

Map snake_case SQL rows to camelCase DTOs inside this file.

- [ ] **Step 6: Verify focused tests pass**

Run: `npm run test:unit -- src/db/migrations.test.ts src/health-extensions/store.test.ts`

Expected: PASS with health tables present and store helpers returning deterministic DTOs.

- [ ] **Step 7: Run broader checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 8: Write checkpoint**

Write `.ai/checkpoints/part-m4-health-schema-store/step-1.md`:

```md
## Step 1

What I did: Added the health-extensions database migration, schema validators, core store helpers, and focused tests.
Files modified: [src/db/migrations.ts, src/db/migrations.test.ts, src/health-extensions/schema.ts, src/health-extensions/store.ts, src/health-extensions/store.test.ts]
Test status: passing
Verification commands: npm run test:unit -- src/db/migrations.test.ts src/health-extensions/store.test.ts; npm run check
Next step: Dispatch spec reviewer and quality reviewer, then commit/push this slice before Task 2.
```

- [ ] **Step 9: Commit and push this slice**

Run:

```powershell
git status --short
git add src/db/migrations.ts src/db/migrations.test.ts src/health-extensions/schema.ts src/health-extensions/store.ts src/health-extensions/store.test.ts .ai/checkpoints/part-m4-health-schema-store/step-1.md
git commit -m "feat: add health extensions schema store"
git push -u origin HEAD
```

Expected: commit and push succeed after reviewers approve.

---

## Task 2: Metrics, Metric Update, CSV Import, CLI, And API

**Task id:** `part-m4-health-metrics-api-cli`

**Files:**
- Create: `src/health-extensions/metrics.ts`
- Create: `src/health-extensions/metrics.test.ts`
- Modify: `src/health-extensions/store.ts`
- Modify: `src/health-extensions/store.test.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/api/contracts.test.ts`
- Modify: `src/api/handlers.ts`
- Modify: `src/api/handlers.test.ts`
- Create: `src/app/api/health/metrics/route.ts`
- Create: `src/app/api/health/metrics/import/route.ts`
- Modify: `src/app/api/_shared/route-adapter.test.ts`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create checkpoint: `.ai/checkpoints/part-m4-health-metrics-api-cli/step-1.md`

- [ ] **Step 1: Write failing metrics domain tests**

Create tests for metric key normalization, finite value validation, stable date-window queries, CSV import row reporting, duplicate import detection, CSV round-trip, update audit, no-change update rejection, and rollback when audit insert fails.

Required test snippet:

```ts
test("updates one metric with audit and health trace in one transaction", () => {
  const db = migratedDb();
  const created = createHealthMetric(db, {
    metricKey: "Weight",
    metricLabel: "Weight",
    value: 58.2,
    unit: "kg",
    observedAt: "2026-06-14T08:00:00.000Z",
    source: "manual"
  });
  const result = updateHealthMetric(db, {
    id: created.metric.id,
    changes: { value: 58.0, note: "scale correction" },
    changedBy: "cli",
    reason: "corrected morning reading",
    now: "2026-06-14T08:05:00.000Z",
    runId: "health-metric-update-test"
  });
  expect(result.metric.value).toBe(58.0);
  expect(result.audit.previous.value).toBe(58.2);
  expect(result.audit.next.value).toBe(58.0);
  expect(result.traceEvents).toMatchObject([{ stage: "metric", message: "Health metric updated" }]);
});
```

Run: `npm run test:unit -- src/health-extensions/metrics.test.ts`

Expected: FAIL because `metrics.ts` does not exist.

- [ ] **Step 2: Write failing API and CLI tests**

Add route manifest tests for these IDs:

```ts
"health.metrics.create"
"health.metrics.list"
"health.metrics.update"
"health.metrics.import"
```

Add handler tests for:

- `POST /api/health/metrics`
- `GET /api/health/metrics?metric=weight&from=2026-06-14&to=2026-06-15`
- `PATCH /api/health/metrics` with body `{ "id": 1, "value": 58.0, "reason": "corrected morning reading" }`
- `POST /api/health/metrics/import`

Add CLI tests for:

- `health-metric add --db .ai/tmp/m4-health/metrics.db --metric weight --label Weight --value 58.2 --unit kg --observed-at 2026-06-14T08:00:00.000Z`
- `health-metric list --db .ai/tmp/m4-health/metrics.db --metric weight --from 2026-06-14 --to 2026-06-15`
- `health-metric update --db .ai/tmp/m4-health/metrics.db --id 1 --value 58.0 --reason "corrected morning reading"`
- `health-metric import-csv --db .ai/tmp/m4-health/metrics.db --file .ai/tmp/m4-health/metrics.csv`

Run:

```powershell
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Expected: FAIL with missing route IDs and commands.

- [ ] **Step 3: Implement metrics domain**

Create `src/health-extensions/metrics.ts` with these signatures:

```ts
export interface CreateHealthMetricResult {
  readonly metric: StoredHealthMetric;
  readonly traceEvents: readonly StoredHealthTraceEvent[];
}

export interface HealthMetricUpdateInput {
  readonly id: number;
  readonly changes: {
    readonly metricKey?: string;
    readonly metricLabel?: string;
    readonly value?: number;
    readonly unit?: string;
    readonly observedAt?: string;
    readonly note?: string;
  };
  readonly changedBy: "cli" | "api";
  readonly reason: string;
  readonly now?: string;
  readonly runId?: string;
}

export interface HealthMetricUpdateResult {
  readonly metric: StoredHealthMetric;
  readonly audit: StoredMetricAuditEvent & {
    readonly previous: StoredHealthMetric;
    readonly next: StoredHealthMetric;
  };
  readonly traceEvents: readonly StoredHealthTraceEvent[];
}

export function createHealthMetric(db: Database.Database, input: HealthMetricInput): CreateHealthMetricResult;
export function updateHealthMetric(db: Database.Database, input: HealthMetricUpdateInput): HealthMetricUpdateResult;
export function queryHealthMetrics(db: Database.Database, query: HealthMetricQuery): StoredHealthMetric[];
export function importHealthMetricsCsv(db: Database.Database, input: HealthMetricCsvImportInput): HealthMetricCsvImportResult;
export function exportHealthMetricsCsvRows(metrics: readonly StoredHealthMetric[]): string;
```

Use one transaction for metric update, metric audit insert, and health trace insert. Return `audit.id` and previous/next payloads so CLI/API callers can cite the correction.

- [ ] **Step 4: Add API contract and handler support**

Update `ApiMethod` in `src/api/contracts.ts` to include `PATCH`.

Use the literal `PATCH /api/health/metrics` route for metric updates. Do not add a path-parameter update route in this slice; the current route adapter passes the configured path string and does not expose Next dynamic route params. Put `id` in the JSON body so `createApiRouteHandler("PATCH", "/api/health/metrics")` remains executable with the existing adapter.

Add route IDs and route matching:

```ts
export const API_ROUTE_IDS = [
  // existing IDs,
  "health.metrics.create",
  "health.metrics.list",
  "health.metrics.update",
  "health.metrics.import"
] as const;
```

Handler parse functions:

```ts
interface HealthMetricCreateBody {
  metricKey: string;
  metricLabel: string;
  value: number;
  unit: string;
  observedAt: string;
  note?: string;
}

interface HealthMetricUpdateBody {
  id: number;
  metricKey?: string;
  metricLabel?: string;
  value?: number;
  unit?: string;
  observedAt?: string;
  note?: string;
  reason: string;
}

interface HealthMetricImportBody {
  sourceFilename: string;
  csvText: string;
}
```

Return existing envelopes:

```ts
return successResponse("health.metrics.update", { result });
```

- [ ] **Step 5: Add route wrappers**

Create:

```ts
// src/app/api/health/metrics/route.ts
import { createApiRouteHandler } from "../../_shared/route-adapter.js";

export const runtime = "nodejs";
export const POST = createApiRouteHandler("POST", "/api/health/metrics");
export const GET = createApiRouteHandler("GET", "/api/health/metrics");
export const PATCH = createApiRouteHandler("PATCH", "/api/health/metrics");
```

```ts
// src/app/api/health/metrics/import/route.ts
import { createApiRouteHandler } from "../../../_shared/route-adapter.js";

export const runtime = "nodejs";
export const POST = createApiRouteHandler("POST", "/api/health/metrics/import");
```

If the relative import depth differs in the checkout, fix the import to match existing route files and keep the wrapper body this small.

- [ ] **Step 6: Add CLI commands**

Extend `KlCommandResult` with `KlHealthMetricCommandResult` and add command dispatch:

```ts
if (command === "health-metric") {
  return runHealthMetricCommand(args);
}
```

Command output shape:

```ts
export interface KlHealthMetricCommandResult {
  readonly command: "health-metric";
  readonly mode: "mock-persistent";
  readonly action: "add" | "list" | "update" | "import-csv";
  readonly result: unknown;
}
```

Require `--db` for every action. Open read-only for `list`; open writable with `fileMustExist: true` for update/import when tests create the DB first.

- [ ] **Step 7: Verify focused tests pass**

Run:

```powershell
npm run test:unit -- src/health-extensions/metrics.test.ts src/health-extensions/store.test.ts
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Expected: PASS. Tests prove metric update audit, API/CLI correction output, and CSV round-trip.

- [ ] **Step 8: Run broader checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 9: Write checkpoint**

Write `.ai/checkpoints/part-m4-health-metrics-api-cli/step-1.md` with files modified, tests run, and the statement: "Metric update audit and health trace proof are implemented in this slice."

- [ ] **Step 10: Commit and push this slice**

Run:

```powershell
git status --short
git add src/health-extensions/metrics.ts src/health-extensions/metrics.test.ts src/health-extensions/store.ts src/health-extensions/store.test.ts src/api/contracts.ts src/api/contracts.test.ts src/api/handlers.ts src/api/handlers.test.ts src/app/api/health/metrics/route.ts src/app/api/health/metrics/import/route.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.ts src/cli/kl.test.ts .ai/checkpoints/part-m4-health-metrics-api-cli/step-1.md
git commit -m "feat: add health metrics api cli"
git push -u origin HEAD
```

Expected: commit and push succeed after reviewers approve.

---

## Task 3: Exercise Template, Plan, Session Completion, CLI, And API

**Task id:** `part-m4-health-exercise`

**Files:**
- Create: `src/health-extensions/exercise.ts`
- Create: `src/health-extensions/exercise.test.ts`
- Modify: `src/health-extensions/store.ts`
- Modify: `src/health-extensions/store.test.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/api/contracts.test.ts`
- Modify: `src/api/handlers.ts`
- Modify: `src/api/handlers.test.ts`
- Create: `src/app/api/health/exercise/templates/route.ts`
- Create: `src/app/api/health/exercise/plans/route.ts`
- Create: `src/app/api/health/exercise/sessions/complete/route.ts`
- Create: `src/app/api/health/exercise/completion/route.ts`
- Modify: `src/app/api/_shared/route-adapter.test.ts`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create checkpoint: `.ai/checkpoints/part-m4-health-exercise/step-1.md`

- [ ] **Step 1: Write failing exercise tests**

Cover template creation, duplicate slug update behavior, Monday `weekStart`, duplicate active plan rejection, session completion, ad hoc session logging, completion rate `{planned, completed, missed, rate}`, and no partial writes.

Required signatures:

```ts
export interface ExerciseTemplateInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly defaultDays: readonly ExerciseTemplateDayInput[];
  readonly active?: boolean;
}

export interface ExerciseTemplateDayInput {
  readonly sessionKey: string;
  readonly dayOffset: number;
  readonly title: string;
  readonly targetMinutes?: number;
  readonly targetReps?: number;
}

export function createExerciseTemplate(db: Database.Database, input: ExerciseTemplateInput): ExerciseTemplateResult;
export function createExercisePlanFromTemplate(db: Database.Database, input: ExercisePlanCreateInput): ExercisePlanResult;
export function completeExerciseSession(db: Database.Database, input: ExerciseSessionCompletionInput): ExerciseSessionCompletionResult;
export function queryExerciseCompletion(db: Database.Database, query: ExerciseCompletionQuery): ExerciseCompletionSummary;
```

Run: `npm run test:unit -- src/health-extensions/exercise.test.ts`

Expected: FAIL because `exercise.ts` does not exist.

- [ ] **Step 2: Write failing API and CLI tests**

Add route IDs:

```ts
"health.exercise.templates.create"
"health.exercise.plans.create"
"health.exercise.sessions.complete"
"health.exercise.completion"
```

Add CLI cases:

```powershell
npm run kl -- health-exercise template create --db .ai/tmp/m4-health/exercise.db --slug starter-strength --name "Starter Strength" --day 0:push:Push:20
npm run kl -- health-exercise plan create --db .ai/tmp/m4-health/exercise.db --template starter-strength --week-start 2026-06-15
npm run kl -- health-exercise complete --db .ai/tmp/m4-health/exercise.db --session-id 1 --completed-at 2026-06-15T09:00:00.000Z --duration-minutes 20 --intensity moderate
npm run kl -- health-exercise completion --db .ai/tmp/m4-health/exercise.db --from 2026-06-15 --to 2026-06-22
```

Run:

```powershell
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Expected: FAIL with missing routes and commands.

- [ ] **Step 3: Implement exercise domain and store methods**

Add store helpers for templates, plans, sessions, and completion reads. Use JSON parsing for `default_days` only in `store.ts`; domain callers receive typed DTOs.

Completion-rate rule:

```ts
const rate = planned === 0 ? 0 : completed / planned;
```

Count only planned sessions in the denominator. Include ad hoc sessions in `adHocSessions` but do not count them unless attached to a plan session.

- [ ] **Step 4: Add API handlers and route wrappers**

Handler bodies:

```ts
interface ExerciseTemplateCreateBody {
  slug: string;
  name: string;
  description?: string;
  defaultDays: ExerciseTemplateDayInput[];
}

interface ExercisePlanCreateBody {
  templateSlug: string;
  weekStart: string;
}

interface ExerciseSessionCompleteBody {
  sessionId?: number;
  planId?: number;
  templateSessionKey?: string;
  completedAt: string;
  durationMinutes?: number;
  intensity?: "low" | "moderate" | "high";
  note?: string;
}
```

Return `routeId` matching the new manifest IDs.

- [ ] **Step 5: Add CLI command parser**

Add `health-exercise` subactions with strict mutually exclusive modes:

- `template create`
- `plan create`
- `complete`
- `completion`

Reject mixed create/completion flags before opening the DB, matching existing CLI validation style.

- [ ] **Step 6: Verify focused tests pass**

Run:

```powershell
npm run test:unit -- src/health-extensions/exercise.test.ts src/health-extensions/store.test.ts
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run broader checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 8: Write checkpoint**

Write `.ai/checkpoints/part-m4-health-exercise/step-1.md` recording completion-rate proof and commands.

- [ ] **Step 9: Commit and push this slice**

Run:

```powershell
git status --short
git add src/health-extensions/exercise.ts src/health-extensions/exercise.test.ts src/health-extensions/store.ts src/health-extensions/store.test.ts src/api/contracts.ts src/api/contracts.test.ts src/api/handlers.ts src/api/handlers.test.ts src/app/api/health/exercise/templates/route.ts src/app/api/health/exercise/plans/route.ts src/app/api/health/exercise/sessions/complete/route.ts src/app/api/health/exercise/completion/route.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.ts src/cli/kl.test.ts .ai/checkpoints/part-m4-health-exercise/step-1.md
git commit -m "feat: add health exercise planning"
git push -u origin HEAD
```

Expected: commit and push succeed after reviewers approve.

---

## Task 4: Sedentary Span Ingestion, Streaks, And Reminder Engine

**Task id:** `part-m4-health-sedentary`

**Files:**
- Create: `src/health-extensions/sedentary.ts`
- Create: `src/health-extensions/sedentary.test.ts`
- Create: `src/health-extensions/windows-logger-contract.ts`
- Create: `src/health-extensions/windows-logger-contract.test.ts`
- Modify: `src/health-extensions/store.ts`
- Modify: `src/health-extensions/store.test.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/api/contracts.test.ts`
- Modify: `src/api/handlers.ts`
- Modify: `src/api/handlers.test.ts`
- Create: `src/app/api/health/sedentary/spans/route.ts`
- Create: `src/app/api/health/sedentary/summary/route.ts`
- Create: `src/app/api/health/break-reminders/evaluate/route.ts`
- Modify: `src/app/api/_shared/route-adapter.test.ts`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create checkpoint: `.ai/checkpoints/part-m4-health-sedentary/step-1.md`

- [ ] **Step 1: Write failing sedentary tests**

Cover invalid intervals, source-id dedupe, active break splitting, unknown-gap merging only when configured, streak duration, reminder threshold `60`, cooldown idempotency, and deterministic reminder records.

Required signatures:

```ts
export interface SedentarySpanInput {
  readonly sourceId?: string;
  readonly spanStart: string;
  readonly spanEnd: string;
  readonly state: "active" | "idle" | "unknown";
  readonly confidence?: number;
}

export interface SedentarySummaryOptions {
  readonly from: string;
  readonly to: string;
  readonly activeBreakMinutes?: number;
  readonly unknownGapMergeMinutes?: number;
}

export function ingestSedentarySpan(db: Database.Database, input: SedentarySpanInput): SedentarySpanIngestResult;
export function computeSedentarySummary(db: Database.Database, options: SedentarySummaryOptions): SedentarySummary;
export function evaluateBreakReminders(db: Database.Database, input: BreakReminderEvaluationInput): BreakReminderEvaluationResult;
```

Run: `npm run test:unit -- src/health-extensions/sedentary.test.ts src/health-extensions/windows-logger-contract.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 2: Write failing API and CLI tests**

Add route IDs:

```ts
"health.sedentary.spans.ingest"
"health.sedentary.summary"
"health.break-reminders.evaluate"
```

CLI cases:

```powershell
npm run kl -- health-sedentary ingest-span --db .ai/tmp/m4-health/sedentary.db --source-id fixture-1 --start 2026-06-14T08:00:00.000Z --end 2026-06-14T09:05:00.000Z --state idle --confidence 0.95
npm run kl -- health-sedentary summary --db .ai/tmp/m4-health/sedentary.db --from 2026-06-14T08:00:00.000Z --to 2026-06-14T10:00:00.000Z
npm run kl -- health-break-reminder evaluate --db .ai/tmp/m4-health/sedentary.db --from 2026-06-14T08:00:00.000Z --to 2026-06-14T10:00:00.000Z --threshold-minutes 60
```

Expected focused API/CLI tests fail before implementation.

- [ ] **Step 3: Implement Windows logger contract validator**

Create `src/health-extensions/windows-logger-contract.ts`:

```ts
export interface WindowsLoggerSpanPost {
  readonly sourceId?: string;
  readonly spanStart: string;
  readonly spanEnd: string;
  readonly state: "active" | "idle" | "unknown";
  readonly confidence?: number;
}

export interface WindowsLoggerHeartbeat {
  readonly loggerId: string;
  readonly observedAt: string;
  readonly version: string;
  readonly idleApi: "windows-get-last-input-info";
}

export function parseWindowsLoggerSpanPost(value: unknown): WindowsLoggerSpanPost;
export function parseWindowsLoggerHeartbeat(value: unknown): WindowsLoggerHeartbeat;
```

Reject negative or zero-length spans and confidence outside `0..1`.

- [ ] **Step 4: Implement sedentary engine**

Persist spans first, compute streak projections, then persist reminder eligibility records. The engine must be deterministic for the same span set and threshold.

Reminder result shape:

```ts
export interface BreakReminderEvaluationResult {
  readonly thresholdMinutes: number;
  readonly evaluatedStreaks: number;
  readonly createdReminders: readonly StoredBreakReminder[];
  readonly existingReminders: readonly StoredBreakReminder[];
  readonly traceEvents: readonly StoredHealthTraceEvent[];
}
```

- [ ] **Step 5: Add API handlers, route wrappers, and CLI commands**

Use bearer auth for all routes. `GET /api/health/sedentary/summary` requires `from` and `to`.

Add `health-sedentary` and `health-break-reminder` command results to `KlCommandResult`.

- [ ] **Step 6: Verify focused tests pass**

Run:

```powershell
npm run test:unit -- src/health-extensions/sedentary.test.ts src/health-extensions/windows-logger-contract.test.ts src/health-extensions/store.test.ts
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Expected: PASS, including a fixture idle span of at least 60 minutes producing one eligible reminder.

- [ ] **Step 7: Run broader checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 8: Write checkpoint**

Write `.ai/checkpoints/part-m4-health-sedentary/step-1.md` recording deterministic reminder proof and stating that native Windows notification proof remains Task 6.

- [ ] **Step 9: Commit and push this slice**

Run:

```powershell
git status --short
git add src/health-extensions/sedentary.ts src/health-extensions/sedentary.test.ts src/health-extensions/windows-logger-contract.ts src/health-extensions/windows-logger-contract.test.ts src/health-extensions/store.ts src/health-extensions/store.test.ts src/api/contracts.ts src/api/contracts.test.ts src/api/handlers.ts src/api/handlers.test.ts src/app/api/health/sedentary/spans/route.ts src/app/api/health/sedentary/summary/route.ts src/app/api/health/break-reminders/evaluate/route.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.ts src/cli/kl.test.ts .ai/checkpoints/part-m4-health-sedentary/step-1.md
git commit -m "feat: add sedentary reminder engine"
git push -u origin HEAD
```

Expected: commit and push succeed after reviewers approve.

---

## Task 5: Coach Digest Dry-Run, API, CLI, And Compass HTTP Client

**Task id:** `part-m4-health-coach-digest`

**Files:**
- Create: `src/health-extensions/compass-client.ts`
- Create: `src/health-extensions/compass-client.test.ts`
- Create: `src/health-extensions/coach-digest.ts`
- Create: `src/health-extensions/coach-digest.test.ts`
- Modify: `src/health-extensions/store.ts`
- Modify: `src/health-extensions/store.test.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/api/contracts.test.ts`
- Modify: `src/api/handlers.ts`
- Modify: `src/api/handlers.test.ts`
- Create: `src/app/api/health/coach-digest/generate/route.ts`
- Modify: `src/app/api/_shared/route-adapter.test.ts`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create checkpoint: `.ai/checkpoints/part-m4-health-coach-digest/step-1.md`

- [ ] **Step 1: Write failing compass-client tests**

Test URL validation:

```ts
expect(() => createCompassHealthClient({ baseUrl: "file:///C:/Users/Holly/compass-health/db.sqlite" })).toThrow();
expect(() => createCompassHealthClient({ baseUrl: "C:\\Users\\Holly\\compass-health" })).toThrow();
expect(() => createCompassHealthClient({ baseUrl: "https://user:pass@example.test" })).toThrow();
```

Test mock fetch reads only HTTP(S) URLs and redacts bearer values from thrown messages.

Run: `npm run test:unit -- src/health-extensions/compass-client.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Write failing digest tests**

Create digest tests with seeded metrics, exercise completion, sedentary reminder, and offline compass context.

Required signatures:

```ts
export interface CoachDigestGenerateInput {
  readonly date: string;
  readonly compass?: {
    readonly baseUrl: string;
    readonly bearerToken?: string;
    readonly fetch: typeof fetch;
  };
  readonly offline?: boolean;
  readonly now?: string;
  readonly runId?: string;
}

export interface CoachDigestSnapshotResult {
  readonly snapshot: StoredCoachDigestSnapshot;
  readonly renderedMarkdown: string;
  readonly sourceHash: string;
  readonly traceEvents: readonly StoredHealthTraceEvent[];
}

export function generateCoachDigestSnapshot(db: Database.Database, input: CoachDigestGenerateInput): CoachDigestSnapshotPromise;
export type CoachDigestSnapshotPromise = Promise resolving to CoachDigestSnapshotResult;
```

Assert:

- output includes metric, exercise, sedentary, and compass availability sections
- same inputs produce same `sourceHash`
- offline mode marks compass context unavailable without network
- no LLM key is required

Run: `npm run test:unit -- src/health-extensions/coach-digest.test.ts`

Expected: FAIL before implementation.

- [ ] **Step 3: Add API and CLI tests**

Add route ID:

```ts
"health.coach-digest.generate"
```

Add CLI:

```powershell
npm run kl -- health-coach-digest --db .ai/tmp/m4-health/coach.db --date 2026-06-14 --dry-run
npm run kl -- health-coach-digest --db .ai/tmp/m4-health/coach.db --date 2026-06-14 --dry-run --offline
```

Expected output shape:

```json
{
  "command": "health-coach-digest",
  "mode": "dry-run",
  "result": {
    "snapshot": {
      "date": "2026-06-14",
      "publishedAt": null
    },
    "renderedMarkdown": "..."
  }
}
```

- [ ] **Step 4: Implement compass HTTP client**

Create `src/health-extensions/compass-client.ts`:

```ts
export interface CompassHealthClientOptions {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly fetch: typeof fetch;
}

export interface CompassHealthDailyContext {
  readonly sourceUrl: string;
  readonly meals?: unknown;
  readonly unavailableReason?: string;
}

export function createCompassHealthClient(options: CompassHealthClientOptions): {
  readonly readDailyContext: CompassHealthDailyContextReader;
};
export type CompassHealthDailyContextReader = (date: string) => Promise resolving to CompassHealthDailyContext;
```

Only construct URLs from `http:` or `https:` base URLs without credentials.

- [ ] **Step 5: Implement digest generator**

Render deterministic markdown from existing health helpers. Store a digest snapshot with `published_at = null`.

Required markdown headings:

```md
# Coach daily health digest
Date: 2026-06-14
## Metrics
## Exercise
## Sedentary
## Compass context
```

Compute `sourceHash` from normalized JSON inputs, not from rendered text.

- [ ] **Step 6: Add API, route wrapper, and CLI**

API body:

```ts
interface CoachDigestGenerateBody {
  date: string;
  offline?: boolean;
  compassBaseUrl?: string;
}
```

Route wrapper:

```ts
import { createApiRouteHandler } from "../../../_shared/route-adapter.js";

export const runtime = "nodejs";
export const POST = createApiRouteHandler("POST", "/api/health/coach-digest/generate");
```

CLI must reject live publish flags in this task. Publishing is Task 8.

- [ ] **Step 7: Verify focused tests pass**

Run:

```powershell
npm run test:unit -- src/health-extensions/compass-client.test.ts src/health-extensions/coach-digest.test.ts src/health-extensions/store.test.ts
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run broader checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 9: Write checkpoint**

Write `.ai/checkpoints/part-m4-health-coach-digest/step-1.md` recording offline digest proof and HTTP-only compass proof.

- [ ] **Step 10: Commit and push this slice**

Run:

```powershell
git status --short
git add src/health-extensions/compass-client.ts src/health-extensions/compass-client.test.ts src/health-extensions/coach-digest.ts src/health-extensions/coach-digest.test.ts src/health-extensions/store.ts src/health-extensions/store.test.ts src/api/contracts.ts src/api/contracts.test.ts src/api/handlers.ts src/api/handlers.test.ts src/app/api/health/coach-digest/generate/route.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.ts src/cli/kl.test.ts .ai/checkpoints/part-m4-health-coach-digest/step-1.md
git commit -m "feat: add coach health digest dry run"
git push -u origin HEAD
```

Expected: commit and push succeed after reviewers approve.

---

## Task 6: Windows Logger And Live Alert Evidence

**Task id:** `part-m4-health-windows-logger-live`

**Files:**
- Create: `src/health-extensions/windows-logger.ts`
- Create: `src/health-extensions/windows-logger.test.ts`
- Create: `src/health-extensions/live-evidence.ts`
- Create: `src/health-extensions/live-evidence.test.ts`
- Modify: `src/health-extensions/windows-logger-contract.ts`
- Modify: `src/health-extensions/windows-logger-contract.test.ts`
- Create: `scripts/health-windows-logger.ts`
- Create: `config/health/windows-logger.example.json`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create: `docs/runbooks/m4-health-windows-logger.md`
- Create: `config/health/windows-logger-evidence.example.json`
- Create checkpoint: `.ai/checkpoints/part-m4-health-windows-logger-live/step-1.md`

- [ ] **Step 1: Write failing logger implementation tests**

Create `src/health-extensions/windows-logger.test.ts` with deterministic tests for:

- polling idle state through an injected `IdleStateProvider`
- opening an `idle` span when idle duration crosses the configured threshold
- closing an `idle` span when active input resumes
- posting spans to the configured health API endpoint with bearer auth
- posting heartbeat records at the configured interval
- surviving sleep/wake by closing the previous span and posting a `logger_recovered_after_gap` heartbeat when the elapsed poll gap exceeds `sleepWakeGapMs`
- triggering a visible alert through an injected `VisibleAlertClient` when the API returns an eligible reminder
- rendering a Windows startup registration command without executing it

Required test snippet:

```ts
test("posts idle span and visible alert when reminder is eligible", async () => {
  const posts: unknown[] = [];
  const alerts: string[] = [];
  const logger = createWindowsHealthLogger({
    config: {
      loggerId: "fixture-logger",
      pollIntervalMs: 1000,
      idleThresholdMs: 60000,
      sleepWakeGapMs: 300000,
      heartbeatIntervalMs: 60000,
      healthApiBaseUrl: "http://127.0.0.1:3000",
      bearerToken: "secret",
      visibleAlert: { channel: "stdout", title: "Break reminder" }
    },
    idleStateProvider: scriptedIdleProvider([
      { now: "2026-06-14T08:00:00.000Z", idleMs: 0 },
      { now: "2026-06-14T09:01:00.000Z", idleMs: 61000 },
      { now: "2026-06-14T09:02:00.000Z", idleMs: 0 }
    ]),
    spanPoster: async (span) => {
      posts.push(span);
      return { reminderEligible: true, reminderText: "Stand up" };
    },
    heartbeatPoster: async () => undefined,
    visibleAlertClient: { show: async (alert) => alerts.push(alert.body) }
  });
  await logger.tick();
  await logger.tick();
  await logger.tick();
  expect(posts).toHaveLength(1);
  expect(alerts).toEqual(["Stand up"]);
});
```

Required exported signatures:

```ts
export interface WindowsLoggerConfig {
  readonly loggerId: string;
  readonly pollIntervalMs: number;
  readonly idleThresholdMs: number;
  readonly sleepWakeGapMs: number;
  readonly heartbeatIntervalMs: number;
  readonly healthApiBaseUrl: string;
  readonly bearerToken?: string;
  readonly visibleAlert: {
    readonly channel: "stdout" | "powershell";
    readonly title: string;
  };
}

export interface IdleStateProvider {
  readonly read: IdleStateReader;
}

export interface VisibleAlertClient {
  readonly show: VisibleAlertShow;
}

export type IdleStateReader = () => Promise resolving to { readonly now: string; readonly idleMs: number };
export type VisibleAlertShow = (alert: { readonly title: string; readonly body: string }) => Promise resolving to void;
export function createWindowsHealthLogger(options: WindowsHealthLoggerOptions): WindowsHealthLogger;
export function renderWindowsLoggerStartupCommand(input: WindowsLoggerStartupCommandInput): string;
export function loadWindowsLoggerConfig(value: unknown): WindowsLoggerConfig;
```

Run: `npm run test:unit -- src/health-extensions/windows-logger.test.ts`

Expected: FAIL because `windows-logger.ts` does not exist.

- [ ] **Step 2: Write failing logger CLI and script tests**

Add `src/cli/kl.test.ts` cases for:

```powershell
npm run kl -- health-windows-logger config-check --config config/health/windows-logger.example.json
npm run kl -- health-windows-logger startup-command --config config/health/windows-logger.example.json --script scripts/health-windows-logger.ts
```

Expected `startup-command` output contains `schtasks /Create`, `health-windows-logger`, the config path, and the script path. The command must not execute registration.

Create `scripts/health-windows-logger.ts` as the repo-owned script entrypoint that loads config, creates the real idle provider, starts the polling loop, and keeps the process alive. Tests do not run the infinite loop; tests import only pure helpers from `src/health-extensions/windows-logger.ts`.

Run: `npm run test:unit -- src/cli/kl.test.ts`

Expected: FAIL with unknown command.

- [ ] **Step 3: Write failing evidence validator tests**

Create tests requiring:

- `contractStatus: "observed_live_alert_pending_review"`
- logger started by Windows startup evidence generated from the startup command
- sleep/wake survival evidence
- at least one idle span with `durationMinutes >= 60`
- a break reminder recorded within 5 minutes of eligibility
- notification or visible alert evidence with timestamp and channel
- span source references the repo-owned logger id
- no secret-like values
- no filesystem paths into frozen repos

Required signature:

```ts
export interface HealthLiveEvidenceValidationResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly summary?: {
    readonly longestSedentaryMinutes: number;
    readonly reminderDelayMinutes: number;
    readonly liveGate: "windows_logger_alert_observed";
  };
}

export function validateWindowsLoggerLiveEvidence(value: unknown): HealthLiveEvidenceValidationResult;
```

Run: `npm run test:unit -- src/health-extensions/live-evidence.test.ts`

Expected: FAIL before implementation.

- [ ] **Step 4: Write failing CLI evidence tests**

Add CLI:

```powershell
npm run kl -- health-live-evidence windows-logger --dry-run --evidence config/health/windows-logger-evidence.example.json
```

Expected output:

```json
{
  "command": "health-live-evidence",
  "mode": "dry-run",
  "result": {
    "kind": "windows-logger",
    "status": "observed_evidence_valid",
    "valid": true
  }
}
```

Run: `npm run test:unit -- src/cli/kl.test.ts`

Expected: FAIL with unknown command.

- [ ] **Step 5: Implement logger config, polling loop, startup command, and visible alert**

Create `src/health-extensions/windows-logger.ts` with:

```ts
export interface WindowsHealthLogger {
  readonly tick: WindowsLoggerAsyncVoid;
  readonly start: WindowsLoggerAsyncVoid;
  readonly stop: WindowsLoggerAsyncVoid;
}

export interface WindowsHealthLoggerOptions {
  readonly config: WindowsLoggerConfig;
  readonly idleStateProvider: IdleStateProvider;
  readonly spanPoster: WindowsLoggerSpanPoster;
  readonly heartbeatPoster: WindowsLoggerHeartbeatPoster;
  readonly visibleAlertClient: VisibleAlertClient;
}

export interface WindowsLoggerSpanPoster {
  readonly post: WindowsLoggerSpanPostFn;
}

export interface WindowsLoggerHeartbeatPoster {
  readonly post: WindowsLoggerHeartbeatPostFn;
}

export type WindowsLoggerAsyncVoid = () => Promise resolving to void;
export type WindowsLoggerSpanPostFn = (span: WindowsLoggerSpanPost) => Promise resolving to WindowsLoggerSpanPostResult;
export type WindowsLoggerHeartbeatPostFn = (heartbeat: WindowsLoggerHeartbeat) => Promise resolving to void;
export interface WindowsLoggerSpanPostResult {
  readonly reminderEligible: boolean;
  readonly reminderText?: string;
}
```

Implement the default HTTP poster with `fetch` and the existing bearer header convention. Implement the default visible alert client with two channels:

- `stdout`: writes a single-line alert body for deterministic local runs.
- `powershell`: invokes a PowerShell notification command only when the script runs live; tests inject `VisibleAlertClient` and do not spawn processes.

Implement `renderWindowsLoggerStartupCommand` as a pure string builder:

```ts
export function renderWindowsLoggerStartupCommand(input: WindowsLoggerStartupCommandInput): string {
  return [
    "schtasks",
    "/Create",
    "/TN",
    "knowledge-loop-health-windows-logger",
    "/SC",
    "ONLOGON",
    "/TR",
    `"npm exec tsx ${input.scriptPath} -- --config ${input.configPath}"`,
    "/F"
  ].join(" ");
}
```

The CLI prints this command for manual execution; it does not register startup by itself.

- [ ] **Step 6: Implement live evidence validator**

Create `src/health-extensions/live-evidence.ts` and include explicit checks for the live gate. Reject fake closure fields such as `m4Complete`, `closed`, or `done`.

Accepted evidence shape:

```json
{
  "contractStatus": "observed_live_alert_pending_review",
  "evidenceMode": "live-observation",
  "date": "2026-06-14",
  "logger": {
    "loggerId": "fixture-logger",
    "startupObserved": true,
    "startupCommand": "schtasks /Create /TN knowledge-loop-health-windows-logger /SC ONLOGON /TR \"npm exec tsx scripts/health-windows-logger.ts -- --config config/health/windows-logger.example.json\" /F",
    "sleepWakeSurvived": true,
    "version": "health-windows-logger/0.1.0"
  },
  "sedentaryStreak": {
    "windowStart": "2026-06-14T08:00:00.000Z",
    "windowEnd": "2026-06-14T09:05:00.000Z",
    "durationMinutes": 65,
    "source": "windows-logger"
  },
  "breakReminder": {
    "eligibleAt": "2026-06-14T09:00:00.000Z",
    "recordedAt": "2026-06-14T09:03:00.000Z",
    "deliveryChannel": "windows-notification",
    "visibleAlertObserved": true
  }
}
```

- [ ] **Step 7: Add config, script entrypoint, runbook, and evidence sample**

Create `config/health/windows-logger.example.json`:

```json
{
  "loggerId": "knowledge-loop-windows",
  "pollIntervalMs": 30000,
  "idleThresholdMs": 60000,
  "sleepWakeGapMs": 300000,
  "heartbeatIntervalMs": 300000,
  "healthApiBaseUrl": "http://127.0.0.1:3000",
  "visibleAlert": {
    "channel": "stdout",
    "title": "Break reminder"
  }
}
```

Create `docs/runbooks/m4-health-windows-logger.md` with exact proof steps:

```powershell
npm run kl -- health-windows-logger config-check --config config/health/windows-logger.example.json
npm run kl -- health-windows-logger startup-command --config config/health/windows-logger.example.json --script scripts/health-windows-logger.ts
npm exec tsx scripts/health-windows-logger.ts -- --config config/health/windows-logger.example.json
npm run kl -- health-sedentary ingest-span --db .ai/tmp/m4-health/live.db --source-id live-20260614-090000 --start 2026-06-14T08:00:00.000Z --end 2026-06-14T09:05:00.000Z --state idle --confidence 1
npm run kl -- health-break-reminder evaluate --db .ai/tmp/m4-health/live.db --from 2026-06-14T08:00:00.000Z --to 2026-06-14T10:00:00.000Z --threshold-minutes 60
npm run kl -- health-live-evidence windows-logger --dry-run --evidence config/health/windows-logger-evidence.example.json
```

The runbook must state that deterministic logger tests and deterministic reminder records do not close the live gate until a real logger run records startup, sleep/wake survival, an at least 60-minute streak, and a visible break alert.

- [ ] **Step 8: Add CLI commands**

Add `health-live-evidence windows-logger --dry-run --evidence config/health/windows-logger-evidence.example.json`. Use existing checkout-path JSON loading rules so the evidence file stays inside this repository.

Add `health-windows-logger config-check --config config/health/windows-logger.example.json` and `health-windows-logger startup-command --config config/health/windows-logger.example.json --script scripts/health-windows-logger.ts`. Both commands are local dry-run/config commands and must not start a background process.

- [ ] **Step 9: Verify focused tests pass**

Run:

```powershell
npm run test:unit -- src/health-extensions/windows-logger.test.ts src/health-extensions/live-evidence.test.ts src/health-extensions/windows-logger-contract.test.ts src/cli/kl.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run broader checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 11: Write checkpoint**

Write `.ai/checkpoints/part-m4-health-windows-logger-live/step-1.md` recording the repo-owned logger implementation, config/startup command path, visible alert path, validator/runbook/evidence work, tests run, and live evidence status.

- [ ] **Step 12: Commit and push this slice**

Run:

```powershell
git status --short
git add src/health-extensions/windows-logger.ts src/health-extensions/windows-logger.test.ts src/health-extensions/live-evidence.ts src/health-extensions/live-evidence.test.ts src/health-extensions/windows-logger-contract.ts src/health-extensions/windows-logger-contract.test.ts scripts/health-windows-logger.ts config/health/windows-logger.example.json src/cli/kl.ts src/cli/kl.test.ts docs/runbooks/m4-health-windows-logger.md config/health/windows-logger-evidence.example.json .ai/checkpoints/part-m4-health-windows-logger-live/step-1.md
git commit -m "feat: add health windows logger companion"
git push -u origin HEAD
```

Expected: commit and push succeed after reviewers approve.

---

## Task 7: Coach Dry-Run And Report Renderer

**Task id:** `part-m4-health-coach-dry-run`

**Files:**
- Create: `src/agents/coach-report.ts`
- Create: `src/agents/coach-report.test.ts`
- Modify: `src/agents/dry-run.ts`
- Modify: `src/agents/dry-run.test.ts`
- Modify: `src/agents/profiles.ts`
- Modify: `src/agents/profiles.test.ts`
- Modify: `src/agents/config.ts`
- Modify: `src/agents/config.test.ts`
- Modify: `config/agents.example.json`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create checkpoint: `.ai/checkpoints/part-m4-health-coach-dry-run/step-1.md`

- [ ] **Step 1: Write failing Coach dry-run tests**

Update `src/agents/dry-run.test.ts`, `src/agents/profiles.test.ts`, `src/agents/config.test.ts`, and `src/cli/kl.test.ts` to require:

- `AGENT_ROLES` equals `["librarian", "scholar", "nutritionist", "coach"]`.
- `AGENT_PHASES` contains `daily-health`.
- `createAgentDryRunPlan({ role: "coach", phase: "daily-health", date: "2026-06-14" })` reads `POST http://127.0.0.1:3000/api/health/coach-digest/generate` with JSON body `{ date: "2026-06-14", offline: true }`.
- Coach dry-run intended action title is `Coach health digest for 2026-06-14`.
- Coach dry-run keeps `externalWrites: []`.
- `agent-day --dry-run` sequence includes Coach after Nutritionist and before the evening Scholar mastery report.
- `config/agents.example.json` includes only non-secret Coach dry-run defaults.

Run:

```powershell
npm run test:unit -- src/agents/dry-run.test.ts src/agents/profiles.test.ts src/agents/config.test.ts src/cli/kl.test.ts
```

Expected: FAIL before implementation.

- [ ] **Step 2: Write failing Coach report renderer tests**

Create `src/agents/coach-report.test.ts` requiring:

```ts
expect(renderCoachHealthDigestBody({
  ok: true,
  routeId: "health.coach-digest.generate",
  data: {
    result: {
      renderedMarkdown: "# Coach daily health digest\nDate: 2026-06-14\n",
      snapshot: { id: 1, date: "2026-06-14", publishedAt: null }
    }
  }
}, { date: "2026-06-14", sourceEndpointLabel: "POST /api/health/coach-digest/generate" }))
  .toContain("Coach daily health digest");
```

Also require `CoachReportRenderError` for wrong `routeId`, missing `renderedMarkdown`, blank `date`, non-object bodies, and secret-like text in the digest body.

Run: `npm run test:unit -- src/agents/coach-report.test.ts`

Expected: FAIL because the renderer does not exist.

- [ ] **Step 3: Add Coach dry-run role**

Update `src/agents/dry-run.ts`:

```ts
export const AGENT_ROLES = ["librarian", "scholar", "nutritionist", "coach"] as const;
export const AGENT_PHASES = ["nightly-ingest", "morning-plan", "evening-mastery", "daily-meals", "daily-health"] as const;
```

Add `coach: ["daily-health"]` in role phases. Add Coach external read:

```ts
{
  method: "POST",
  url: `${knowledgeLoopBaseUrl}/api/health/coach-digest/generate`,
  purpose: "Generate the deterministic daily health digest for Coach.",
  jsonBody: { date: input.date, offline: true }
}
```

Add intended action:

```ts
{
  target: "multica",
  type: "add_comment",
  title: `Coach health digest for ${input.date}`,
  body: `Dry-run target board: ${multicaBoard}.\nWhen live, Coach posts metrics, exercise, sedentary, and compass HTTP context.`,
  checklist: ["Generate health digest", "Post digest", "Record source hash"],
  sourceEndpoints
}
```

- [ ] **Step 4: Add Coach profile and config support**

Add `coach` to `config/agents.example.json`:

```json
"coach": {
  "dryRun": true,
  "phases": ["daily-health"]
}
```

Update `src/agents/profiles.ts` with `knowledge-loop-coach`; prompt text must say Coach uses health-extensions APIs and must not read or write compass-health files. Update `src/agents/config.ts` role and phase validation to accept `coach` and `daily-health`.

- [ ] **Step 5: Add Coach report renderer**

Create `src/agents/coach-report.ts`:

```ts
export class CoachReportRenderError extends Error {}

export interface CoachReportRenderContext {
  readonly date: string;
  readonly sourceEndpointLabel?: string;
}

export function renderCoachHealthDigestBody(summaryBody: unknown, context: CoachReportRenderContext): string;
```

The renderer must require `ok: true`, `routeId: "health.coach-digest.generate"`, and `data.result.renderedMarkdown`. It returns a redaction-safe body that includes the source endpoint label and the rendered markdown.

- [ ] **Step 6: Verify focused tests pass**

Run:

```powershell
npm run test:unit -- src/agents/dry-run.test.ts src/agents/profiles.test.ts src/agents/config.test.ts src/agents/coach-report.test.ts src/cli/kl.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run broader checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 8: Write checkpoint**

Write `.ai/checkpoints/part-m4-health-coach-dry-run/step-1.md` recording Coach dry-run role, report renderer, config/profile support, tests run, and the fact that publish wiring remains Task 8.

- [ ] **Step 9: Commit and push this slice**

Run:

```powershell
git status --short
git add src/agents/coach-report.ts src/agents/coach-report.test.ts src/agents/dry-run.ts src/agents/dry-run.test.ts src/agents/profiles.ts src/agents/profiles.test.ts src/agents/config.ts src/agents/config.test.ts config/agents.example.json src/cli/kl.ts src/cli/kl.test.ts .ai/checkpoints/part-m4-health-coach-dry-run/step-1.md
git commit -m "feat: add coach health dry run"
git push -u origin HEAD
```

Expected: commit and push succeed after reviewers approve.

---

## Task 8: Coach Publish API, CLI, And Executor Integration

**Task id:** `part-m4-health-coach-publish`

**Files:**
- Modify: `src/agents/executor.ts`
- Modify: `src/agents/executor.test.ts`
- Modify: `src/agents/day-runner.ts`
- Modify: `src/agents/day-runner.test.ts`
- Modify: `src/agents/coach-report.ts`
- Modify: `src/agents/coach-report.test.ts`
- Modify: `src/health-extensions/coach-digest.ts`
- Modify: `src/health-extensions/coach-digest.test.ts`
- Modify: `src/health-extensions/store.ts`
- Modify: `src/health-extensions/store.test.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/api/contracts.test.ts`
- Modify: `src/api/handlers.ts`
- Modify: `src/api/handlers.test.ts`
- Create: `src/app/api/health/coach-digest/publish/route.ts`
- Modify: `src/app/api/_shared/route-adapter.test.ts`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create checkpoint: `.ai/checkpoints/part-m4-health-coach-publish/step-1.md`

- [ ] **Step 1: Write failing executor integration tests**

Update `src/agents/executor.test.ts` with tests requiring:

- for `role === "coach"` and `phase === "daily-health"`, `executeAgentPlan` finds the `POST /api/health/coach-digest/generate` read result
- it calls `renderCoachHealthDigestBody(read.body, { date: plan.date, sourceEndpointLabel })`
- it publishes the rendered body through the existing board client
- malformed digest body creates a blocker action and does not publish the stale dry-run action body
- read failure keeps the existing blocker behavior
- non-Coach agents keep existing publish behavior

Required assertion shape:

```ts
expect(publishedActions[0]?.action).toMatchObject({
  target: "multica",
  type: "add_comment",
  title: "Coach health digest for 2026-06-14",
  body: expect.stringContaining("Coach daily health digest")
});
```

Run: `npm run test:unit -- src/agents/executor.test.ts src/agents/coach-report.test.ts`

Expected: FAIL before executor integration.

- [ ] **Step 2: Write failing publish API and CLI tests**

Add route ID:

```ts
"health.coach-digest.publish"
```

Publish handler tests in `src/api/handlers.test.ts` must require:

- existing digest snapshot id
- dry-run publish returns intended action and leaves `published_at` null
- live publish result records `published_at` and `publish_result_json` only after injected board publish succeeds
- publish failure leaves `published_at` null
- no response field claims M4 complete

CLI tests:

```powershell
npm run kl -- health-coach-digest publish --db .ai/tmp/m4-health/coach.db --snapshot-id 1 --dry-run
npm run kl -- agent-day --live --date 2026-06-14 --knowledge-loop-url http://127.0.0.1:3000 --compass-health-url http://127.0.0.1:8000 --board daily-plan --multica-create-task-url http://127.0.0.1:8080/api/issues --multica-add-comment-url http://127.0.0.1:8080/api/issues/1/comments
```

Run:

```powershell
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Expected: FAIL before publish path exists.

- [ ] **Step 3: Modify `src/agents/executor.ts` exactly**

Add this control point inside the path that converts successful reads into board publish actions:

```ts
if (plan.role === "coach" && plan.phase === "daily-health") {
  return executeCoachDailyHealthPlan(plan, readResults, clients);
}
```

Add helper signatures:

```ts
function digestGenerateReadFor(reads: readonly AgentReadResult[]): AgentReadResult | undefined;
function coachDigestActionFor(plan: AgentDryRunPlan, digestRead: AgentReadResult): AgentIntendedAction;
```

`coachDigestActionFor` must call:

```ts
renderCoachHealthDigestBody(digestRead.body, {
  date: plan.date,
  sourceEndpointLabel: `${digestRead.endpoint.method} ${digestRead.endpoint.url}`
});
```

If rendering throws `CoachReportRenderError`, return a blocker through the existing blocker action path and do not call `boardClient.publish`.

- [ ] **Step 4: Add publish API and route wrapper**

Add route wrapper:

```ts
import { createApiRouteHandler } from "../../../_shared/route-adapter.js";

export const runtime = "nodejs";
export const POST = createApiRouteHandler("POST", "/api/health/coach-digest/publish");
```

Handler body:

```ts
interface CoachDigestPublishBody {
  snapshotId: number;
  dryRun?: boolean;
}
```

Handler result:

```ts
{
  snapshotId: number;
  status: "dry_run" | "published" | "blocked";
  intendedAction?: AgentIntendedAction;
  publishResult?: { id: string; url?: string };
}
```

- [ ] **Step 5: Add CLI publish mode**

Extend `health-coach-digest` with:

```powershell
health-coach-digest publish --db .ai/tmp/m4-health/coach.db --snapshot-id 1 --dry-run
```

The command returns:

```ts
export interface KlHealthCoachDigestPublishCommandResult {
  readonly command: "health-coach-digest";
  readonly mode: "dry-run";
  readonly action: "publish";
  readonly result: CoachDigestPublishDryRunResult;
}
```

This task does not add a standalone live CLI publish command; live board publishing runs through `agent-day --live` and `executeAgentPlan`.

- [ ] **Step 6: Verify focused tests pass**

Run:

```powershell
npm run test:unit -- src/agents/executor.test.ts src/agents/day-runner.test.ts src/agents/coach-report.test.ts
npm run test:unit -- src/health-extensions/coach-digest.test.ts src/health-extensions/store.test.ts
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run broader checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 8: Write checkpoint**

Write `.ai/checkpoints/part-m4-health-coach-publish/step-1.md` recording publish API/CLI, executor Coach rendering, malformed digest blocker behavior, and tests run.

- [ ] **Step 9: Commit and push this slice**

Run:

```powershell
git status --short
git add src/agents/executor.ts src/agents/executor.test.ts src/agents/day-runner.ts src/agents/day-runner.test.ts src/agents/coach-report.ts src/agents/coach-report.test.ts src/health-extensions/coach-digest.ts src/health-extensions/coach-digest.test.ts src/health-extensions/store.ts src/health-extensions/store.test.ts src/api/contracts.ts src/api/contracts.test.ts src/api/handlers.ts src/api/handlers.test.ts src/app/api/health/coach-digest/publish/route.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.ts src/cli/kl.test.ts .ai/checkpoints/part-m4-health-coach-publish/step-1.md
git commit -m "feat: add coach health publish path"
git push -u origin HEAD
```

Expected: commit and push succeed after reviewers approve.

---

## Task 9: M4 Live Review Evidence, Config, And Review Note

**Task id:** `part-m4-health-live-review`

**Files:**
- Modify: `src/health-extensions/live-evidence.ts`
- Modify: `src/health-extensions/live-evidence.test.ts`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create: `config/health/m4-live-review-evidence.example.json`
- Create: `docs/reviews/M4.md`
- Create checkpoint: `.ai/checkpoints/part-m4-health-live-review/step-1.md`

- [ ] **Step 1: Write failing M4 live review evidence tests**

Extend `validateM4LiveReviewEvidence(value)` in `src/health-extensions/live-evidence.ts` with requirements:

- Windows logger live alert evidence from Task 6 is valid.
- Coach digest board proof includes an HTTP(S) board item/comment URL or id.
- `compassHealthHashProof.before.hash` equals `compassHealthHashProof.afterOneWeek.hash`.
- hash algorithm is `sha256`.
- proof dates are at least seven days apart.
- proof says hash collection happened outside the health-extensions service write path.
- evidence does not include secrets or filesystem paths in public-facing fields.
- fake closure fields such as `m4Complete`, `m4Closed`, `closed`, and `done` are rejected.

Accepted evidence:

```json
{
  "contractStatus": "m4_live_review_pending_verification",
  "evidenceMode": "live-review",
  "coachDigest": {
    "date": "2026-06-14",
    "snapshotId": 1,
    "boardUrl": "http://127.0.0.1:8080/issues/health-digest-1",
    "publishedAt": "2026-06-14T20:00:00.000Z"
  },
  "compassHealthHashProof": {
    "algorithm": "sha256",
    "collectedOutsideHealthExtensions": true,
    "before": {
      "date": "2026-06-14",
      "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "afterOneWeek": {
      "date": "2026-06-21",
      "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
}
```

Run: `npm run test:unit -- src/health-extensions/live-evidence.test.ts`

Expected: FAIL before implementation.

- [ ] **Step 2: Write failing CLI evidence tests**

Add CLI:

```powershell
npm run kl -- health-live-evidence m4-review --dry-run --evidence config/health/m4-live-review-evidence.example.json
```

Expected output:

```json
{
  "command": "health-live-evidence",
  "mode": "dry-run",
  "result": {
    "kind": "m4-review",
    "status": "observed_evidence_valid",
    "valid": true
  }
}
```

Run: `npm run test:unit -- src/cli/kl.test.ts`

Expected: FAIL until the command accepts `m4-review`.

- [ ] **Step 3: Implement live-review validator and CLI**

Add `validateM4LiveReviewEvidence(value)` to `src/health-extensions/live-evidence.ts`. Reuse the unsafe-value scanners from the Windows logger evidence validator. Add `health-live-evidence m4-review --dry-run --evidence config/health/m4-live-review-evidence.example.json` in `src/cli/kl.ts` using the same checkout-local JSON loading rules as Task 6.

- [ ] **Step 4: Add evidence config and pending review note**

Create `config/health/m4-live-review-evidence.example.json` with pending live-review evidence shape and no secrets.

Create `docs/reviews/M4.md` as a pending review note with sections:

- Status: pending live gates until real evidence is captured
- Deterministic implementation evidence
- Windows logger live alert evidence
- Coach Multica publish evidence
- One-week compass-health hash proof
- Section 0 frozen-repo and mock-mode recheck
- Remaining gates

The note must state that it is created before live closure and must be updated to complete only after every M4 gate is verified.

- [ ] **Step 5: Verify focused tests pass**

Run:

```powershell
npm run test:unit -- src/health-extensions/live-evidence.test.ts src/cli/kl.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run broader checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 7: Capture live gates before closure**

Controller or live worker must capture all of these before changing M4 status:

- Real Windows logger start evidence.
- Sleep/wake survival evidence.
- Real sedentary streak of at least 60 minutes.
- Break reminder recorded within 5 minutes of eligibility.
- Coach dry-run with `externalWrites: []`.
- Coach live Multica board publish URL or id.
- compass-health database hash before first live health-extensions use.
- compass-health database hash after one full week of health-extensions use.
- Identical before/after hash values.
- Section 0 frozen-repo and mock-mode recheck.

Do not claim M4 complete until these are recorded in `docs/reviews/M4.md`.

- [ ] **Step 8: Write checkpoint**

Write `.ai/checkpoints/part-m4-health-live-review/step-1.md` recording live-review validator, evidence config, pending review note, tests run, and remaining live proof status.

- [ ] **Step 9: Commit and push this slice**

Run:

```powershell
git status --short
git add src/health-extensions/live-evidence.ts src/health-extensions/live-evidence.test.ts src/cli/kl.ts src/cli/kl.test.ts config/health/m4-live-review-evidence.example.json docs/reviews/M4.md .ai/checkpoints/part-m4-health-live-review/step-1.md
git commit -m "docs: add m4 health live review evidence"
git push -u origin HEAD
```

Expected: commit and push succeed after reviewers approve.

---

## Final Verification Before M4 Closure

Run from `G:\knowledge-loop` after all nine tasks land:

```powershell
npm run test:unit -- src/health-extensions/store.test.ts src/health-extensions/metrics.test.ts src/health-extensions/exercise.test.ts src/health-extensions/sedentary.test.ts src/health-extensions/coach-digest.test.ts src/health-extensions/compass-client.test.ts src/health-extensions/windows-logger.test.ts src/health-extensions/windows-logger-contract.test.ts src/health-extensions/live-evidence.test.ts
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts src/agents/dry-run.test.ts src/agents/profiles.test.ts src/agents/config.test.ts src/agents/coach-report.test.ts src/agents/executor.test.ts src/agents/day-runner.test.ts
npm run check
```

Expected:

- All commands pass.
- Deterministic health logic works without LLM keys.
- CLI/API metric update returns audit id and previous/next proof.
- CSV import/list round-trip returns the same normalized observations.
- Exercise completion rate is queryable for Coach.
- Sedentary reminder engine records deterministic reminder eligibility.
- Windows logger companion polls idle state, posts spans, renders startup registration, survives sleep/wake gaps, and triggers visible alerts in tested adapter paths.
- Coach digest dry-run keeps `externalWrites: []`.
- Coach live executor integration renders the digest body and publishes a blocker on malformed digest data.
- Live Windows alert, live Coach Multica publish, and one-week compass-health hash proof are recorded before M4 closure.
