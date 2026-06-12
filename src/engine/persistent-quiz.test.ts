import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { recordMasteryUpdate } from "../db/content-store.js";
import { createConcept } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { createTraceRecorder } from "./trace.js";
import { gradePersistentExactQuizAttempt } from "./persistent-quiz.js";

describe("persistent exact quiz grading", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("persists a correct exact answer attempt and increases mastery from default zero", () => {
    createConcept(db, { slug: "mitochondria", name: "Mitochondria", status: "generated" });
    const trace = createTraceRecorder({ now: () => new Date("2026-06-12T00:00:00.000Z") });

    const result = gradePersistentExactQuizAttempt(db, {
      conceptSlug: "mitochondria",
      statement: "Which organelle is the powerhouse of the cell?",
      answer: "mitochondria",
      response: " mitochondria ",
      runId: "persistent-quiz-correct",
      trace,
      lastSeenAt: "2026-06-12T01:00:00.000Z"
    });

    expect(result).toMatchObject({
      runId: "persistent-quiz-correct",
      conceptSlug: "mitochondria",
      response: " mitochondria ",
      verdict: "correct",
      masteryDelta: 0.1,
      gradingMethod: "exact",
      mastery: {
        score: 0.1,
        confidence: 1,
        attemptsN: 1,
        lastSeenAt: "2026-06-12T01:00:00.000Z"
      }
    });
    expect(result.itemId).toBeGreaterThan(0);
    expect(result.attemptId).toBeGreaterThan(0);
    expect(readItems()).toMatchObject([
      {
        conceptSlug: "mitochondria",
        type: "fill_in",
        difficulty: 1,
        statement: "Which organelle is the powerhouse of the cell?",
        answerSpec: { type: "exact", answers: ["mitochondria"] }
      }
    ]);
    expect(readAttempts()).toEqual([
      {
        itemId: result.itemId,
        response: " mitochondria ",
        verdict: "correct",
        gradingMethod: "exact"
      }
    ]);
    expect(trace.getEvents({ runId: "persistent-quiz-correct", stage: "grade" })).toHaveLength(2);
  });

  test("persists an incorrect exact answer attempt and decreases existing mastery", () => {
    const concept = createConcept(db, { slug: "photosynthesis", name: "Photosynthesis", status: "reviewed" });
    recordMasteryUpdate(db, {
      conceptId: concept.id,
      score: 0.2,
      confidence: 0.5,
      attemptsN: 3,
      lastSeenAt: "2026-06-11T00:00:00.000Z"
    });

    const result = gradePersistentExactQuizAttempt(db, {
      conceptSlug: "photosynthesis",
      statement: "What gas do plants release during photosynthesis?",
      answers: ["oxygen", "O2"],
      response: "carbon dioxide",
      runId: "persistent-quiz-incorrect",
      lastSeenAt: "2026-06-12T02:00:00.000Z"
    });

    expect(result.verdict).toBe("incorrect");
    expect(result.masteryDelta).toBe(-0.05);
    expect(result.mastery.score).toBe(0.15);
    expect(result.mastery.attemptsN).toBe(4);
    expect(readAttempts()).toMatchObject([
      {
        itemId: result.itemId,
        response: "carbon dioxide",
        verdict: "incorrect",
        gradingMethod: "exact"
      }
    ]);
  });

  test("clamps mastery score at zero and one", () => {
    const high = createConcept(db, { slug: "high", name: "High", status: "generated" });
    createConcept(db, { slug: "low", name: "Low", status: "generated" });
    recordMasteryUpdate(db, { conceptId: high.id, score: 0.95, confidence: 1, attemptsN: 1 });

    const correct = gradePersistentExactQuizAttempt(db, {
      conceptSlug: "high",
      statement: "High?",
      answer: "yes",
      response: "yes"
    });
    const incorrect = gradePersistentExactQuizAttempt(db, {
      conceptSlug: "low",
      statement: "Low?",
      answer: "yes",
      response: "no"
    });

    expect(correct.mastery.score).toBe(1);
    expect(incorrect.mastery.score).toBe(0);
    expect(countRows("attempts")).toBe(2);
  });

  test("rejects a missing concept without partial writes", () => {
    expect(() => {
      gradePersistentExactQuizAttempt(db, {
        conceptSlug: "missing",
        statement: "Missing?",
        answer: "yes",
        response: "yes"
      });
    }).toThrow(/Concept missing was not found/);

    expect(countRows("items")).toBe(0);
    expect(countRows("attempts")).toBe(0);
    expect(countRows("mastery")).toBe(0);
  });

  test("rejects invalid quiz inputs without partial writes", () => {
    createConcept(db, { slug: "invalid", name: "Invalid", status: "generated" });

    expect(() => {
      gradePersistentExactQuizAttempt(db, {
        conceptSlug: "invalid",
        statement: "Invalid difficulty",
        answer: "yes",
        response: "yes",
        difficulty: 0
      });
    }).toThrow(/difficulty/);
    expect(() => {
      gradePersistentExactQuizAttempt(db, {
        conceptSlug: "invalid",
        statement: "Empty answer",
        answers: [],
        response: "yes"
      });
    }).toThrow(/at least one answer/);
    expect(() => {
      gradePersistentExactQuizAttempt(db, {
        conceptSlug: "invalid",
        statement: "Blank answer",
        answer: "",
        response: ""
      });
    }).toThrow(/non-empty answer/);
    expect(() => {
      gradePersistentExactQuizAttempt(db, {
        conceptSlug: "invalid",
        statement: "Whitespace answer",
        answers: ["   "],
        response: ""
      });
    }).toThrow(/non-empty answer/);
    expect(() => {
      gradePersistentExactQuizAttempt(db, {
        conceptSlug: "invalid",
        statement: "Blank answer spec",
        answerSpec: { type: "exact", answers: [""] },
        response: ""
      });
    }).toThrow(/non-empty answer/);

    expect(countRows("items")).toBe(0);
    expect(countRows("attempts")).toBe(0);
    expect(countRows("mastery")).toBe(0);
  });

  test("preserves exact answer spec trim and case-sensitive options", () => {
    createConcept(db, { slug: "spec", name: "Spec", status: "generated" });

    const trimFalse = gradePersistentExactQuizAttempt(db, {
      conceptSlug: "spec",
      statement: "Match spacing exactly",
      answerSpec: { type: "exact", answers: [" yes "], trim: false },
      response: " yes "
    });
    const caseSensitive = gradePersistentExactQuizAttempt(db, {
      conceptSlug: "spec",
      statement: "Match case exactly",
      answerSpec: { type: "exact", answers: ["ATP"], caseSensitive: true },
      response: "atp"
    });

    expect(trimFalse.verdict).toBe("correct");
    expect(caseSensitive.verdict).toBe("incorrect");
    expect(countRows("items")).toBe(2);
    expect(countRows("attempts")).toBe(2);
  });

  function readItems(): Array<{
    conceptSlug: string;
    type: string;
    difficulty: number;
    statement: string;
    answerSpec: unknown;
  }> {
    const rows = db
      .prepare(
        `SELECT
           concepts.slug AS conceptSlug,
           items.type,
           items.difficulty,
           items.statement,
           items.answer_spec AS answerSpec
         FROM items
         INNER JOIN concepts ON concepts.id = items.concept_id
         ORDER BY items.id`
      )
      .all() as Array<{
      conceptSlug: string;
      type: string;
      difficulty: number;
      statement: string;
      answerSpec: string;
    }>;

    return rows.map((row) => ({
      ...row,
      answerSpec: JSON.parse(row.answerSpec) as unknown
    }));
  }

  function readAttempts(): Array<{
    itemId: number;
    response: string;
    verdict: string;
    gradingMethod: string;
  }> {
    return db
      .prepare(
        `SELECT
           item_id AS itemId,
           response,
           verdict,
           grading_method AS gradingMethod
         FROM attempts
         ORDER BY id`
      )
      .all() as Array<{
      itemId: number;
      response: string;
      verdict: string;
      gradingMethod: string;
    }>;
  }

  function countRows(tableName: "items" | "attempts" | "mastery"): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
  }
});
