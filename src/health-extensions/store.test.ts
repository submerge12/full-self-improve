import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import {
  assertFiniteMetricValue,
  assertIsoDate,
  assertIsoInstant,
  normalizeHealthMetricInput,
  normalizeMetricKey
} from "./schema.js";
import {
  findMetricImportByHash,
  getHealthMetricById,
  insertBreakReminder,
  insertCoachDigestSnapshot,
  insertExercisePlan,
  insertExerciseSession,
  insertExerciseTemplate,
  insertHealthMetric,
  insertHealthTraceEvent,
  insertMetricAuditEvent,
  insertMetricImportRecord,
  insertSedentarySpan,
  insertSedentaryStreak,
  listHealthMetrics
} from "./store.js";

describe("health extension schema helpers", () => {
  test("canonicalizes metric keys as lowercase kebab-case", () => {
    expect(normalizeMetricKey(" Sleep Score ")).toBe("sleep-score");
    expect(normalizeMetricKey("Sleep_Score")).toBe("sleep-score");
    expect(normalizeMetricKey("sleep.score")).toBe("sleep-score");
    expect(normalizeMetricKey("Sleep---Score")).toBe("sleep-score");
    expect(normalizeMetricKey("  Sleep _._ Score  ")).toBe("sleep-score");
    expect(() => normalizeMetricKey("!!!")).toThrow("metricKey must contain at least one alphanumeric character");
  });

  test("normalizes metric inputs and rejects invalid scalar values", () => {
    expect(normalizeMetricKey(" Sleep Score ")).toBe("sleep-score");
    expect(
      normalizeHealthMetricInput({
        metricKey: " Sleep ",
        metricLabel: " Sleep ",
        value: 7.5,
        unit: " hours ",
        observedAt: "2026-06-14T07:00:00.000Z",
        source: "manual",
        note: " good sleep "
      })
    ).toEqual({
      metricKey: "sleep",
      metricLabel: "Sleep",
      value: 7.5,
      unit: "hours",
      observedAt: "2026-06-14T07:00:00.000Z",
      source: "manual",
      note: "good sleep"
    });

    expect(() => assertFiniteMetricValue(Number.POSITIVE_INFINITY, "value")).toThrow("value must be finite");
    expect(() => assertIsoInstant("2026-06-14", "observedAt")).toThrow("observedAt must be an ISO instant");
    expect(() => assertIsoDate("2026-02-30", "weekStart")).toThrow("weekStart must be an ISO date");
    expect(() =>
      normalizeHealthMetricInput({
        metricKey: "sleep",
        metricLabel: "Sleep",
        value: 7.5,
        unit: "hours",
        observedAt: "2026-06-14T07:00:00.000Z",
        source: "manual",
        note: "bad\u0001note"
      })
    ).toThrow("note contains unsupported control characters");
  });
});

describe("health extension store", () => {
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

  test("gets and filters metric observations by normalized key and observed window", () => {
    const db = migratedDb();

    try {
      const sleepEarly = insertHealthMetric(db, {
        metricKey: " Sleep ",
        metricLabel: "Sleep",
        value: 6.5,
        unit: "hours",
        observedAt: "2026-06-13T07:00:00.000Z",
        source: "manual"
      });
      const sleepLater = insertHealthMetric(db, {
        metricKey: "sleep",
        metricLabel: "Sleep",
        value: 7.5,
        unit: "hours",
        observedAt: "2026-06-14T07:00:00.000Z",
        source: "csv"
      });
      insertHealthMetric(db, {
        metricKey: "weight",
        metricLabel: "Weight",
        value: 58.2,
        unit: "kg",
        observedAt: "2026-06-14T08:00:00.000Z",
        source: "manual"
      });

      expect(getHealthMetricById(db, sleepEarly.id)).toMatchObject({ id: sleepEarly.id, metricKey: "sleep" });
      expect(
        listHealthMetrics(db, {
          metricKey: " Sleep ",
          observedFrom: "2026-06-14T00:00:00.000Z",
          observedTo: "2026-06-14T23:59:59.999Z"
        })
      ).toMatchObject([{ id: sleepLater.id, source: "csv" }]);
    } finally {
      db.close();
    }
  });

  test("records metric imports idempotently and metric audit events", () => {
    const db = migratedDb();

    try {
      const metric = insertHealthMetric(db, {
        metricKey: "sleep",
        metricLabel: "Sleep",
        value: 7.5,
        unit: "hours",
        observedAt: "2026-06-14T07:00:00.000Z",
        source: "manual"
      });
      const firstImport = insertMetricImportRecord(db, {
        sourceFilename: "metrics.csv",
        rowCount: 3,
        acceptedCount: 2,
        rejectedCount: 1,
        importedAt: "2026-06-14T08:00:00.000Z",
        contentHash: "sha256:abc"
      });
      const secondImport = insertMetricImportRecord(db, {
        sourceFilename: "metrics.csv",
        rowCount: 3,
        acceptedCount: 2,
        rejectedCount: 1,
        importedAt: "2026-06-14T08:00:00.000Z",
        contentHash: "sha256:abc"
      });
      const audit = insertMetricAuditEvent(db, {
        metricId: metric.id,
        changedAt: "2026-06-14T08:30:00.000Z",
        changedBy: "cli",
        previous: { value: 7 },
        next: { value: 7.5 },
        reason: "manual correction"
      });

      expect(secondImport.id).toBe(firstImport.id);
      expect(findMetricImportByHash(db, "sha256:abc")).toMatchObject({ id: firstImport.id, acceptedCount: 2 });
      expect(JSON.parse(audit.nextJson)).toEqual({ value: 7.5 });
    } finally {
      db.close();
    }
  });

  test("rejects unsafe JSON payload values before persistence", () => {
    const db = migratedDb();

    try {
      const metric = insertHealthMetric(db, {
        metricKey: "sleep",
        metricLabel: "Sleep",
        value: 7.5,
        unit: "hours",
        observedAt: "2026-06-14T07:00:00.000Z",
        source: "manual"
      });

      expect(() =>
        insertMetricAuditEvent(db, {
          metricId: metric.id,
          changedAt: "2026-06-14T08:30:00.000Z",
          changedBy: "cli",
          previous: { nested: { value: Number.NaN } },
          next: { value: 7.5 },
          reason: "manual correction"
        })
      ).toThrow("previous contains a non-finite number");
      expect(() =>
        insertHealthTraceEvent(db, {
          runId: "run-health",
          stage: "metric",
          level: "warn",
          message: "Bad payload",
          timestamp: "2026-06-14T08:31:00.000Z",
          data: { nested: { value: Number.POSITIVE_INFINITY } }
        })
      ).toThrow("data contains a non-finite number");

      const trace = insertHealthTraceEvent(db, {
        runId: "run-health",
        stage: "metric",
        level: "info",
        message: "Good payload",
        timestamp: "2026-06-14T08:32:00.000Z",
        data: { nested: { value: 7.5, ok: true, note: null } }
      });

      expect(JSON.parse(trace.dataJson)).toEqual({ nested: { value: 7.5, ok: true, note: null } });
    } finally {
      db.close();
    }
  });

  test("persists exercise templates, plans, and sessions without higher-level scheduling logic", () => {
    const db = migratedDb();

    try {
      const template = insertExerciseTemplate(db, {
        slug: "starter",
        name: "Starter",
        description: "simple week",
        defaultDays: ["monday", "wednesday"],
        active: true
      });
      const plan = insertExercisePlan(db, {
        templateId: template.id,
        weekStart: "2026-06-15",
        status: "active",
        generatedFrom: "unit-test"
      });
      const planned = insertExerciseSession(db, {
        planId: plan.id,
        templateSessionKey: "starter:monday",
        scheduledFor: "2026-06-15T09:00:00.000Z",
        status: "planned",
        durationMinutes: 30,
        intensity: "moderate"
      });
      const completed = insertExerciseSession(db, {
        planId: plan.id,
        completedAt: "2026-06-16T09:30:00.000Z",
        status: "completed",
        durationMinutes: 25,
        intensity: "high",
        note: "finished"
      });

      expect(template.defaultDays).toEqual(["monday", "wednesday"]);
      expect(planned.status).toBe("planned");
      expect(completed.completedAt).toBe("2026-06-16T09:30:00.000Z");
    } finally {
      db.close();
    }
  });

  test("rejects invalid exercise template default days before persistence", () => {
    const db = migratedDb();

    try {
      expect(() =>
        insertExerciseTemplate(db, {
          slug: "bad-template",
          name: "Bad Template",
          defaultDays: [1] as unknown as readonly string[]
        })
      ).toThrow("defaultDays must be a JSON string array");
      expect(tableCount(db, "exercise_templates")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("persists sedentary spans, computed streaks, and break reminders", () => {
    const db = migratedDb();

    try {
      const span = insertSedentarySpan(db, {
        sourceId: "watch-span-1",
        spanStart: "2026-06-14T01:00:00.000Z",
        spanEnd: "2026-06-14T02:00:00.000Z",
        state: "idle",
        confidence: 0.9,
        receivedAt: "2026-06-14T02:00:01.000Z"
      });
      const streak = insertSedentaryStreak(db, {
        windowStart: span.spanStart,
        windowEnd: span.spanEnd,
        durationMinutes: 60,
        sourceSpanIds: [span.id],
        computedAt: "2026-06-14T02:01:00.000Z"
      });
      const reminder = insertBreakReminder(db, {
        streakId: streak.id,
        eligibleAt: "2026-06-14T02:30:00.000Z",
        status: "eligible",
        reason: "idle threshold"
      });

      expect(streak.sourceSpanIds).toEqual([span.id]);
      expect(reminder.streakId).toBe(streak.id);
    } finally {
      db.close();
    }
  });

  test("rejects invalid sedentary streak source span IDs before persistence", () => {
    const db = migratedDb();

    try {
      expect(() =>
        insertSedentaryStreak(db, {
          windowStart: "2026-06-14T01:00:00.000Z",
          windowEnd: "2026-06-14T02:00:00.000Z",
          durationMinutes: 60,
          sourceSpanIds: [1.5] as unknown as readonly number[],
          computedAt: "2026-06-14T02:01:00.000Z"
        })
      ).toThrow("sourceSpanIds must be positive integer IDs");
      expect(tableCount(db, "sedentary_streaks")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("persists coach digest snapshots and health trace rows", () => {
    const db = migratedDb();

    try {
      const digest = insertCoachDigestSnapshot(db, {
        date: "2026-06-14",
        metricsSummary: { sleep: 7.5 },
        exerciseSummary: { sessions: 1 },
        sedentarySummary: { idleMinutes: 60 },
        compassContext: { mood: "steady" },
        renderedMarkdown: "# Digest",
        sourceHash: "sha256:digest"
      });
      const trace = insertHealthTraceEvent(db, {
        runId: "run-health",
        stage: "coach",
        level: "info",
        message: "Rendered digest",
        timestamp: "2026-06-14T09:00:00.000Z",
        data: { digestId: digest.id }
      });

      expect(JSON.parse(digest.metricsSummaryJson)).toEqual({ sleep: 7.5 });
      expect(JSON.parse(trace.dataJson)).toEqual({ digestId: digest.id });
    } finally {
      db.close();
    }
  });
});

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function tableCount(db: Database.Database, tableName: "exercise_templates" | "sedentary_streaks"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}
