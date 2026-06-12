import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { recordMasteryUpdate } from "../db/content-store.js";
import { createConcept } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { diagnosePersistentWeakSpots } from "./persistent-diagnose.js";
import { createPersistentDailyPlan } from "./persistent-plan.js";
import { gradePersistentExactQuizAttempt } from "./persistent-quiz.js";
import { createTraceRecorder } from "./trace.js";

describe("persistent diagnose engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("test_diagnose_after_wrong_quiz_returns_weak_spot_and_next_plan_includes_concept", () => {
    createConcept(db, { slug: "concept-x", name: "Concept X", status: "generated" });

    gradePersistentExactQuizAttempt(db, {
      conceptSlug: "concept-x",
      statement: "What is X?",
      answer: "correct",
      response: "wrong",
      lastSeenAt: "2026-06-12T08:00:00.000Z"
    });

    const diagnosis = diagnosePersistentWeakSpots(db, {
      masteryThreshold: 0.8,
      runId: "diagnose-wrong-x"
    });
    const nextPlan = createPersistentDailyPlan(db, { date: "2026-06-13", masteryThreshold: 0.8 });

    expect(diagnosis.weakSpots).toMatchObject([
      {
        conceptSlug: "concept-x",
        conceptName: "Concept X",
        score: 0,
        confidence: 1,
        attemptsN: 1,
        lastSeenAt: "2026-06-12T08:00:00.000Z"
      }
    ]);
    expect(diagnosis.weakSpots[0]?.reasons.length).toBeGreaterThan(0);
    expect(diagnosis.weakSpots[0]?.recommendation).toMatch(/review|practice|re-study/i);
    expect(nextPlan.queue.map((activity) => activity.conceptSlug)).toContain("concept-x");
  });

  test("test_diagnose_excludes_mastered_stub_and_unattempted_generated_concepts", () => {
    const mastered = createConcept(db, { slug: "mastered", name: "Mastered", status: "generated" });
    const stub = createConcept(db, { slug: "stub", name: "Stub", status: "stub" });
    createConcept(db, { slug: "unattempted", name: "Unattempted", status: "generated" });
    recordMasteryUpdate(db, {
      conceptId: mastered.id,
      score: 0.95,
      confidence: 0.9,
      attemptsN: 4,
      lastSeenAt: "2026-06-12T01:00:00.000Z"
    });
    recordMasteryUpdate(db, {
      conceptId: stub.id,
      score: 0.2,
      confidence: 0.3,
      attemptsN: 2,
      lastSeenAt: "2026-06-12T02:00:00.000Z"
    });

    const diagnosis = diagnosePersistentWeakSpots(db, { masteryThreshold: 0.8 });

    expect(diagnosis.weakSpots).toEqual([]);
    expect(diagnosis.summary.weakSpotCount).toBe(0);
  });

  test("test_diagnose_sorts_by_lowest_score_then_slug_and_applies_limit", () => {
    createMasteryConcept("beta", "Beta", 0.2);
    createMasteryConcept("gamma", "Gamma", 0.1);
    createMasteryConcept("alpha", "Alpha", 0.2);

    const diagnosis = diagnosePersistentWeakSpots(db, { masteryThreshold: 0.8, limit: 2 });

    expect(diagnosis.weakSpots.map((weakSpot) => weakSpot.conceptSlug)).toEqual(["gamma", "alpha"]);
  });

  test("test_diagnose_emits_and_returns_trace_event", () => {
    createMasteryConcept("traceable", "Traceable", 0.4);
    const trace = createTraceRecorder({ now: () => new Date("2026-06-12T00:00:00.000Z") });

    const diagnosis = diagnosePersistentWeakSpots(db, {
      masteryThreshold: 0.8,
      runId: "diagnose-trace",
      trace
    });

    expect(diagnosis.traceEvents).toMatchObject([
      {
        runId: "diagnose-trace",
        stage: "diagnose",
        level: "info",
        timestamp: "2026-06-12T00:00:00.000Z",
        data: {
          masteryThreshold: 0.8,
          weakSpotCount: 1
        }
      }
    ]);
    expect(trace.getEvents({ runId: "diagnose-trace", stage: "diagnose" })).toEqual(diagnosis.traceEvents);
  });

  test("test_diagnose_rejects_invalid_threshold_and_limit", () => {
    expect(() => diagnosePersistentWeakSpots(db, { masteryThreshold: -0.1 })).toThrow(/masteryThreshold/);
    expect(() => diagnosePersistentWeakSpots(db, { masteryThreshold: 1.1 })).toThrow(/masteryThreshold/);
    expect(() => diagnosePersistentWeakSpots(db, { masteryThreshold: Number.NaN })).toThrow(/masteryThreshold/);
    expect(() => diagnosePersistentWeakSpots(db, { masteryThreshold: Number.POSITIVE_INFINITY })).toThrow(
      /masteryThreshold/
    );
    expect(() => diagnosePersistentWeakSpots(db, { limit: 0 })).toThrow(/limit/);
    expect(() => diagnosePersistentWeakSpots(db, { limit: -1 })).toThrow(/limit/);
    expect(() => diagnosePersistentWeakSpots(db, { limit: 1.5 })).toThrow(/limit/);
    expect(() => diagnosePersistentWeakSpots(db, { limit: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/limit/);
  });

  test("test_diagnose_accepts_threshold_and_limit_boundaries", () => {
    createMasteryConcept("boundary", "Boundary", 0.5);

    expect(diagnosePersistentWeakSpots(db, { masteryThreshold: 0 }).weakSpots).toEqual([]);
    expect(diagnosePersistentWeakSpots(db, { masteryThreshold: 1, limit: 1 }).weakSpots).toHaveLength(1);
  });

  test("test_diagnose_is_read_only_for_database_tables", () => {
    createMasteryConcept("readonly", "Readonly", 0.3);
    const before = countMutableRows();
    const totalChangesBefore = totalChanges();

    diagnosePersistentWeakSpots(db, { masteryThreshold: 0.8, runId: "diagnose-readonly" });

    expect(countMutableRows()).toEqual(before);
    expect(totalChanges()).toBe(totalChangesBefore);
  });

  function createMasteryConcept(slug: string, name: string, score: number): void {
    const concept = createConcept(db, { slug, name, status: "generated" });
    recordMasteryUpdate(db, {
      conceptId: concept.id,
      score,
      confidence: 0.5,
      attemptsN: 2,
      lastSeenAt: `2026-06-12T0${Math.round(score * 10)}:00:00.000Z`
    });
  }

  function countMutableRows(): Record<AppTableName, number> {
    return {
      sources: countRows("sources"),
      chunks: countRows("chunks"),
      concepts: countRows("concepts"),
      concept_edges: countRows("concept_edges"),
      pages: countRows("pages"),
      items: countRows("items"),
      attempts: countRows("attempts"),
      teachbacks: countRows("teachbacks"),
      mastery: countRows("mastery"),
      study_plans: countRows("study_plans"),
      reviews: countRows("reviews")
    };
  }

  function countRows(tableName: AppTableName): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
  }

  function totalChanges(): number {
    return (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
  }
});

type AppTableName =
  | "sources"
  | "chunks"
  | "concepts"
  | "concept_edges"
  | "pages"
  | "items"
  | "attempts"
  | "teachbacks"
  | "mastery"
  | "study_plans"
  | "reviews";
