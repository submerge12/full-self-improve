import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import { completeExerciseSession, createExercisePlanFromTemplate, createExerciseTemplate } from "./exercise.js";
import { createHealthMetric } from "./metrics.js";
import { generateCoachDigestSnapshot, publishCoachDigestSnapshot } from "./coach-digest.js";
import { ingestSedentarySpan } from "./sedentary.js";

describe("coach digest domain", () => {
  test("generates and stores an offline digest from local health summaries without fetching Compass", async () => {
    const db = migratedDb();
    let fetchCalled = false;

    try {
      seedDailyHealthContext(db);

      const result = await generateCoachDigestSnapshot(db, {
        date: "2026-06-15",
        now: "2026-06-15T21:00:00.000Z",
        runId: "coach-digest-offline-test",
        offline: true,
        compass: {
          baseUrl: "https://compass.example.test",
          fetch: async () => {
            fetchCalled = true;
            return jsonResponse({});
          }
        }
      });

      expect(fetchCalled).toBe(false);
      expect(result.renderedMarkdown).toContain("# Coach daily health digest\n## Date\n2026-06-15");
      expect(result.renderedMarkdown).toContain("## Metrics");
      expect(result.renderedMarkdown).toContain("Sleep: 7.5 hours");
      expect(result.renderedMarkdown).toContain("## Exercise");
      expect(result.renderedMarkdown).toContain("Completion rate: 100%");
      expect(result.renderedMarkdown).toContain("## Sedentary");
      expect(result.renderedMarkdown).toContain("Idle minutes: 75");
      expect(result.renderedMarkdown).toContain("## Compass context");
      expect(result.renderedMarkdown).toContain("Availability: unavailable");
      expect(result.renderedMarkdown).toContain("Reason: offline");
      expect(result.snapshot).toMatchObject({
        date: "2026-06-15",
        renderedMarkdown: result.renderedMarkdown,
        sourceHash: result.sourceHash
      });
      expect(result.snapshot.publishedAt).toBeUndefined();
      expect(JSON.parse(result.snapshot.metricsSummaryJson)).toMatchObject({
        from: "2026-06-15T00:00:00.000Z",
        to: "2026-06-16T00:00:00.000Z",
        metrics: [
          {
            metricKey: "sleep",
            metricLabel: "Sleep",
            value: 7.5,
            unit: "hours",
            observedAt: "2026-06-15T07:00:00.000Z",
            source: "manual"
          },
          {
            metricKey: "weight",
            metricLabel: "Weight",
            value: 58.2,
            unit: "kg",
            observedAt: "2026-06-15T08:00:00.000Z",
            source: "manual"
          }
        ]
      });
      expect(JSON.parse(result.snapshot.exerciseSummaryJson)).toMatchObject({
        from: "2026-06-15",
        to: "2026-06-16",
        planned: 1,
        completed: 1,
        missed: 0,
        rate: 1
      });
      expect(JSON.parse(result.snapshot.sedentarySummaryJson)).toMatchObject({
        from: "2026-06-15T00:00:00.000Z",
        to: "2026-06-16T00:00:00.000Z",
        idleMinutes: 75,
        activeMinutes: 30
      });
      expect(JSON.parse(result.snapshot.compassContextJson)).toEqual({
        available: false,
        sourceUrl: null,
        unavailableReason: "offline",
        meals: null
      });
      expect(result.traceEvents).toMatchObject([
        {
          runId: "coach-digest-offline-test",
          stage: "coach",
          level: "info",
          message: "Coach digest snapshot generated",
          timestamp: "2026-06-15T21:00:00.000Z"
        }
      ]);
      expect(JSON.parse(result.traceEvents[0]!.dataJson)).toEqual({
        snapshotId: result.snapshot.id,
        date: "2026-06-15",
        sourceHash: result.sourceHash,
        compassAvailable: false
      });
      expect(coachTraceCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("uses normalized source inputs for a stable hash across repeat generations", async () => {
    const firstDb = migratedDb();
    const secondDb = migratedDb();

    try {
      seedDailyHealthContext(firstDb);
      seedDailyHealthContext(secondDb);

      const first = await generateCoachDigestSnapshot(firstDb, {
        date: "2026-06-15",
        now: "2026-06-15T21:00:00.000Z",
        runId: "coach-digest-stable-1",
        offline: true
      });
      const second = await generateCoachDigestSnapshot(secondDb, {
        date: "2026-06-15",
        now: "2026-06-15T21:05:00.000Z",
        runId: "coach-digest-stable-2",
        offline: true
      });

      expect(second.sourceHash).toBe(first.sourceHash);
      expect(second.renderedMarkdown).toBe(first.renderedMarkdown);
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });

  test("keeps source hash stable when equivalent source rows are inserted in different order", async () => {
    const firstDb = migratedDb();
    const secondDb = migratedDb();

    try {
      seedSameInstantMetrics(firstDb, ["sleep", "weight"]);
      seedSameInstantMetrics(secondDb, ["weight", "sleep"]);

      const first = await generateCoachDigestSnapshot(firstDb, {
        date: "2026-06-15",
        now: "2026-06-15T21:00:00.000Z",
        offline: true
      });
      const second = await generateCoachDigestSnapshot(secondDb, {
        date: "2026-06-15",
        now: "2026-06-15T21:05:00.000Z",
        offline: true
      });

      expect(second.sourceHash).toBe(first.sourceHash);
      expect(second.renderedMarkdown).toBe(first.renderedMarkdown);
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });

  test("reuses an existing digest snapshot for identical same-db dry-runs", async () => {
    const db = migratedDb();

    try {
      seedDailyHealthContext(db);

      const first = await generateCoachDigestSnapshot(db, {
        date: "2026-06-15",
        now: "2026-06-15T21:00:00.000Z",
        runId: "coach-digest-repeat-1",
        offline: true
      });
      const repeated = await generateCoachDigestSnapshot(db, {
        date: "2026-06-15",
        now: "2026-06-15T21:05:00.000Z",
        runId: "coach-digest-repeat-2",
        offline: true
      });

      expect(repeated.snapshot.id).toBe(first.snapshot.id);
      expect(repeated.sourceHash).toBe(first.sourceHash);
      expect(repeated.renderedMarkdown).toBe(first.renderedMarkdown);
      expect(coachDigestSnapshotCount(db)).toBe(1);
      expect(coachTraceCount(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("reads live Compass context through the HTTP client when online", async () => {
    const db = migratedDb();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const meals = {
      meals: [
        { name: "Breakfast", calories: 420 },
        { name: "Dinner", calories: 650 }
      ]
    };

    try {
      seedDailyHealthContext(db);

      const result = await generateCoachDigestSnapshot(db, {
        date: "2026-06-15",
        now: "2026-06-15T21:00:00.000Z",
        runId: "coach-digest-live-test",
        compass: {
          baseUrl: "https://compass.example.test/app/",
          bearerToken: "test-token",
          fetch: async (input, init) => {
            calls.push({ input, init });
            return jsonResponse(meals);
          }
        }
      });

      expect(calls).toEqual([
        {
          input: "https://compass.example.test/app/api/meal-plan/daily-context?date=2026-06-15",
          init: {
            method: "GET",
            headers: {
              Authorization: "Bearer test-token"
            }
          }
        }
      ]);
      expect(JSON.parse(result.snapshot.compassContextJson)).toEqual({
        available: true,
        sourceUrl: "https://compass.example.test/app/api/meal-plan/daily-context?date=2026-06-15",
        unavailableReason: null,
        meals
      });
      expect(result.renderedMarkdown).toContain("Availability: available");
      expect(result.renderedMarkdown).toContain(
        "Source: https://compass.example.test/app/api/meal-plan/daily-context?date=2026-06-15"
      );
      expect(result.renderedMarkdown).toContain("Meal entries: 2");
    } finally {
      db.close();
    }
  });

  test("previews publishing an existing snapshot without updating storage", async () => {
    const db = migratedDb();

    try {
      seedDailyHealthContext(db);
      const generated = await generateCoachDigestSnapshot(db, {
        date: "2026-06-15",
        now: "2026-06-15T21:00:00.000Z",
        offline: true
      });

      const result = await publishCoachDigestSnapshot(db, {
        snapshotId: generated.snapshot.id,
        dryRun: true,
        now: "2026-06-15T21:10:00.000Z"
      });

      expect(result).toEqual({
        snapshotId: generated.snapshot.id,
        status: "dry_run",
        intendedAction: {
          type: "publish_coach_digest_snapshot",
          date: "2026-06-15",
          sourceHash: generated.sourceHash,
          renderedMarkdown: generated.renderedMarkdown
        }
      });
      expect(readCoachDigestPublishedAt(db, generated.snapshot.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("marks an existing snapshot published only after injected publish succeeds", async () => {
    const db = migratedDb();
    const publishCalls: unknown[] = [];

    try {
      seedDailyHealthContext(db);
      const generated = await generateCoachDigestSnapshot(db, {
        date: "2026-06-15",
        now: "2026-06-15T21:00:00.000Z",
        offline: true
      });

      const result = await publishCoachDigestSnapshot(db, {
        snapshotId: generated.snapshot.id,
        dryRun: false,
        now: "2026-06-15T21:10:00.000Z",
        publish: async (action) => {
          publishCalls.push(action);
          return { boardItemId: "coach-2026-06-15", url: "https://board.example.test/items/1" };
        }
      });

      expect(publishCalls).toEqual([
        {
          type: "publish_coach_digest_snapshot",
          date: "2026-06-15",
          sourceHash: generated.sourceHash,
          renderedMarkdown: generated.renderedMarkdown
        }
      ]);
      expect(result).toEqual({
        snapshotId: generated.snapshot.id,
        status: "published",
        publishedAt: "2026-06-15T21:10:00.000Z",
        publishResult: { boardItemId: "coach-2026-06-15", url: "https://board.example.test/items/1" }
      });
      expect(readCoachDigestPublishedAt(db, generated.snapshot.id)).toBe("2026-06-15T21:10:00.000Z");
      expect(readCoachDigestPublishResult(db, generated.snapshot.id)).toEqual({
        boardItemId: "coach-2026-06-15",
        url: "https://board.example.test/items/1"
      });
    } finally {
      db.close();
    }
  });

  test("reuses stored publish metadata for repeat live publish without calling publisher", async () => {
    const db = migratedDb();
    let repeatPublishCalls = 0;

    try {
      seedDailyHealthContext(db);
      const generated = await generateCoachDigestSnapshot(db, {
        date: "2026-06-15",
        now: "2026-06-15T21:00:00.000Z",
        offline: true
      });
      const first = await publishCoachDigestSnapshot(db, {
        snapshotId: generated.snapshot.id,
        dryRun: false,
        now: "2026-06-15T21:10:00.000Z",
        publish: async () => ({ boardItemId: "coach-2026-06-15", url: "https://board.example.test/items/1" })
      });

      const repeated = await publishCoachDigestSnapshot(db, {
        snapshotId: generated.snapshot.id,
        dryRun: false,
        now: "2026-06-15T21:20:00.000Z",
        publish: async () => {
          repeatPublishCalls += 1;
          return { boardItemId: "duplicate", url: "https://board.example.test/items/duplicate" };
        }
      });

      expect(repeatPublishCalls).toBe(0);
      expect(repeated).toEqual(first);
      expect(readCoachDigestPublishedAt(db, generated.snapshot.id)).toBe("2026-06-15T21:10:00.000Z");
      expect(readCoachDigestPublishResult(db, generated.snapshot.id)).toEqual({
        boardItemId: "coach-2026-06-15",
        url: "https://board.example.test/items/1"
      });
    } finally {
      db.close();
    }
  });

  test("leaves a snapshot unpublished when injected publish fails", async () => {
    const db = migratedDb();

    try {
      seedDailyHealthContext(db);
      const generated = await generateCoachDigestSnapshot(db, {
        date: "2026-06-15",
        now: "2026-06-15T21:00:00.000Z",
        offline: true
      });

      const result = await publishCoachDigestSnapshot(db, {
        snapshotId: generated.snapshot.id,
        dryRun: false,
        now: "2026-06-15T21:10:00.000Z",
        publish: async () => {
          throw new Error("board unavailable");
        }
      });

      expect(result).toEqual({
        snapshotId: generated.snapshot.id,
        status: "blocked",
        reason: "board unavailable"
      });
      expect(readCoachDigestPublishedAt(db, generated.snapshot.id)).toBeNull();
      expect(readCoachDigestPublishResult(db, generated.snapshot.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("rejects publish for a missing snapshot id as a domain input error", async () => {
    const db = migratedDb();

    try {
      await expect(
        publishCoachDigestSnapshot(db, {
          snapshotId: 404,
          dryRun: true,
          now: "2026-06-15T21:10:00.000Z"
        })
      ).rejects.toThrow("coach digest snapshot not found");
    } finally {
      db.close();
    }
  });

  test("rejects invalid date and malformed Compass config before writing rows", async () => {
    const db = migratedDb();
    let called = false;

    try {
      await expect(
        generateCoachDigestSnapshot(db, {
          date: "2026-02-31",
          now: "2026-06-15T21:00:00.000Z",
          offline: true
        })
      ).rejects.toThrow("date must be an ISO date");
      await expect(
        generateCoachDigestSnapshot(db, {
          date: "2026-06-15",
          now: "2026-06-15T21:00:00.000Z",
          compass: {
            baseUrl: "file:///tmp/compass.sqlite",
            fetch: async () => {
              called = true;
              return jsonResponse({});
            }
          }
        })
      ).rejects.toThrow("baseUrl must be an HTTP(S) URL");

      expect(called).toBe(false);
      expect(coachDigestSnapshotCount(db)).toBe(0);
      expect(coachTraceCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });
});

function seedDailyHealthContext(db: Database.Database): void {
  createHealthMetric(
    db,
    {
      metricKey: "Sleep",
      metricLabel: "Sleep",
      value: 7.5,
      unit: "hours",
      observedAt: "2026-06-15T07:00:00.000Z",
      source: "manual",
      note: "steady"
    },
    { now: "2026-06-15T07:05:00.000Z", runId: "seed-sleep" }
  );
  createHealthMetric(
    db,
    {
      metricKey: "Weight",
      metricLabel: "Weight",
      value: 58.2,
      unit: "kg",
      observedAt: "2026-06-15T08:00:00.000Z",
      source: "manual"
    },
    { now: "2026-06-15T08:05:00.000Z", runId: "seed-weight" }
  );
  createHealthMetric(
    db,
    {
      metricKey: "Sleep",
      metricLabel: "Sleep",
      value: 6.5,
      unit: "hours",
      observedAt: "2026-06-14T07:00:00.000Z",
      source: "manual"
    },
    { now: "2026-06-14T07:05:00.000Z", runId: "seed-prior-sleep" }
  );

  createExerciseTemplate(db, {
    slug: "daily-strength",
    name: "Daily Strength",
    defaultDays: [{ sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 }]
  });
  const plan = createExercisePlanFromTemplate(db, {
    templateSlug: "daily-strength",
    weekStart: "2026-06-15"
  });
  completeExerciseSession(db, {
    sessionId: plan.sessions[0]!.id,
    completedAt: "2026-06-15T09:00:00.000Z",
    durationMinutes: 22,
    intensity: "moderate",
    note: "solid"
  });

  ingestSedentarySpan(db, {
    sourceId: "windows-logger:idle-morning",
    spanStart: "2026-06-15T10:00:00.000Z",
    spanEnd: "2026-06-15T11:15:00.000Z",
    state: "idle",
    confidence: 0.9,
    receivedAt: "2026-06-15T11:15:01.000Z"
  });
  ingestSedentarySpan(db, {
    sourceId: "windows-logger:active-lunch",
    spanStart: "2026-06-15T11:15:00.000Z",
    spanEnd: "2026-06-15T11:45:00.000Z",
    state: "active",
    confidence: 0.95,
    receivedAt: "2026-06-15T11:45:01.000Z"
  });
}

function seedSameInstantMetrics(db: Database.Database, order: readonly ["sleep" | "weight", "sleep" | "weight"]): void {
  for (const key of order) {
    if (key === "sleep") {
      createHealthMetric(
        db,
        {
          metricKey: "Sleep",
          metricLabel: "Sleep",
          value: 7.5,
          unit: "hours",
          observedAt: "2026-06-15T07:00:00.000Z",
          source: "manual"
        },
        { now: "2026-06-15T07:05:00.000Z", runId: "seed-sleep" }
      );
    } else {
      createHealthMetric(
        db,
        {
          metricKey: "Weight",
          metricLabel: "Weight",
          value: 58.2,
          unit: "kg",
          observedAt: "2026-06-15T07:00:00.000Z",
          source: "manual"
        },
        { now: "2026-06-15T07:05:00.000Z", runId: "seed-weight" }
      );
    }
  }
}

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function coachTraceCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM health_trace_events WHERE stage = 'coach'").get() as { count: number };
  return row.count;
}

function coachDigestSnapshotCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM coach_digest_snapshots").get() as { count: number };
  return row.count;
}

function readCoachDigestPublishedAt(db: Database.Database, snapshotId: number): string | null {
  const row = db.prepare("SELECT published_at FROM coach_digest_snapshots WHERE id = ?").get(snapshotId) as { published_at: string | null };
  return row.published_at;
}

function readCoachDigestPublishResult(db: Database.Database, snapshotId: number): unknown {
  const row = db.prepare("SELECT publish_result_json FROM coach_digest_snapshots WHERE id = ?").get(snapshotId) as {
    publish_result_json: string | null;
  };
  return row.publish_result_json === null ? null : JSON.parse(row.publish_result_json);
}
