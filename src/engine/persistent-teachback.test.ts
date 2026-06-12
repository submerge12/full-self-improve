import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createPage, createSourceWithChunk, recordMasteryUpdate } from "../db/content-store.js";
import { createConcept } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { createTraceRecorder } from "./trace.js";
import { gradePersistentTeachback } from "./persistent-teachback.js";

describe("persistent teach-back grading", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("persists a teachback, stores rubric report with latest page reference, updates mastery, and returns trace events", () => {
    const concept = createConcept(db, { slug: "retrieval-practice", name: "Retrieval Practice", status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "retrieval.md",
      title: "Retrieval practice notes",
      fingerprint: "fingerprint-retrieval",
      chunkText: "Retrieval practice strengthens memory by recalling knowledge before review."
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "Older page: recall knowledge.",
      citationIds: [chunk.id],
      visibility: "private"
    });
    const latestPage = createPage(db, {
      conceptId: concept.id,
      version: 2,
      markdown: "Retrieval practice strengthens memory by active recall before review.",
      citationIds: [chunk.id],
      visibility: "private"
    });
    const trace = createTraceRecorder({ now: () => new Date("2026-06-12T00:00:00.000Z") });

    const result = gradePersistentTeachback(db, {
      conceptSlug: "retrieval-practice",
      transcript: "  Retrieval practice means using active recall before review to strengthen memory.  ",
      runId: "persistent-teachback-strong",
      trace,
      lastSeenAt: "2026-06-12T03:00:00.000Z"
    });

    expect(result).toMatchObject({
      runId: "persistent-teachback-strong",
      teachbackId: expect.any(Number),
      conceptSlug: "retrieval-practice",
      transcript: "Retrieval practice means using active recall before review to strengthen memory.",
      gradingMethod: "rubric",
      rubricReport: {
        gradingMethod: "rubric",
        page: {
          id: latestPage.id,
          version: 2,
          conceptSlug: "retrieval-practice",
          citationIds: [chunk.id]
        }
      },
      mastery: {
        conceptId: concept.id,
        attemptsN: 1,
        lastSeenAt: "2026-06-12T03:00:00.000Z"
      }
    });
    expect(result.rubricReport.score).toBeGreaterThanOrEqual(0.7);
    expect(result.rubricReport.score).toBeLessThanOrEqual(1);
    expect(result.rubricReport.gaps).toEqual([]);
    expect(result.masteryDelta).toBeGreaterThan(0);
    expect(result.mastery.score).toBe(result.masteryDelta);
    expect(readTeachbacks()).toEqual([
      {
        id: result.teachbackId,
        conceptSlug: "retrieval-practice",
        transcript: "Retrieval practice means using active recall before review to strengthen memory.",
        rubricReport: result.rubricReport
      }
    ]);
    expect(result.traceEvents).toEqual(trace.getEvents({ runId: "persistent-teachback-strong" }));
    expect(result.traceEvents.filter((event) => event.stage === "grade")).toHaveLength(2);
  });

  test("weak irrelevant transcript produces gaps and decreases existing mastery deterministically", () => {
    const concept = createConcept(db, { slug: "spaced-repetition", name: "Spaced Repetition", status: "reviewed" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "spaced.md",
      title: "Spaced repetition notes",
      fingerprint: "fingerprint-spaced",
      chunkText: "Spaced repetition schedules reviews over increasing intervals."
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "Spaced repetition schedules reviews over increasing intervals to slow forgetting.",
      citationIds: [chunk.id],
      visibility: "private"
    });
    recordMasteryUpdate(db, {
      conceptId: concept.id,
      score: 0.4,
      confidence: 0.5,
      attemptsN: 2,
      lastSeenAt: "2026-06-11T00:00:00.000Z"
    });

    const result = gradePersistentTeachback(db, {
      conceptSlug: "spaced-repetition",
      transcript: "Bananas are yellow and unrelated to the lesson.",
      runId: "persistent-teachback-weak",
      lastSeenAt: "2026-06-12T04:00:00.000Z"
    });

    expect(result.rubricReport.score).toBeLessThan(0.5);
    expect(result.rubricReport.gaps.length).toBeGreaterThan(0);
    expect(result.rubricReport.gaps[0]).toMatch(/missing/i);
    expect(result.masteryDelta).toBeLessThanOrEqual(0);
    expect(result.mastery.score).toBeLessThanOrEqual(0.4);
    expect(result.mastery.attemptsN).toBe(3);
  });

  test("grades Chinese teachback text with Unicode page keywords", () => {
    const concept = createConcept(db, { slug: "active-recall-cn", name: "主动回忆", status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "active-recall-cn.md",
      title: "主动回忆笔记",
      fingerprint: "fingerprint-active-recall-cn",
      chunkText: "主动回忆通过先提取知识再复习来强化记忆。"
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "主动回忆通过先提取知识再复习来强化记忆并降低遗忘。",
      citationIds: [chunk.id],
      visibility: "private"
    });

    const result = gradePersistentTeachback(db, {
      conceptSlug: "active-recall-cn",
      transcript: "主动回忆就是先提取知识再复习，所以可以强化记忆并降低遗忘。",
      runId: "persistent-teachback-cn"
    });

    expect(result.rubricReport.score).toBeGreaterThanOrEqual(0.6);
    expect(result.rubricReport.matchedKeywords.length).toBeGreaterThan(0);
    expect(result.rubricReport.gaps.length).toBeLessThan(result.rubricReport.missingKeywords.length + 1);
    expect(result.mastery.score).toBeGreaterThanOrEqual(0.06);
    expect(countRows("teachbacks")).toBe(1);
    expect(countRows("mastery")).toBe(1);
  });

  test("rejects blank concept slug without teachback or mastery writes", () => {
    expect(() => {
      gradePersistentTeachback(db, {
        conceptSlug: "   ",
        transcript: "This explanation cannot be routed to a concept."
      });
    }).toThrow(/non-empty concept slug/);

    expect(countRows("teachbacks")).toBe(0);
    expect(countRows("mastery")).toBe(0);
  });

  test("rejects a page with no extractable rubric keywords without teachback or mastery writes", () => {
    const concept = createConcept(db, { slug: "punctuation-page", name: "Punctuation Page", status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "punctuation.md",
      title: "Punctuation notes",
      fingerprint: "fingerprint-punctuation",
      chunkText: "Punctuation only page."
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "!!! ??? ...",
      citationIds: [chunk.id],
      visibility: "private"
    });

    expect(() => {
      gradePersistentTeachback(db, {
        conceptSlug: "punctuation-page",
        transcript: "This explanation has words, but the page has no rubric ideas."
      });
    }).toThrow(/rubric keywords/);

    expect(countRows("teachbacks")).toBe(0);
    expect(countRows("mastery")).toBe(0);
  });

  test("rejects a missing concept without teachback or mastery writes", () => {
    expect(() => {
      gradePersistentTeachback(db, {
        conceptSlug: "missing",
        transcript: "This explanation cannot be graded."
      });
    }).toThrow(/Concept missing was not found/);

    expect(countRows("teachbacks")).toBe(0);
    expect(countRows("mastery")).toBe(0);
  });

  test("rejects a concept with no page without teachback or mastery writes", () => {
    createConcept(db, { slug: "no-page", name: "No Page", status: "generated" });

    expect(() => {
      gradePersistentTeachback(db, {
        conceptSlug: "no-page",
        transcript: "This explanation has no page to grade against."
      });
    }).toThrow(/No page was found for concept no-page/);

    expect(countRows("teachbacks")).toBe(0);
    expect(countRows("mastery")).toBe(0);
  });

  test("rejects blank transcript without teachback or mastery writes", () => {
    const concept = createConcept(db, { slug: "blank", name: "Blank", status: "generated" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "blank.md",
      title: "Blank notes",
      fingerprint: "fingerprint-blank",
      chunkText: "Blank transcripts should not be persisted."
    });
    createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "Blank transcripts should not be persisted.",
      citationIds: [chunk.id],
      visibility: "private"
    });

    expect(() => {
      gradePersistentTeachback(db, {
        conceptSlug: "blank",
        transcript: "   "
      });
    }).toThrow(/non-empty transcript/);

    expect(countRows("teachbacks")).toBe(0);
    expect(countRows("mastery")).toBe(0);
  });

  function readTeachbacks(): Array<{
    id: number;
    conceptSlug: string;
    transcript: string;
    rubricReport: unknown;
  }> {
    const rows = db
      .prepare(
        `SELECT
           teachbacks.id,
           concepts.slug AS conceptSlug,
           teachbacks.transcript,
           teachbacks.rubric_report AS rubricReport
         FROM teachbacks
         INNER JOIN concepts ON concepts.id = teachbacks.concept_id
         ORDER BY teachbacks.id`
      )
      .all() as Array<{
      id: number;
      conceptSlug: string;
      transcript: string;
      rubricReport: string;
    }>;

    return rows.map((row) => ({
      ...row,
      rubricReport: JSON.parse(row.rubricReport) as unknown
    }));
  }

  function countRows(tableName: "teachbacks" | "mastery"): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
  }
});
