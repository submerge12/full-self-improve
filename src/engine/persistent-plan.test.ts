import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { recordMasteryUpdate } from "../db/content-store.js";
import { addConceptEdge, createConcept } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { createTraceRecorder } from "./trace.js";
import { createPersistentDailyPlan } from "./persistent-plan.js";

describe("persistent daily planner", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("creates and persists a study plan once per date", () => {
    createConcept(db, { slug: "algebra", name: "Algebra", status: "generated" });
    createConcept(db, { slug: "geometry", name: "Geometry", status: "reviewed" });

    const first = createPersistentDailyPlan(db, { date: "2026-06-12", runId: "plan-create" });
    const second = createPersistentDailyPlan(db, { date: "2026-06-12", runId: "plan-reuse" });

    expect(first.date).toBe("2026-06-12");
    expect(first.status).toBe("planned");
    expect(first.queue).toHaveLength(6);
    expect(second.queue).toEqual(first.queue);
    expect(second.rationale).toBe(first.rationale);
    expect(countStudyPlans()).toBe(1);
    expect(readStoredPlanQueue("2026-06-12")).toEqual(first.queue);
  });

  test("returns a deterministic queue snapshot for the same database and date", () => {
    for (const slug of ["algebra", "calculus", "geometry", "probability", "statistics"]) {
      createConcept(db, { slug, name: titleCase(slug), status: "generated" });
    }

    const plan = createPersistentDailyPlan(db, { date: "2026-06-15" });

    expect(plan.queue).toMatchInlineSnapshot(`
      [
        {
          "conceptName": "Geometry",
          "conceptSlug": "geometry",
          "id": "2026-06-15-learn-geometry",
          "order": 1,
          "type": "learn",
        },
        {
          "conceptName": "Geometry",
          "conceptSlug": "geometry",
          "id": "2026-06-15-quiz-geometry",
          "order": 2,
          "type": "quiz",
        },
        {
          "conceptName": "Geometry",
          "conceptSlug": "geometry",
          "id": "2026-06-15-teachback-geometry",
          "order": 3,
          "type": "teachback",
        },
        {
          "conceptName": "Algebra",
          "conceptSlug": "algebra",
          "id": "2026-06-15-learn-algebra",
          "order": 4,
          "type": "learn",
        },
        {
          "conceptName": "Algebra",
          "conceptSlug": "algebra",
          "id": "2026-06-15-quiz-algebra",
          "order": 5,
          "type": "quiz",
        },
        {
          "conceptName": "Algebra",
          "conceptSlug": "algebra",
          "id": "2026-06-15-teachback-algebra",
          "order": 6,
          "type": "teachback",
        },
        {
          "conceptName": "Statistics",
          "conceptSlug": "statistics",
          "id": "2026-06-15-learn-statistics",
          "order": 7,
          "type": "learn",
        },
        {
          "conceptName": "Statistics",
          "conceptSlug": "statistics",
          "id": "2026-06-15-quiz-statistics",
          "order": 8,
          "type": "quiz",
        },
        {
          "conceptName": "Statistics",
          "conceptSlug": "statistics",
          "id": "2026-06-15-teachback-statistics",
          "order": 9,
          "type": "teachback",
        },
        {
          "conceptName": "Calculus",
          "conceptSlug": "calculus",
          "id": "2026-06-15-learn-calculus",
          "order": 10,
          "type": "learn",
        },
        {
          "conceptName": "Calculus",
          "conceptSlug": "calculus",
          "id": "2026-06-15-quiz-calculus",
          "order": 11,
          "type": "quiz",
        },
        {
          "conceptName": "Calculus",
          "conceptSlug": "calculus",
          "id": "2026-06-15-teachback-calculus",
          "order": 12,
          "type": "teachback",
        },
        {
          "conceptName": "Probability",
          "conceptSlug": "probability",
          "id": "2026-06-15-learn-probability",
          "order": 13,
          "type": "learn",
        },
        {
          "conceptName": "Probability",
          "conceptSlug": "probability",
          "id": "2026-06-15-quiz-probability",
          "order": 14,
          "type": "quiz",
        },
        {
          "conceptName": "Probability",
          "conceptSlug": "probability",
          "id": "2026-06-15-teachback-probability",
          "order": 15,
          "type": "teachback",
        },
      ]
    `);
  });

  test("gates dependent concepts until every prerequisite reaches the mastery threshold", () => {
    const fundamentals = createConcept(db, { slug: "fundamentals", name: "Fundamentals", status: "reviewed" });
    const advanced = createConcept(db, { slug: "advanced", name: "Advanced", status: "generated" });
    addConceptEdge(db, {
      fromConceptId: fundamentals.id,
      toConceptId: advanced.id,
      kind: "prerequisite"
    });
    recordMasteryUpdate(db, {
      conceptId: fundamentals.id,
      score: 0.4,
      confidence: 0.6,
      attemptsN: 1,
      lastSeenAt: "2026-06-11T00:00:00.000Z"
    });

    const blocked = createPersistentDailyPlan(db, { date: "2026-06-16", masteryThreshold: 0.8 });
    recordMasteryUpdate(db, {
      conceptId: fundamentals.id,
      score: 0.85,
      confidence: 0.9,
      attemptsN: 2,
      lastSeenAt: "2026-06-16T12:00:00.000Z"
    });
    const unblocked = createPersistentDailyPlan(db, { date: "2026-06-17", masteryThreshold: 0.8 });

    expect(learnSlugs(blocked)).toEqual(["fundamentals"]);
    expect(learnSlugs(unblocked)).toEqual(["advanced"]);
  });

  test("records plan trace events when creating and reusing a persisted plan", () => {
    createConcept(db, { slug: "traceable", name: "Traceable", status: "generated" });
    const trace = createTraceRecorder({ now: () => new Date("2026-06-12T00:00:00.000Z") });

    createPersistentDailyPlan(db, { date: "2026-06-18", runId: "trace-create", trace });
    createPersistentDailyPlan(db, { date: "2026-06-18", runId: "trace-reuse", trace });

    expect(trace.getEvents({ runId: "trace-create", stage: "plan" })).toMatchObject([
      {
        stage: "plan",
        level: "info",
        data: {
          date: "2026-06-18",
          outcome: "created"
        }
      }
    ]);
    expect(trace.getEvents({ runId: "trace-reuse", stage: "plan" })).toMatchObject([
      {
        stage: "plan",
        level: "info",
        data: {
          date: "2026-06-18",
          outcome: "reused"
        }
      }
    ]);
  });

  test("rejects invalid dates and mastery thresholds", () => {
    expect(() => createPersistentDailyPlan(db, { date: "2026-02-31" })).toThrow(/Invalid plan date/);
    expect(() => createPersistentDailyPlan(db, { date: "2026-06-19", masteryThreshold: -0.1 })).toThrow(
      /masteryThreshold/
    );
    expect(() => createPersistentDailyPlan(db, { date: "2026-06-19", masteryThreshold: 1.1 })).toThrow(
      /masteryThreshold/
    );
  });

  test("excludes stub and mastered concepts and can persist an empty plan", () => {
    createConcept(db, { slug: "stub", name: "Stub", status: "stub" });
    const mastered = createConcept(db, { slug: "mastered", name: "Mastered", status: "generated" });
    recordMasteryUpdate(db, {
      conceptId: mastered.id,
      score: 0.8,
      confidence: 0.9,
      attemptsN: 2,
      lastSeenAt: "2026-06-18T00:00:00.000Z"
    });

    const plan = createPersistentDailyPlan(db, { date: "2026-06-19", masteryThreshold: 0.8 });

    expect(plan.queue).toEqual([]);
    expect(plan.status).toBe("planned");
    expect(countStudyPlans()).toBe(1);
    expect(readStoredPlanQueue("2026-06-19")).toEqual([]);
  });

  test("reuses stored status and rationale instead of regenerating for the same date", () => {
    createConcept(db, { slug: "alpha", name: "Alpha", status: "generated" });
    createPersistentDailyPlan(db, { date: "2026-06-20", masteryThreshold: 0.8 });
    db.prepare(
      `UPDATE study_plans
       SET status = 'active', rationale = 'Manually accepted plan'
       WHERE date = ?`
    ).run("2026-06-20");

    const reused = createPersistentDailyPlan(db, { date: "2026-06-20", masteryThreshold: 0.1 });

    expect(reused.status).toBe("active");
    expect(reused.rationale).toBe("Manually accepted plan");
    expect(learnSlugs(reused)).toEqual(["alpha"]);
    expect(countStudyPlans()).toBe(1);
  });

  test("rejects malformed stored plan activities", () => {
    db.prepare(
      `INSERT INTO study_plans (date, queue, rationale, status)
       VALUES (?, ?, ?, 'planned')`
    ).run("2026-06-21", JSON.stringify([null]), "Corrupt queue");

    expect(() => createPersistentDailyPlan(db, { date: "2026-06-21" })).toThrow(/activity 1 is not an object/);
  });

  function countStudyPlans(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM study_plans").get() as { count: number }).count;
  }

  function readStoredPlanQueue(date: string): unknown {
    const row = db.prepare("SELECT queue FROM study_plans WHERE date = ?").get(date) as { queue: string };
    return JSON.parse(row.queue) as unknown;
  }
});

function learnSlugs(plan: ReturnType<typeof createPersistentDailyPlan>): string[] {
  return plan.queue.filter((activity) => activity.type === "learn").map((activity) => activity.conceptSlug);
}

function titleCase(value: string): string {
  return value.slice(0, 1).toLocaleUpperCase("en-US") + value.slice(1);
}
