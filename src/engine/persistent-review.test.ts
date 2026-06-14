import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createConcept } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { listDuePersistentReviews, upsertPersistentReviewSchedule } from "./persistent-review.js";

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

  function countReviews(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM reviews").get() as { count: number }).count;
  }
});
