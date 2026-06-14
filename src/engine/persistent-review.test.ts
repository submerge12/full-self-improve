import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "vitest";

import { createConcept } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { createTraceRecorder } from "./trace.js";
import {
  listDuePersistentReviews,
  recordPersistentReviewAttempt,
  type RecordPersistentReviewAttemptInput,
  upsertPersistentReviewSchedule
} from "./persistent-review.js";

describe("persistent review scheduling", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("upserts one review schedule per concept and canonicalizes dueAt", () => {
    const concept = createConcept(db, { slug: "algebra", name: "Algebra", status: "generated" });

    const first = upsertPersistentReviewSchedule(db, {
      conceptId: concept.id,
      fsrsState: { stability: 2.5, difficulty: 4 },
      dueAt: "2026-06-14T08:30:00+08:00"
    });
    const second = upsertPersistentReviewSchedule(db, {
      conceptId: concept.id,
      fsrsState: { stability: 3, reps: 2 },
      dueAt: new Date("2026-06-16T12:00:00.000Z")
    });

    expect(first.conceptSlug).toBe("algebra");
    expect(first.dueAt).toBe("2026-06-14T00:30:00.000Z");
    expect(second.id).toBe(first.id);
    expect(second.fsrsState).toEqual({ stability: 3, reps: 2 });
    expect(second.dueAt).toBe("2026-06-16T12:00:00.000Z");
    expect(countReviews()).toBe(1);
  });

  test("preserves valid nested JSON object fsrsState values", () => {
    const concept = createConcept(db, { slug: "nested", name: "Nested", status: "generated" });
    const fsrsState = {
      card: "nested",
      stability: 2.5,
      retrievability: null,
      flags: [true, false],
      history: [
        { rating: "good", elapsedDays: 1 },
        { rating: "again", elapsedDays: 0 }
      ]
    };

    const review = upsertPersistentReviewSchedule(db, {
      conceptId: concept.id,
      fsrsState,
      dueAt: "2026-06-14T00:00:00.000Z"
    });

    expect(review.fsrsState).toEqual(fsrsState);
  });

  test("rejects lossy or non-JSON fsrsState members before serialization", () => {
    const concept = createConcept(db, { slug: "lossy", name: "Lossy", status: "generated" });
    const circularState: { self?: unknown } = {};
    circularState.self = circularState;
    const invalidStates: Array<{ name: string; fsrsState: unknown }> = [
      { name: "top-level undefined property", fsrsState: { stability: undefined } },
      { name: "top-level function property", fsrsState: { scheduler: () => "again" } },
      { name: "top-level symbol property", fsrsState: { marker: Symbol("fsrs") } },
      { name: "nested undefined object value", fsrsState: { nested: { stability: undefined } } },
      { name: "nested function object value", fsrsState: { nested: { scheduler: () => "again" } } },
      { name: "nested symbol object value", fsrsState: { nested: { marker: Symbol("fsrs") } } },
      { name: "nested undefined array value", fsrsState: { history: [undefined] } },
      { name: "nested function array value", fsrsState: { history: [() => "again"] } },
      { name: "nested symbol array value", fsrsState: { history: [Symbol("fsrs")] } },
      { name: "NaN number", fsrsState: { stability: Number.NaN } },
      { name: "infinite number", fsrsState: { stability: Number.POSITIVE_INFINITY } },
      { name: "nested non-finite number", fsrsState: { nested: { stability: Number.NEGATIVE_INFINITY } } },
      { name: "bigint value", fsrsState: { stability: 1n } },
      { name: "circular structure", fsrsState: circularState }
    ];

    for (const { name, fsrsState } of invalidStates) {
      expect(
        () =>
          upsertPersistentReviewSchedule(db, {
            conceptId: concept.id,
            fsrsState,
            dueAt: "2026-06-14T00:00:00.000Z"
          }),
        name
      ).toThrow(/fsrsState/);
    }
    expect(countReviews()).toBe(0);
  });

  test("rejects non-plain fsrsState objects before serialization", () => {
    const concept = createConcept(db, { slug: "non-plain", name: "Non Plain", status: "generated" });
    class FsrsState {
      stability = 2.5;
    }
    const invalidStates: Array<{ name: string; fsrsState: unknown }> = [
      { name: "root Map", fsrsState: new Map([["stability", 2.5]]) },
      { name: "root Set", fsrsState: new Set([1, 2]) },
      { name: "root Date", fsrsState: new Date("2026-06-14T00:00:00.000Z") },
      { name: "root RegExp", fsrsState: /fsrs/u },
      { name: "root class instance", fsrsState: new FsrsState() },
      { name: "nested Map in object", fsrsState: { nested: new Map([["stability", 2.5]]) } },
      { name: "nested Set in object", fsrsState: { nested: new Set([1, 2]) } },
      { name: "nested class instance in object", fsrsState: { nested: new FsrsState() } },
      { name: "nested Map in array", fsrsState: { history: [new Map([["stability", 2.5]])] } },
      { name: "nested Set in array", fsrsState: { history: [new Set([1, 2])] } },
      { name: "nested class instance in array", fsrsState: { history: [new FsrsState()] } }
    ];

    for (const { name, fsrsState } of invalidStates) {
      expect(
        () =>
          upsertPersistentReviewSchedule(db, {
            conceptId: concept.id,
            fsrsState,
            dueAt: "2026-06-14T00:00:00.000Z"
          }),
        name
      ).toThrow(/fsrsState/);
    }
    expect(countReviews()).toBe(0);
  });

  test("accepts null-prototype plain fsrsState records", () => {
    const concept = createConcept(db, { slug: "null-prototype", name: "Null Prototype", status: "generated" });
    const nested = Object.create(null) as Record<string, unknown>;
    nested.difficulty = 4;
    const historyEntry = Object.create(null) as Record<string, unknown>;
    historyEntry.rating = "good";
    const fsrsState = Object.create(null) as Record<string, unknown>;
    fsrsState.stability = 2.5;
    fsrsState.nested = nested;
    fsrsState.history = [historyEntry];

    const review = upsertPersistentReviewSchedule(db, {
      conceptId: concept.id,
      fsrsState,
      dueAt: "2026-06-14T00:00:00.000Z"
    });

    expect(review.fsrsState).toEqual({
      stability: 2.5,
      nested: { difficulty: 4 },
      history: [{ rating: "good" }]
    });
  });

  test("lists due reviews ordered by dueAt and concept slug", () => {
    const beta = createConcept(db, { slug: "beta", name: "Beta", status: "generated" });
    const gamma = createConcept(db, { slug: "gamma", name: "Gamma", status: "reviewed" });
    const alpha = createConcept(db, { slug: "alpha", name: "Alpha", status: "generated" });
    upsertPersistentReviewSchedule(db, {
      conceptId: gamma.id,
      fsrsState: { card: "gamma" },
      dueAt: "2026-06-14T10:00:00.000Z"
    });
    upsertPersistentReviewSchedule(db, {
      conceptId: beta.id,
      fsrsState: { card: "beta" },
      dueAt: "2026-06-13T23:00:00.000Z"
    });
    upsertPersistentReviewSchedule(db, {
      conceptId: alpha.id,
      fsrsState: { card: "alpha" },
      dueAt: "2026-06-14T10:00:00.000Z"
    });

    const due = listDuePersistentReviews(db, { target: "2026-06-14" });

    expect(due.map((review) => review.conceptSlug)).toEqual(["beta", "alpha", "gamma"]);
    expect(due.map((review) => review.fsrsState)).toEqual([{ card: "beta" }, { card: "alpha" }, { card: "gamma" }]);
  });

  test("excludes future reviews and stub concepts", () => {
    const due = createConcept(db, { slug: "due", name: "Due", status: "reviewed" });
    const future = createConcept(db, { slug: "future", name: "Future", status: "generated" });
    const stub = createConcept(db, { slug: "stub", name: "Stub", status: "stub" });
    upsertPersistentReviewSchedule(db, {
      conceptId: due.id,
      fsrsState: { due: true },
      dueAt: "2026-06-14T23:59:59.999Z"
    });
    upsertPersistentReviewSchedule(db, {
      conceptId: future.id,
      fsrsState: { future: true },
      dueAt: "2026-06-15T00:00:00.000Z"
    });
    upsertPersistentReviewSchedule(db, {
      conceptId: stub.id,
      fsrsState: { stub: true },
      dueAt: "2026-06-14T12:00:00.000Z"
    });

    expect(listDuePersistentReviews(db, { target: new Date("2026-06-14T00:00:00.000Z") })).toMatchObject([
      {
        conceptSlug: "due",
        dueAt: "2026-06-14T23:59:59.999Z"
      }
    ]);
  });

  test("honors positive safe integer limits", () => {
    for (const slug of ["alpha", "beta"]) {
      const concept = createConcept(db, { slug, name: slug, status: "generated" });
      upsertPersistentReviewSchedule(db, {
        conceptId: concept.id,
        fsrsState: { slug },
        dueAt: "2026-06-14T01:00:00.000Z"
      });
    }

    expect(listDuePersistentReviews(db, { target: "2026-06-14", limit: 1 }).map((review) => review.conceptSlug)).toEqual([
      "alpha"
    ]);
    expect(() => listDuePersistentReviews(db, { target: "2026-06-14", limit: 0 })).toThrow(/limit/);
    expect(() => listDuePersistentReviews(db, { target: "2026-06-14", limit: 1.5 })).toThrow(/limit/);
  });

  test("validates target date, concept existence, dueAt, and fsrsState", () => {
    const concept = createConcept(db, { slug: "valid", name: "Valid", status: "generated" });

    expect(() => listDuePersistentReviews(db, { target: "2026-02-31" })).toThrow(/Invalid review target/);
    expect(() =>
      upsertPersistentReviewSchedule(db, {
        conceptId: 999,
        fsrsState: {},
        dueAt: "2026-06-14T00:00:00.000Z"
      })
    ).toThrow(/Concept 999/);
    expect(() =>
      upsertPersistentReviewSchedule(db, {
        conceptId: concept.id,
        fsrsState: {},
        dueAt: "not-a-date"
      })
    ).toThrow(/dueAt/);
    for (const fsrsState of [null, [], "scalar"]) {
      expect(() =>
        upsertPersistentReviewSchedule(db, {
          conceptId: concept.id,
          fsrsState,
          dueAt: "2026-06-14T00:00:00.000Z"
        })
      ).toThrow(/fsrsState/);
    }
  });

  test("rejects malformed or non-object stored fsrs_state", () => {
    const malformed = createConcept(db, { slug: "malformed", name: "Malformed", status: "generated" });
    db.pragma("ignore_check_constraints = ON");
    db.prepare(
      `INSERT INTO reviews (concept_id, fsrs_state, due_at)
       VALUES (?, ?, ?)`
    ).run(malformed.id, "not-json", "2026-06-14T00:00:00.000Z");
    db.pragma("ignore_check_constraints = OFF");

    expect(() => listDuePersistentReviews(db, { target: "2026-06-14" })).toThrow(/fsrs_state.*JSON object/);

    db.prepare("UPDATE reviews SET fsrs_state = ? WHERE concept_id = ?").run("[]", malformed.id);

    expect(() => listDuePersistentReviews(db, { target: "2026-06-14" })).toThrow(/fsrs_state.*JSON object/);
  });

  test("records a good review attempt, advances due date, preserves opaque state, updates mastery and trace", () => {
    const concept = createConcept(db, { slug: "spacing-effect", name: "Spacing Effect", status: "generated" });
    const trace = createTraceRecorder({
      now: () => new Date("2026-06-14T08:05:00.000Z")
    });
    upsertPersistentReviewSchedule(db, {
      conceptId: concept.id,
      fsrsState: {
        stability: 2.5,
        opaque: { scheduler: "mock", nested: [true, null] },
        reviewCount: 2,
        lapses: 1
      },
      dueAt: "2026-06-13T00:00:00.000Z"
    });

    const result = recordPersistentReviewAttempt(db, {
      conceptSlug: "spacing-effect",
      rating: "good",
      reviewedAt: "2026-06-14T08:00:00+08:00",
      runId: "review-run",
      trace
    });

    expect(result).toMatchObject({
      runId: "review-run",
      conceptSlug: "spacing-effect",
      rating: "good",
      reviewedAt: "2026-06-14T00:00:00.000Z",
      previousDueAt: "2026-06-13T00:00:00.000Z",
      nextDueAt: "2026-06-18T00:00:00.000Z",
      masteryDelta: 0.06
    });
    expect(result.fsrsState).toEqual({
      stability: 2.5,
      opaque: { scheduler: "mock", nested: [true, null] },
      reviewCount: 3,
      lapses: 1,
      lastRating: "good",
      lastReviewedAt: "2026-06-14T00:00:00.000Z",
      nextIntervalDays: 4
    });
    expect(result.mastery).toMatchObject({
      conceptId: concept.id,
      score: 0.06,
      confidence: 0.8,
      attemptsN: 1,
      lastSeenAt: "2026-06-14T00:00:00.000Z"
    });
    expect(getReviewRow(concept.id)).toEqual({
      dueAt: "2026-06-18T00:00:00.000Z",
      fsrsState: JSON.stringify(result.fsrsState)
    });
    expect(result.traceEvents).toHaveLength(2);
    expect(result.traceEvents.map((event) => event.stage)).toEqual(["grade", "grade"]);
    expect(result.traceEvents[0]).toMatchObject({
      runId: "review-run",
      stage: "grade",
      level: "info",
      message: "Review attempt recorded",
      data: {
        outcome: "accepted",
        rating: "good",
        conceptSlug: "spacing-effect",
        nextDueAt: "2026-06-18T00:00:00.000Z",
        masteryDelta: 0.06
      }
    });
    expect(result.traceEvents[1]).toMatchObject({
      message: "Mastery updated",
      data: {
        outcome: "accepted",
        conceptId: concept.id,
        score: 0.06,
        confidence: 0.8,
        attemptsN: 1,
        lastSeenAt: "2026-06-14T00:00:00.000Z"
      }
    });
  });

  test("exposes reviewedAt as a required review attempt input field", () => {
    expectTypeOf<RecordPersistentReviewAttemptInput["reviewedAt"]>().toEqualTypeOf<string | Date>();
  });

  test("uses rating-specific intervals, mastery deltas, confidence, lapses, and review counts", () => {
    const cases = [
      { rating: "again", intervalDays: 1, masteryDelta: -0.08, confidence: 0.4, expectedLapses: 3 },
      { rating: "hard", intervalDays: 2, masteryDelta: -0.02, confidence: 0.4, expectedLapses: 2 },
      { rating: "good", intervalDays: 4, masteryDelta: 0.06, confidence: 0.8, expectedLapses: 2 },
      { rating: "easy", intervalDays: 7, masteryDelta: 0.1, confidence: 0.8, expectedLapses: 2 }
    ] as const;

    for (const spec of cases) {
      const concept = createConcept(db, {
        slug: `rating-${spec.rating}`,
        name: `Rating ${spec.rating}`,
        status: "generated"
      });
      upsertPersistentReviewSchedule(db, {
        conceptId: concept.id,
        fsrsState: { reviewCount: 4, lapses: 2 },
        dueAt: "2026-06-14T00:00:00.000Z"
      });

      const result = recordPersistentReviewAttempt(db, {
        conceptSlug: concept.slug,
        rating: spec.rating,
        reviewedAt: "2026-06-15T00:00:00.000Z",
        runId: `run-${spec.rating}`
      });

      expect(result.masteryDelta).toBe(spec.masteryDelta);
      expect(result.nextDueAt).toBe(`2026-06-${15 + spec.intervalDays}T00:00:00.000Z`);
      expect(result.fsrsState).toMatchObject({
        lastRating: spec.rating,
        reviewCount: 5,
        lapses: spec.expectedLapses,
        lastReviewedAt: "2026-06-15T00:00:00.000Z",
        nextIntervalDays: spec.intervalDays
      });
      expect(result.mastery).toMatchObject({
        score: Math.max(0, spec.masteryDelta),
        confidence: spec.confidence,
        attemptsN: 1,
        lastSeenAt: "2026-06-15T00:00:00.000Z"
      });
    }
  });

  test("rejects invalid rating, reviewedAt, missing review, and missing concept without partial writes", () => {
    const concept = createConcept(db, { slug: "invalid-review", name: "Invalid Review", status: "generated" });
    upsertPersistentReviewSchedule(db, {
      conceptId: concept.id,
      fsrsState: { reviewCount: 1, lapses: 0 },
      dueAt: "2026-06-14T00:00:00.000Z"
    });

    for (const input of [
      { conceptSlug: "invalid-review", rating: "later", reviewedAt: "2026-06-14T00:00:00.000Z" },
      { conceptSlug: "invalid-review", rating: "good" },
      { conceptSlug: "invalid-review", rating: "good", reviewedAt: "2026-02-31" },
      { conceptSlug: "no-schedule", rating: "good", reviewedAt: "2026-06-14T00:00:00.000Z" },
      { conceptSlug: "missing-concept", rating: "good", reviewedAt: "2026-06-14T00:00:00.000Z" }
    ]) {
      if (input.conceptSlug === "no-schedule") {
        createConcept(db, { slug: "no-schedule", name: "No Schedule", status: "generated" });
      }

      expect(() =>
        recordPersistentReviewAttempt(db, input as unknown as RecordPersistentReviewAttemptInput)
      ).toThrow(/rating|reviewedAt|Review schedule|Concept/);
      expect(getReviewRow(concept.id)).toEqual({
        dueAt: "2026-06-14T00:00:00.000Z",
        fsrsState: JSON.stringify({ reviewCount: 1, lapses: 0 })
      });
      expect(countMastery()).toBe(0);
    }
  });

  test("rejects corrupt stored fsrs_state without partial writes", () => {
    const concept = createConcept(db, { slug: "corrupt-review", name: "Corrupt Review", status: "generated" });
    upsertPersistentReviewSchedule(db, {
      conceptId: concept.id,
      fsrsState: { reviewCount: 1, lapses: 0 },
      dueAt: "2026-06-14T00:00:00.000Z"
    });
    db.prepare(
      `INSERT INTO mastery (concept_id, score, confidence, attempts_n, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(concept.id, 0.5, 0.8, 3, "2026-06-13T00:00:00.000Z");
    db.prepare("UPDATE reviews SET fsrs_state = ? WHERE concept_id = ?").run("[]", concept.id);

    expect(() =>
      recordPersistentReviewAttempt(db, {
        conceptSlug: "corrupt-review",
        rating: "good",
        reviewedAt: "2026-06-14T00:00:00.000Z"
      })
    ).toThrow(/fsrs_state.*JSON object/);

    expect(getReviewRow(concept.id)).toEqual({
      dueAt: "2026-06-14T00:00:00.000Z",
      fsrsState: "[]"
    });
    expect(getMasteryRow(concept.id)).toEqual({
      score: 0.5,
      confidence: 0.8,
      attemptsN: 3,
      lastSeenAt: "2026-06-13T00:00:00.000Z"
    });
  });

  test("clamps review mastery at 0 and 1", () => {
    const low = createConcept(db, { slug: "low-clamp", name: "Low Clamp", status: "generated" });
    const high = createConcept(db, { slug: "high-clamp", name: "High Clamp", status: "generated" });
    for (const concept of [low, high]) {
      upsertPersistentReviewSchedule(db, {
        conceptId: concept.id,
        fsrsState: {},
        dueAt: "2026-06-14T00:00:00.000Z"
      });
    }
    db.prepare(
      `INSERT INTO mastery (concept_id, score, confidence, attempts_n, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(low.id, 0.03, 0.8, 1, "2026-06-13T00:00:00.000Z");
    db.prepare(
      `INSERT INTO mastery (concept_id, score, confidence, attempts_n, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(high.id, 0.96, 0.8, 1, "2026-06-13T00:00:00.000Z");

    const lowResult = recordPersistentReviewAttempt(db, {
      conceptSlug: "low-clamp",
      rating: "again",
      reviewedAt: "2026-06-14T00:00:00.000Z"
    });
    const highResult = recordPersistentReviewAttempt(db, {
      conceptSlug: "high-clamp",
      rating: "easy",
      reviewedAt: "2026-06-14T00:00:00.000Z"
    });

    expect(lowResult.mastery.score).toBe(0);
    expect(highResult.mastery.score).toBe(1);
    expect(lowResult.mastery.attemptsN).toBe(2);
    expect(highResult.mastery.attemptsN).toBe(2);
  });

  function countReviews(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM reviews").get() as { count: number }).count;
  }

  function countMastery(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM mastery").get() as { count: number }).count;
  }

  function getReviewRow(conceptId: number): { dueAt: string; fsrsState: string } {
    return db
      .prepare(
        `SELECT due_at AS dueAt, fsrs_state AS fsrsState
         FROM reviews
         WHERE concept_id = ?`
      )
      .get(conceptId) as { dueAt: string; fsrsState: string };
  }

  function getMasteryRow(conceptId: number): {
    score: number;
    confidence: number;
    attemptsN: number;
    lastSeenAt: string | null;
  } {
    return db
      .prepare(
        `SELECT score, confidence, attempts_n AS attemptsN, last_seen_at AS lastSeenAt
         FROM mastery
         WHERE concept_id = ?`
      )
      .get(conceptId) as {
      score: number;
      confidence: number;
      attemptsN: number;
      lastSeenAt: string | null;
    };
  }
});
