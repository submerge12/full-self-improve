import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { MIGRATIONS, applyMigrations, listTables } from "./migrations.js";

const EXPECTED_TABLES = [
  "attempts",
  "break_reminders",
  "chunks",
  "coach_digest_snapshots",
  "concept_edges",
  "concepts",
  "exercise_plans",
  "exercise_sessions",
  "exercise_templates",
  "health_metric_audit_events",
  "health_metric_imports",
  "health_metrics",
  "health_trace_events",
  "items",
  "mastery",
  "pages",
  "reviews",
  "schema_migrations",
  "sedentary_spans",
  "sedentary_streaks",
  "sources",
  "study_plans",
  "teachbacks",
  "trace_events"
].sort();

describe("database migrations", () => {
  test("migrates an empty database to the expected table set", () => {
    const db = new Database(":memory:");

    try {
      const applied = applyMigrations(db);

      expect(applied).toEqual(MIGRATIONS.map((migration) => migration.id));
      expect(listTables(db)).toEqual(EXPECTED_TABLES);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  test("can be replayed without duplicate migration records", () => {
    const db = new Database(":memory:");

    try {
      applyMigrations(db);
      const secondRun = applyMigrations(db);
      const records = db
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all() as Array<{ id: string }>;

      expect(secondRun).toEqual([]);
      expect(records.map((record) => record.id)).toEqual(MIGRATIONS.map((migration) => migration.id));
    } finally {
      db.close();
    }
  });

  test("enforces trace event stage, level, and JSON data constraints", () => {
    const db = new Database(":memory:");

    try {
      applyMigrations(db);

      db.prepare(
        `INSERT INTO trace_events (run_id, stage, level, message, timestamp, data)
         VALUES ('run-trace', 'chunk', 'info', 'Chunked source', '2026-06-12T00:00:00.000Z', '{"chunks":1}')`
      ).run();

      expect(() =>
        db
          .prepare(
            `INSERT INTO trace_events (run_id, stage, level, message, timestamp, data)
             VALUES ('run-trace', 'invalid-stage', 'info', 'Bad stage', '2026-06-12T00:01:00.000Z', 'null')`
          )
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO trace_events (run_id, stage, level, message, timestamp, data)
             VALUES ('run-trace', 'chunk', 'debug', 'Bad level', '2026-06-12T00:02:00.000Z', 'null')`
          )
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO trace_events (run_id, stage, level, message, timestamp, data)
             VALUES ('run-trace', 'chunk', 'info', 'Bad data', '2026-06-12T00:03:00.000Z', 'not-json')`
          )
          .run()
      ).toThrow();

      const indexNames = db
        .prepare("PRAGMA index_list('trace_events')")
        .all()
        .map((row) => (row as { name: string }).name);

      expect(indexNames).toEqual(expect.arrayContaining(["trace_events_run_id_id_idx", "trace_events_run_id_stage_id_idx"]));
    } finally {
      db.close();
    }
  });

  test("creates health extension tables and enforces core constraints", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      expect(listTables(db)).toEqual(
        expect.arrayContaining([
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
        ])
      );
      expect(() =>
        db
          .prepare(
            "INSERT INTO health_metrics (metric_key, metric_label, value, unit, observed_at, source) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run("sleep", "Sleep", Number.POSITIVE_INFINITY, "hours", "2026-06-14T00:00:00.000Z", "manual")
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("enforces health extension JSON and status constraints", () => {
    const db = new Database(":memory:");

    try {
      applyMigrations(db);
      const templateId = insertAndReturnId(
        db,
        `INSERT INTO exercise_templates (slug, name, default_days)
         VALUES ('starter', 'Starter', '["monday"]')
         RETURNING id`
      );
      const planId = insertAndReturnId(
        db,
        `INSERT INTO exercise_plans (template_id, week_start, status, generated_from)
         VALUES (${templateId}, '2026-06-15', 'active', 'test')
         RETURNING id`
      );
      const streakId = insertAndReturnId(
        db,
        `INSERT INTO sedentary_streaks (window_start, window_end, duration_minutes, source_span_ids, computed_at)
         VALUES ('2026-06-14T01:00:00.000Z', '2026-06-14T02:00:00.000Z', 60, '[1,2]', '2026-06-14T02:01:00.000Z')
         RETURNING id`
      );

      expect(() =>
        db.prepare("INSERT INTO exercise_templates (slug, name, default_days) VALUES ('bad-json', 'Bad', 'not-json')").run()
      ).toThrow();
      expect(() =>
        db.prepare("INSERT INTO exercise_templates (slug, name, default_days) VALUES ('bad-object', 'Bad', '{}')").run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO exercise_plans (template_id, week_start, status, generated_from) VALUES (?, '2026-06-22', 'paused', 'test')"
          )
          .run(templateId)
      ).toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO exercise_sessions (plan_id, scheduled_for, status) VALUES (?, '2026-06-15T09:00:00.000Z', 'skipped')")
          .run(planId)
      ).toThrow();
      expect(() =>
        db.prepare("INSERT INTO exercise_sessions (plan_id, status) VALUES (?, 'planned')").run(planId)
      ).toThrow();
      expect(() =>
        db.prepare("INSERT INTO exercise_sessions (plan_id, status) VALUES (?, 'completed')").run(planId)
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO sedentary_streaks (window_start, window_end, duration_minutes, source_span_ids, computed_at) VALUES ('2026-06-14T01:00:00.000Z', '2026-06-14T02:00:00.000Z', 60, '{}', '2026-06-14T02:01:00.000Z')"
          )
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO break_reminders (streak_id, eligible_at, status, reason) VALUES (?, '2026-06-14T02:30:00.000Z', 'pending', 'move')")
          .run(streakId)
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO coach_digest_snapshots (date, metrics_summary_json, exercise_summary_json, sedentary_summary_json, compass_context_json, rendered_markdown, source_hash) VALUES ('2026-06-14', 'not-json', '{}', '{}', '{}', '# Digest', 'hash-1')"
          )
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO health_trace_events (run_id, stage, level, message, timestamp, data) VALUES ('run-health', 'metric', 'debug', 'bad', '2026-06-14T03:00:00.000Z', 'null')"
          )
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO health_trace_events (run_id, stage, level, message, timestamp, data) VALUES ('run-health', 'bad-stage', 'info', 'bad', '2026-06-14T03:00:00.000Z', 'null')"
          )
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO health_trace_events (run_id, stage, level, message, timestamp, data) VALUES ('run-health', 'metric', 'info', 'bad', '2026-06-14T03:00:00.000Z', 'not-json')"
          )
          .run()
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("enforces health import hashes, count totals, sedentary spans, and reminder uniqueness", () => {
    const db = new Database(":memory:");

    try {
      applyMigrations(db);
      const importSql = `INSERT INTO health_metric_imports
        (source_filename, row_count, accepted_count, rejected_count, imported_at, content_hash)
        VALUES ('metrics.csv', 3, 2, 1, '2026-06-14T00:00:00.000Z', 'sha256:abc')`;
      db.prepare(importSql).run();

      expect(() => db.prepare(importSql).run()).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO health_metric_imports
             (source_filename, row_count, accepted_count, rejected_count, imported_at, content_hash)
             VALUES ('metrics-2.csv', 3, 3, 1, '2026-06-14T00:01:00.000Z', 'sha256:def')`
          )
          .run()
      ).toThrow();

      db.prepare(
        `INSERT INTO sedentary_spans (source_id, span_start, span_end, state, confidence, received_at)
         VALUES ('span-1', '2026-06-14T01:00:00.000Z', '2026-06-14T02:00:00.000Z', 'idle', 0.9, '2026-06-14T02:00:01.000Z')`
      ).run();

      expect(() =>
        db
          .prepare(
            `INSERT INTO sedentary_spans (source_id, span_start, span_end, state, confidence, received_at)
             VALUES ('span-1', '2026-06-14T02:00:00.000Z', '2026-06-14T03:00:00.000Z', 'idle', 0.8, '2026-06-14T03:00:01.000Z')`
          )
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO sedentary_spans (span_start, span_end, state, confidence, received_at)
             VALUES ('2026-06-14T03:00:00.000Z', '2026-06-14T02:00:00.000Z', 'idle', 0.5, '2026-06-14T03:00:01.000Z')`
          )
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO sedentary_spans (span_start, span_end, state, confidence, received_at)
             VALUES ('2026-06-14T03:00:00.000Z', '2026-06-14T04:00:00.000Z', 'idle', 1.1, '2026-06-14T04:00:01.000Z')`
          )
          .run()
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("enforces source, concept, and citation table relationships", () => {
    const db = new Database(":memory:");

    try {
      applyMigrations(db);

      const sourceId = insertAndReturnId(
        db,
        `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
         VALUES ('fixture-adapter', 'docs/intro.md', 'Intro', 'fp-1', 'ingested')
         RETURNING id`
      );
      const chunkId = insertAndReturnId(
        db,
        `INSERT INTO chunks (source_id, seq, text, meta)
         VALUES (${sourceId}, 1, 'Grounded source text', '{}')
         RETURNING id`
      );
      const conceptId = insertAndReturnId(
        db,
        `INSERT INTO concepts (slug, name, status)
         VALUES ('intro', 'Intro', 'stub')
         RETURNING id`
      );
      const pageId = insertAndReturnId(
        db,
        `INSERT INTO pages (concept_id, version, markdown, citations, visibility)
         VALUES (${conceptId}, 1, '# Intro', '[${chunkId}]', 'private')
         RETURNING id`
      );

      const page = db.prepare("SELECT citations FROM pages WHERE id = ?").get(pageId) as { citations: string };

      expect(JSON.parse(page.citations)).toEqual([chunkId]);
      expect(() =>
        db
          .prepare("INSERT INTO chunks (source_id, seq, text, meta) VALUES (9999, 2, 'Orphan', '{}')")
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO pages (concept_id, version, markdown, citations, visibility) VALUES (9999, 1, '# Missing', '[]', 'private')")
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pages (concept_id, version, markdown, citations, visibility) VALUES (?, 2, '# Public', '[]', 'public')"
          )
          .run(conceptId)
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pages (concept_id, version, markdown, citations, visibility) VALUES (?, 3, '# Invalid', 'not-json', 'private')"
          )
          .run(conceptId)
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pages (concept_id, version, markdown, citations, visibility) VALUES (?, 4, '# Object', '{}', 'private')"
          )
          .run(conceptId)
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

function insertAndReturnId(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as { id: number };
  return row.id;
}
