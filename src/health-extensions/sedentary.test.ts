import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import { computeSedentarySummary, evaluateBreakReminders, ingestSedentarySpan } from "./sedentary.js";

describe("sedentary domain", () => {
  test("ingests Windows logger spans with deterministic receivedAt and source-id dedupe", () => {
    const db = migratedDb();

    try {
      const first = ingestSedentarySpan(db, {
        sourceId: "windows-logger:span-1",
        spanStart: "2026-06-15T01:00:00.000Z",
        spanEnd: "2026-06-15T02:00:00.000Z",
        state: "idle",
        confidence: 0.9
      });
      const second = ingestSedentarySpan(db, {
        sourceId: "windows-logger:span-1",
        spanStart: "2026-06-15T01:30:00.000Z",
        spanEnd: "2026-06-15T02:30:00.000Z",
        state: "active",
        confidence: 0.1,
        receivedAt: "2026-06-15T02:30:01.000Z"
      });

      expect(first).toMatchObject({
        sourceId: "windows-logger:span-1",
        spanStart: "2026-06-15T01:00:00.000Z",
        spanEnd: "2026-06-15T02:00:00.000Z",
        state: "idle",
        confidence: 0.9,
        receivedAt: "2026-06-15T02:00:00.000Z"
      });
      expect(second).toEqual(first);
      expect(tableCount(db, "sedentary_spans")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("rejects invalid ingestion inputs before mutating the store", () => {
    const db = migratedDb();

    try {
      expect(() =>
        ingestSedentarySpan(db, {
          sourceId: " ",
          spanStart: "2026-06-15T01:00:00.000Z",
          spanEnd: "2026-06-15T02:00:00.000Z",
          state: "idle",
          confidence: 0.9
        })
      ).toThrow("sourceId is required");
      expect(() =>
        ingestSedentarySpan(db, {
          sourceId: "windows-logger:bad-interval",
          spanStart: "2026-06-15T02:00:00.000Z",
          spanEnd: "2026-06-15T01:00:00.000Z",
          state: "idle",
          confidence: 0.9
        })
      ).toThrow("spanEnd must be after spanStart");
      expect(() =>
        ingestSedentarySpan(db, {
          sourceId: "windows-logger:bad-confidence",
          spanStart: "2026-06-15T01:00:00.000Z",
          spanEnd: "2026-06-15T02:00:00.000Z",
          state: "idle",
          confidence: -0.1
        })
      ).toThrow("confidence must be between 0 and 1");
      expect(() =>
        ingestSedentarySpan(db, {
          sourceId: "windows-logger:bad-state",
          spanStart: "2026-06-15T01:00:00.000Z",
          spanEnd: "2026-06-15T02:00:00.000Z",
          state: "sleeping" as "idle",
          confidence: 0.9
        })
      ).toThrow("state must be active, idle, or unknown");
      expect(tableCount(db, "sedentary_spans")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("computes idle streaks with active-break splitting and optional unknown-gap merging", () => {
    const db = migratedDb();

    try {
      for (const span of [
        spanInput("idle-1", "2026-06-15T00:00:00.000Z", "2026-06-15T00:50:00.000Z", "idle"),
        spanInput("active-short", "2026-06-15T00:50:00.000Z", "2026-06-15T00:53:00.000Z", "active"),
        spanInput("idle-2", "2026-06-15T00:53:00.000Z", "2026-06-15T01:10:00.000Z", "idle"),
        spanInput("active-break", "2026-06-15T01:10:00.000Z", "2026-06-15T01:20:00.000Z", "active"),
        spanInput("idle-3", "2026-06-15T01:20:00.000Z", "2026-06-15T01:40:00.000Z", "idle"),
        spanInput("unknown-gap", "2026-06-15T01:40:00.000Z", "2026-06-15T01:50:00.000Z", "unknown"),
        spanInput("idle-4", "2026-06-15T01:50:00.000Z", "2026-06-15T02:05:00.000Z", "idle")
      ] as const) {
        ingestSedentarySpan(db, span);
      }

      const splitSummary = computeSedentarySummary(db, {
        from: "2026-06-15T00:00:00.000Z",
        to: "2026-06-15T02:05:00.000Z",
        activeBreakMinutes: 5,
        mergeUnknownGaps: false
      });
      const mergedSummary = computeSedentarySummary(db, {
        from: "2026-06-15T00:00:00.000Z",
        to: "2026-06-15T02:05:00.000Z",
        activeBreakMinutes: 5,
        mergeUnknownGaps: true
      });

      expect(splitSummary).toMatchObject({
        idleMinutes: 102,
        activeMinutes: 13,
        unknownMinutes: 10,
        longestIdleStreakMinutes: 70,
        currentIdleStreakMinutes: 15
      });
      expect(splitSummary.idleStreaks.map((streak) => [streak.windowStart, streak.windowEnd, streak.durationMinutes])).toEqual([
        ["2026-06-15T00:00:00.000Z", "2026-06-15T01:10:00.000Z", 70],
        ["2026-06-15T01:20:00.000Z", "2026-06-15T01:40:00.000Z", 20],
        ["2026-06-15T01:50:00.000Z", "2026-06-15T02:05:00.000Z", 15]
      ]);
      expect(mergedSummary.idleStreaks.map((streak) => [streak.windowStart, streak.windowEnd, streak.durationMinutes])).toEqual([
        ["2026-06-15T00:00:00.000Z", "2026-06-15T01:10:00.000Z", 70],
        ["2026-06-15T01:20:00.000Z", "2026-06-15T02:05:00.000Z", 45]
      ]);
      expect(mergedSummary.currentIdleStreakMinutes).toBe(45);
    } finally {
      db.close();
    }
  });

  test("clips summary spans to the half-open query window", () => {
    const db = migratedDb();

    try {
      ingestSedentarySpan(db, spanInput("before", "2026-06-14T23:45:00.000Z", "2026-06-15T00:15:00.000Z", "idle"));
      ingestSedentarySpan(db, spanInput("inside", "2026-06-15T00:20:00.000Z", "2026-06-15T00:40:00.000Z", "idle"));
      ingestSedentarySpan(db, spanInput("after", "2026-06-15T00:40:00.000Z", "2026-06-15T01:10:00.000Z", "active"));

      const summary = computeSedentarySummary(db, {
        from: "2026-06-15T00:00:00.000Z",
        to: "2026-06-15T01:00:00.000Z",
        activeBreakMinutes: 5
      });

      expect(summary).toMatchObject({
        idleMinutes: 35,
        activeMinutes: 20,
        unknownMinutes: 5,
        longestIdleStreakMinutes: 20,
        currentIdleStreakMinutes: 0
      });
      expect(summary.idleStreaks.map((streak) => [streak.windowStart, streak.windowEnd, streak.durationMinutes])).toEqual([
        ["2026-06-15T00:00:00.000Z", "2026-06-15T00:15:00.000Z", 15],
        ["2026-06-15T00:20:00.000Z", "2026-06-15T00:40:00.000Z", 20]
      ]);
    } finally {
      db.close();
    }
  });

  test("persists eligible break reminders idempotently for the same sedentary streak window", () => {
    const db = migratedDb();

    try {
      ingestSedentarySpan(db, spanInput("idle-65", "2026-06-15T10:00:00.000Z", "2026-06-15T11:05:00.000Z", "idle"));

      const first = evaluateBreakReminders(db, {
        from: "2026-06-15T10:00:00.000Z",
        to: "2026-06-15T11:05:00.000Z",
        evaluatedAt: "2026-06-15T11:05:00.000Z"
      });
      const second = evaluateBreakReminders(db, {
        from: "2026-06-15T10:00:00.000Z",
        to: "2026-06-15T11:05:00.000Z",
        evaluatedAt: "2026-06-15T11:05:00.000Z"
      });

      expect(first.status).toBe("eligible");
      expect(first.streak).toMatchObject({
        windowStart: "2026-06-15T10:00:00.000Z",
        windowEnd: "2026-06-15T11:05:00.000Z",
        durationMinutes: 65,
        computedAt: "2026-06-15T11:05:00.000Z"
      });
      expect(first.reminder).toMatchObject({
        streakId: first.streak?.id,
        eligibleAt: "2026-06-15T11:00:00.000Z",
        status: "eligible",
        reason: "sedentary streak reached 60 minutes"
      });
      expect(second.streak?.id).toBe(first.streak?.id);
      expect(second.reminder?.id).toBe(first.reminder?.id);
      expect(tableCount(db, "sedentary_streaks")).toBe(1);
      expect(tableCount(db, "break_reminders")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("does not round sub-minute sedentary duration into reminder eligibility", () => {
    const db = migratedDb();

    try {
      ingestSedentarySpan(
        db,
        spanInput("idle-59m31s", "2026-06-15T09:00:00.000Z", "2026-06-15T09:59:31.000Z", "idle")
      );

      const almost = evaluateBreakReminders(db, {
        from: "2026-06-15T09:00:00.000Z",
        to: "2026-06-15T09:59:31.000Z",
        evaluatedAt: "2026-06-15T09:59:31.000Z"
      });

      expect(almost.status).toBe("not_eligible");
      expect(almost.summary.currentIdleStreakMinutes).toBe(59);
      expect(tableCount(db, "sedentary_streaks")).toBe(0);
      expect(tableCount(db, "break_reminders")).toBe(0);

      ingestSedentarySpan(
        db,
        spanInput("idle-60m", "2026-06-15T10:00:00.000Z", "2026-06-15T11:00:00.000Z", "idle")
      );

      const exact = evaluateBreakReminders(db, {
        from: "2026-06-15T10:00:00.000Z",
        to: "2026-06-15T11:00:00.000Z",
        evaluatedAt: "2026-06-15T11:00:00.000Z"
      });

      expect(exact.status).toBe("eligible");
      expect(exact.summary.currentIdleStreakMinutes).toBe(60);
      expect(exact.reminder).toMatchObject({
        eligibleAt: "2026-06-15T11:00:00.000Z"
      });
    } finally {
      db.close();
    }
  });

  test("does not duplicate reminders when an ongoing streak window advances", () => {
    const db = migratedDb();

    try {
      ingestSedentarySpan(db, spanInput("ongoing-idle", "2026-06-15T10:00:00.000Z", "2026-06-15T11:10:00.000Z", "idle"));

      const first = evaluateBreakReminders(db, {
        from: "2026-06-15T10:00:00.000Z",
        to: "2026-06-15T11:05:00.000Z",
        evaluatedAt: "2026-06-15T11:05:00.000Z"
      });
      const advanced = evaluateBreakReminders(db, {
        from: "2026-06-15T10:00:00.000Z",
        to: "2026-06-15T11:10:00.000Z",
        evaluatedAt: "2026-06-15T11:10:00.000Z"
      });

      expect(first.status).toBe("eligible");
      expect(advanced.status).toBe("eligible");
      expect(advanced.streak?.id).toBe(first.streak?.id);
      expect(advanced.reminder?.id).toBe(first.reminder?.id);
      expect(tableCount(db, "sedentary_streaks")).toBe(1);
      expect(tableCount(db, "break_reminders")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("suppresses new reminders inside the configured cooldown window", () => {
    const db = migratedDb();

    try {
      ingestSedentarySpan(db, spanInput("first-idle", "2026-06-15T10:00:00.000Z", "2026-06-15T11:05:00.000Z", "idle"));
      evaluateBreakReminders(db, {
        from: "2026-06-15T10:00:00.000Z",
        to: "2026-06-15T11:05:00.000Z",
        evaluatedAt: "2026-06-15T11:05:00.000Z"
      });
      ingestSedentarySpan(db, spanInput("second-idle", "2026-06-15T11:15:00.000Z", "2026-06-15T12:20:00.000Z", "idle"));

      const result = evaluateBreakReminders(db, {
        from: "2026-06-15T11:15:00.000Z",
        to: "2026-06-15T12:20:00.000Z",
        evaluatedAt: "2026-06-15T12:20:00.000Z",
        cooldownMinutes: 120
      });
      const repeated = evaluateBreakReminders(db, {
        from: "2026-06-15T11:15:00.000Z",
        to: "2026-06-15T12:20:00.000Z",
        evaluatedAt: "2026-06-15T12:20:00.000Z",
        cooldownMinutes: 120
      });

      expect(result.status).toBe("suppressed");
      expect(result.reminder).toMatchObject({
        status: "suppressed",
        reason: "cooldown active"
      });
      expect(repeated.reminder?.id).toBe(result.reminder?.id);
      expect(tableCount(db, "sedentary_streaks")).toBe(2);
      expect(tableCount(db, "break_reminders")).toBe(2);
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

function spanInput(
  sourceId: string,
  spanStart: string,
  spanEnd: string,
  state: "active" | "idle" | "unknown"
): Parameters<typeof ingestSedentarySpan>[1] {
  return {
    sourceId,
    spanStart,
    spanEnd,
    state,
    confidence: 0.9
  };
}

function tableCount(db: Database.Database, tableName: "sedentary_spans" | "sedentary_streaks" | "break_reminders"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}
