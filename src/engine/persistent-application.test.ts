import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createPage, createSourceWithChunk, recordMasteryUpdate } from "../db/content-store.js";
import { createConcept } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { createPersistentApplicationTask, gradePersistentApplicationAttempt } from "./persistent-application.js";
import { createTraceRecorder, type TraceRecorder } from "./trace.js";

describe("persistent application tasks", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("generates and persists a deterministic free-form application task with rubric and trace", () => {
    const { concept, chunk } = createConceptPageFixture({
      slug: "retrieval-practice",
      name: "Retrieval Practice",
      markdown: "Retrieval practice transfers knowledge into realistic planning scenarios with constraints and feedback."
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "Older page mentions recall only.",
      citationIds: [chunk.id],
      visibility: "private"
    });
    const latestPage = createPage(db, {
      conceptId: concept.id,
      version: 2,
      markdown: "Retrieval practice transfers knowledge into realistic planning scenarios with constraints and feedback.",
      citationIds: [chunk.id],
      visibility: "private"
    });
    const trace = createTraceRecorder({ now: () => new Date("2026-06-14T00:00:00.000Z") });

    const result = createPersistentApplicationTask(db, {
      conceptSlug: "retrieval-practice",
      runId: "application-create",
      trace
    });

    expect(result).toEqual({
      runId: "application-create",
      itemId: result.itemId,
      conceptSlug: "retrieval-practice",
      statement:
        "Apply Retrieval Practice to a realistic case. Explain how the idea changes decisions, name likely constraints, and describe expected feedback.",
      difficulty: 3,
      answerSpec: {
        type: "rubric",
        kind: "application",
        conceptSlug: "retrieval-practice",
        pageId: latestPage.id,
        pageVersion: 2,
        citationIds: [chunk.id],
        requiredKeywords: [
          "retrieval",
          "practice",
          "transfer",
          "knowledge",
          "realistic",
          "planning",
          "scenario",
          "constraint",
          "feedback"
        ]
      },
      traceEvents: trace.getEvents({ runId: "application-create" })
    });
    expect(result.itemId).toBeGreaterThan(0);
    expect(readItems()).toEqual([
      {
        id: result.itemId,
        conceptId: concept.id,
        conceptIds: [concept.id],
        type: "free_form",
        difficulty: 3,
        statement: result.statement,
        answerSpec: result.answerSpec
      }
    ]);
    expect(result.traceEvents).toMatchObject([
      {
        runId: "application-create",
        stage: "plan",
        level: "info",
        message: "Application task generated"
      }
    ]);
  });

  test("grades a strong application response as correct, inserts an attempt, updates mastery, and returns trace", () => {
    const { concept, itemId } = createApplicationItemFixture();
    const trace = createTraceRecorder({ now: () => new Date("2026-06-14T01:00:00.000Z") });

    const result = gradePersistentApplicationAttempt(db, {
      itemId,
      response:
        "Retrieval practice uses transfer of knowledge in realistic planning scenarios with constraints and feedback.",
      runId: "application-correct",
      trace,
      lastSeenAt: "2026-06-14T02:00:00.000Z"
    });

    expect(result).toMatchObject({
      runId: "application-correct",
      itemId,
      conceptSlug: "retrieval-practice",
      response:
        "Retrieval practice uses transfer of knowledge in realistic planning scenarios with constraints and feedback.",
      verdict: "correct",
      gradingMethod: "rubric",
      masteryDelta: 0.12,
      rubricReport: {
        score: 1,
        gaps: [],
        matchedKeywords: [
          "retrieval",
          "practice",
          "transfer",
          "knowledge",
          "realistic",
          "planning",
          "scenario",
          "constraint",
          "feedback"
        ],
        missingKeywords: [],
        page: {
          id: expect.any(Number),
          version: 1,
          conceptSlug: "retrieval-practice",
          citationIds: [expect.any(Number)]
        }
      },
      mastery: {
        conceptId: concept.id,
        score: 0.12,
        confidence: 0.85,
        attemptsN: 1,
        lastSeenAt: "2026-06-14T02:00:00.000Z"
      }
    });
    expect(result.attemptId).toBeGreaterThan(0);
    expect(readAttempts()).toEqual([
      {
        id: result.attemptId,
        itemId,
        response:
          "Retrieval practice uses transfer of knowledge in realistic planning scenarios with constraints and feedback.",
        verdict: "correct",
        gradingMethod: "rubric"
      }
    ]);
    expect(result.traceEvents).toEqual(trace.getEvents({ runId: "application-correct" }));
    expect(result.traceEvents.map((event) => event.message)).toEqual([
      "Mastery updated",
      "Application attempt graded"
    ]);
  });

  test("grades partial and incorrect responses deterministically and clamps mastery score", () => {
    const partial = createApplicationItemFixture("partial-application");
    recordMasteryUpdate(db, {
      conceptId: partial.concept.id,
      score: 0.98,
      confidence: 0.7,
      attemptsN: 4,
      lastSeenAt: "2026-06-13T00:00:00.000Z"
    });
    const incorrect = createApplicationItemFixture("incorrect-application");
    recordMasteryUpdate(db, {
      conceptId: incorrect.concept.id,
      score: 0.02,
      confidence: 0.7,
      attemptsN: 2,
      lastSeenAt: "2026-06-13T00:00:00.000Z"
    });

    const partialResult = gradePersistentApplicationAttempt(db, {
      itemId: partial.itemId,
      response: "Retrieval practice uses knowledge.",
      runId: "application-partial"
    });
    const incorrectResult = gradePersistentApplicationAttempt(db, {
      itemId: incorrect.itemId,
      response: "Bananas are yellow and unrelated to the lesson.",
      runId: "application-incorrect"
    });

    expect(partialResult).toMatchObject({
      verdict: "partial",
      masteryDelta: 0.03,
      rubricReport: {
        score: 0.333333333333,
        matchedKeywords: ["retrieval", "practice", "knowledge"],
        missingKeywords: ["transfer", "realistic", "planning", "scenario", "constraint", "feedback"]
      },
      mastery: {
        score: 1,
        confidence: 0.6,
        attemptsN: 5
      }
    });
    expect(incorrectResult).toMatchObject({
      verdict: "incorrect",
      masteryDelta: -0.06,
      rubricReport: {
        score: 0,
        matchedKeywords: [],
        missingKeywords: [
          "retrieval",
          "practice",
          "transfer",
          "knowledge",
          "realistic",
          "planning",
          "scenario",
          "constraint",
          "feedback"
        ]
      },
      mastery: {
        score: 0,
        confidence: 0.35,
        attemptsN: 3
      }
    });
    expect(countRows("attempts")).toBe(2);
  });

  test("rejects task generation inputs without writing items", () => {
    expect(() => {
      createPersistentApplicationTask(db, { conceptSlug: "missing" });
    }).toThrow(/Concept missing was not found/);

    const noPage = createConcept(db, { slug: "no-page", name: "No Page", status: "generated" });
    expect(() => {
      createPersistentApplicationTask(db, { conceptSlug: "no-page" });
    }).toThrow(/No page was found for concept no-page/);

    const punctuation = createConcept(db, { slug: "punctuation-page", name: "Punctuation Page", status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "punctuation.md",
      title: "Punctuation notes",
      fingerprint: "fingerprint-punctuation",
      chunkText: "Punctuation only page."
    });
    createPage(db, {
      conceptId: punctuation.id,
      version: 1,
      markdown: "!!! ??? ...",
      citationIds: [chunk.id],
      visibility: "private"
    });
    expect(() => {
      createPersistentApplicationTask(db, { conceptSlug: "punctuation-page" });
    }).toThrow(/application rubric keywords/);

    expect(() => {
      createPersistentApplicationTask(db, { conceptSlug: "no-page", difficulty: 6 });
    }).toThrow(/difficulty/);

    expect(noPage.id).toBeGreaterThan(0);
    expect(countRows("items")).toBe(0);
  });

  test("rejects blank responses, non-application items, and corrupt rubrics without partial writes", () => {
    const { itemId } = createApplicationItemFixture("reject-application");
    const exactItemId = insertRawItem({
      conceptId: conceptIdForSlug("reject-application"),
      type: "fill_in",
      answerSpec: { type: "exact", answers: ["yes"] }
    });
    const corruptItemId = insertRawItem({
      conceptId: conceptIdForSlug("reject-application"),
      type: "free_form",
      answerSpec: { type: "rubric", kind: "application", requiredKeywords: [] }
    });

    expect(() => {
      gradePersistentApplicationAttempt(db, {
        itemId,
        response: "   "
      });
    }).toThrow(/non-empty response/);
    expect(() => {
      gradePersistentApplicationAttempt(db, {
        itemId: exactItemId,
        response: "yes"
      });
    }).toThrow(/free-form application item/);
    expect(() => {
      gradePersistentApplicationAttempt(db, {
        itemId: corruptItemId,
        response: "anything"
      });
    }).toThrow(/application rubric/);
    expect(() => {
      gradePersistentApplicationAttempt(db, {
        itemId: 999,
        response: "anything"
      });
    }).toThrow(/Item 999 was not found/);

    expect(readAttempts()).toEqual([]);
    expect(countRows("mastery")).toBe(0);
  });

  test("rejects malformed application rubric JSON with the domain error", () => {
    createApplicationItemFixture("malformed-application");
    const malformedItemId = insertRawAnswerSpecItem({
      conceptId: conceptIdForSlug("malformed-application"),
      type: "free_form",
      answerSpec: "{not-json"
    });

    expect(() => {
      gradePersistentApplicationAttempt(db, {
        itemId: malformedItemId,
        response: "anything"
      });
    }).toThrow(`Item ${malformedItemId} does not contain a valid application rubric.`);

    expect(readAttempts()).toEqual([]);
    expect(countRows("mastery")).toBe(0);
  });

  test("rolls back attempt and mastery when mastery trace recording fails", () => {
    const { itemId } = createApplicationItemFixture("rollback-application");
    const trace = createFailingTraceRecorder("Mastery updated");

    expect(() => {
      gradePersistentApplicationAttempt(db, {
        itemId,
        response:
          "Retrieval practice uses transfer of knowledge in realistic planning scenarios with constraints and feedback.",
        runId: "application-trace-failure",
        trace
      });
    }).toThrow("trace write failed");

    expect(readAttempts()).toEqual([]);
    expect(countRows("mastery")).toBe(0);
  });

  function createConceptPageFixture(input: {
    slug: string;
    name: string;
    markdown: string;
  }): {
    concept: { id: number; slug: string };
    chunk: { id: number };
  } {
    const concept = createConcept(db, { slug: input.slug, name: input.name, status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: `${input.slug}.md`,
      title: `${input.name} notes`,
      fingerprint: `fingerprint-${input.slug}`,
      chunkText: input.markdown
    });

    return { concept, chunk };
  }

  function createApplicationItemFixture(slug = "retrieval-practice"): {
    concept: { id: number; slug: string };
    itemId: number;
  } {
    const { concept, chunk } = createConceptPageFixture({
      slug,
      name: "Retrieval Practice",
      markdown: "Retrieval practice transfers knowledge into realistic planning scenarios with constraints and feedback."
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "Retrieval practice transfers knowledge into realistic planning scenarios with constraints and feedback.",
      citationIds: [chunk.id],
      visibility: "private"
    });

    const task = createPersistentApplicationTask(db, {
      conceptSlug: slug,
      difficulty: 4,
      runId: `create-${slug}`
    });

    return {
      concept,
      itemId: task.itemId
    };
  }

  function insertRawItem(input: {
    conceptId: number;
    type: "fill_in" | "free_form";
    answerSpec: unknown;
  }): number {
    const result = db
      .prepare(
        `INSERT INTO items (concept_id, concept_ids, type, difficulty, statement, answer_spec)
         VALUES (?, ?, ?, 3, 'Raw item', ?)`
      )
      .run(input.conceptId, JSON.stringify([input.conceptId]), input.type, JSON.stringify(input.answerSpec));

    return toNumberId(result.lastInsertRowid);
  }

  function insertRawAnswerSpecItem(input: {
    conceptId: number;
    type: "fill_in" | "free_form";
    answerSpec: string;
  }): number {
    db.pragma("ignore_check_constraints = ON");
    try {
      const result = db
        .prepare(
          `INSERT INTO items (concept_id, concept_ids, type, difficulty, statement, answer_spec)
           VALUES (?, ?, ?, 3, 'Raw item', ?)`
        )
        .run(input.conceptId, JSON.stringify([input.conceptId]), input.type, input.answerSpec);

      return toNumberId(result.lastInsertRowid);
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }
  }

  function readItems(): Array<{
    id: number;
    conceptId: number;
    conceptIds: number[];
    type: string;
    difficulty: number;
    statement: string;
    answerSpec: unknown;
  }> {
    const rows = db
      .prepare(
        `SELECT
           id,
           concept_id AS conceptId,
           concept_ids AS conceptIds,
           type,
           difficulty,
           statement,
           answer_spec AS answerSpec
         FROM items
         ORDER BY id`
      )
      .all() as Array<{
      id: number;
      conceptId: number;
      conceptIds: string;
      type: string;
      difficulty: number;
      statement: string;
      answerSpec: string;
    }>;

    return rows.map((row) => ({
      ...row,
      conceptIds: JSON.parse(row.conceptIds) as number[],
      answerSpec: JSON.parse(row.answerSpec) as unknown
    }));
  }

  function readAttempts(): Array<{
    id: number;
    itemId: number;
    response: string;
    verdict: string;
    gradingMethod: string;
  }> {
    return db
      .prepare(
        `SELECT
           id,
           item_id AS itemId,
           response,
           verdict,
           grading_method AS gradingMethod
         FROM attempts
         ORDER BY id`
      )
      .all() as Array<{
      id: number;
      itemId: number;
      response: string;
      verdict: string;
      gradingMethod: string;
    }>;
  }

  function conceptIdForSlug(slug: string): number {
    return (
      db
        .prepare("SELECT id FROM concepts WHERE slug = ?")
        .get(slug) as {
        id: number;
      }
    ).id;
  }

  function countRows(tableName: "items" | "attempts" | "mastery"): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
  }

  function createFailingTraceRecorder(failingMessage: string): TraceRecorder {
    const trace = createTraceRecorder({ now: () => new Date("2026-06-14T03:00:00.000Z") });

    return {
      record(event) {
        if (event.message === failingMessage) {
          throw new Error("trace write failed");
        }

        return trace.record(event);
      },
      getEvents(query) {
        return trace.getEvents(query);
      }
    };
  }

  function toNumberId(id: number | bigint): number {
    if (typeof id === "bigint") {
      const numericId = Number(id);
      if (!Number.isSafeInteger(numericId)) {
        throw new Error(`SQLite row id is outside the safe integer range: ${id.toString()}`);
      }

      return numericId;
    }

    return id;
  }
});
