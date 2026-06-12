import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTraceRecorder } from "../engine/trace.js";
import { createConcept } from "./graph-store.js";
import { applyMigrations } from "./migrations.js";
import {
  ContentStoreValidationError,
  createPage,
  createSourceWithChunk,
  listPublicPages,
  recordMasteryUpdate
} from "./content-store.js";

describe("content store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("createPage accepts a public page when every citation resolves to a chunk", () => {
    const concept = createConcept(db, { slug: "bayes-rule", name: "Bayes rule" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "bayes.md",
      title: "Bayes notes",
      fingerprint: "fingerprint-1",
      chunkText: "Bayes rule updates a prior with likelihood evidence."
    });
    const traceRecorder = createTraceRecorder(fixedTraceClock);
    const runId = "run-page-accepted";

    const page = createPage(
      db,
      {
        conceptId: concept.id,
        version: 1,
        markdown: "Bayes rule combines prior belief and evidence.",
        citationIds: [chunk.id],
        visibility: "public"
      },
      { traceRecorder, runId }
    );

    expect(page).toMatchObject({
      conceptId: concept.id,
      version: 1,
      markdown: "Bayes rule combines prior belief and evidence.",
      citationIds: [chunk.id],
      visibility: "public"
    });
    expect(selectPageCitationIds(page.id)).toEqual([chunk.id]);
    expect(traceRecorder.getEvents({ runId, stage: "page-gen" })).toMatchObject([
      {
        level: "info",
        message: "Page inserted",
        data: {
          outcome: "accepted",
          pageId: page.id,
          conceptId: concept.id,
          version: 1,
          visibility: "public",
          citationIds: [chunk.id]
        }
      }
    ]);
  });

  test("createPage rejects a public page with no citations before inserting it", () => {
    const concept = createConcept(db, { slug: "uncited-public", name: "Uncited public" });
    const traceRecorder = createTraceRecorder(fixedTraceClock);
    const runId = "run-page-no-citations";

    const error = captureContentStoreError(() => {
      createPage(
        db,
        {
          conceptId: concept.id,
          version: 1,
          markdown: "This public page is missing provenance.",
          citationIds: [],
          visibility: "public"
        },
        { traceRecorder, runId }
      );
    });

    expect(error.reason).toBe("public_page_requires_citation");
    expect(countPages()).toBe(0);
    expect(traceRecorder.getEvents({ runId, stage: "page-gen" })).toMatchObject([
      {
        level: "error",
        message: "Page rejected",
        data: {
          outcome: "rejected",
          reason: "public_page_requires_citation",
          conceptId: concept.id,
          version: 1,
          visibility: "public",
          citationIds: []
        }
      }
    ]);
  });

  test("createPage rejects a missing citation before inserting it", () => {
    const concept = createConcept(db, { slug: "missing-citation", name: "Missing citation" });

    const error = captureContentStoreError(() => {
      createPage(db, {
        conceptId: concept.id,
        version: 1,
        markdown: "This page points at a missing chunk.",
        citationIds: [404],
        visibility: "private"
      });
    });

    expect(error.reason).toBe("missing_citation");
    expect(error.data).toMatchObject({ missingCitationId: 404 });
    expect(countPages()).toBe(0);
  });

  test.each([
    ["null", null],
    ["object", { id: 1 }],
    ["missing", undefined]
  ] as const)("createPage rejects malformed citationIds container: %s", (_label, citationIds) => {
    const concept = createConcept(db, { slug: `bad-citation-container-${_label}`, name: "Bad citation container" });
    const traceRecorder = createTraceRecorder(fixedTraceClock);
    const runId = `run-bad-citation-container-${_label}`;
    const input = {
      conceptId: concept.id,
      version: 1,
      markdown: "Malformed citation container",
      visibility: "public",
      ...(citationIds === undefined ? {} : { citationIds })
    } as unknown as Parameters<typeof createPage>[1];

    const error = captureContentStoreError(() => {
      createPage(db, input, { traceRecorder, runId });
    });

    expect(error.reason).toBe("invalid_citation_ids");
    expect(countPages()).toBe(0);
    expect(traceRecorder.getEvents({ runId, stage: "page-gen" })).toMatchObject([
      {
        level: "error",
        message: "Page rejected",
        data: {
          outcome: "rejected",
          reason: "invalid_citation_ids",
          conceptId: concept.id,
          version: 1,
          visibility: "public"
        }
      }
    ]);
  });

  test.each([
    ["string", "bad"],
    ["null", null],
    ["object", {}],
    ["zero", 0],
    ["negative", -1],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1]
  ] as const)("createPage rejects invalid citation id element: %s", (_label, citationId) => {
    const concept = createConcept(db, { slug: `bad-citation-element-${_label}`, name: "Bad citation element" });

    const error = captureContentStoreError(() => {
      createPage(db, {
        conceptId: concept.id,
        version: 1,
        markdown: "Invalid citation element",
        citationIds: [citationId] as unknown as number[],
        visibility: "private"
      });
    });

    expect(error.reason).toBe("invalid_citation_id");
    expect(error.data).toMatchObject({ invalidCitationId: citationId });
    expect(countPages()).toBe(0);
  });

  test("createPage rejects a missing concept before inserting it", () => {
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "missing-concept-page.md",
      title: "Missing concept page",
      fingerprint: "fingerprint-missing-concept-page",
      chunkText: "A valid chunk cannot rescue a missing concept."
    });

    const error = captureContentStoreError(() => {
      createPage(db, {
        conceptId: 404,
        version: 1,
        markdown: "This page points at a missing concept.",
        citationIds: [chunk.id],
        visibility: "private"
      });
    });

    expect(error.reason).toBe("missing_concept");
    expect(countPages()).toBe(0);
  });

  test("listPublicPages excludes private pages", () => {
    const concept = createConcept(db, { slug: "visibility", name: "Visibility" });
    const { chunk } = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "visibility.md",
      title: "Visibility notes",
      fingerprint: "fingerprint-visibility",
      chunkText: "Only public pages belong in public listings."
    });
    const publicPage = createPage(db, {
      conceptId: concept.id,
      version: 1,
      markdown: "Public page",
      citationIds: [chunk.id],
      visibility: "public"
    });
    const privatePage = createPage(db, {
      conceptId: concept.id,
      version: 2,
      markdown: "Private page",
      citationIds: [chunk.id],
      visibility: "private"
    });

    const pages = listPublicPages(db);

    expect(pages).toHaveLength(1);
    expect(pages[0]?.id).toBe(publicPage.id);
    expect(pages.map((page) => page.id)).not.toContain(privatePage.id);
    expect(pages.every((page) => page.visibility === "public")).toBe(true);
  });

  test.each([
    ["string citation", ["bad"]],
    ["null citation", [null]],
    ["object citation", [{}]]
  ] as const)("listPublicPages rejects schema-valid malformed citation arrays: %s", (_label, citations) => {
    const concept = createConcept(db, { slug: `stored-bad-citations-${_label.replaceAll(" ", "-")}`, name: "Stored bad citations" });
    insertRawPublicPage(concept.id, citations);

    const error = captureContentStoreError(() => {
      listPublicPages(db);
    });

    expect(error.reason).toBe("invalid_citation_id");
  });

  test("recordMasteryUpdate inserts and then increments attempts by default", () => {
    const concept = createConcept(db, { slug: "mastery-default", name: "Mastery default" });
    const traceRecorder = createTraceRecorder(fixedTraceClock);
    const runId = "run-mastery-default";

    const first = recordMasteryUpdate(
      db,
      {
        conceptId: concept.id,
        score: 0.25,
        confidence: 0.5,
        lastSeenAt: "2026-06-12T01:00:00.000Z"
      },
      { traceRecorder, runId }
    );
    const second = recordMasteryUpdate(
      db,
      {
        conceptId: concept.id,
        score: 0.75,
        confidence: 0.8,
        lastSeenAt: "2026-06-12T02:00:00.000Z"
      },
      { traceRecorder, runId }
    );

    expect(second).toEqual({
      id: first.id,
      conceptId: concept.id,
      score: 0.75,
      confidence: 0.8,
      attemptsN: 2,
      lastSeenAt: "2026-06-12T02:00:00.000Z"
    });
    expect(countMasteryRows()).toBe(1);
    expect(traceRecorder.getEvents({ runId, stage: "grade" })).toHaveLength(2);
    expect(traceRecorder.getEvents({ runId, stage: "grade" })[1]?.data).toMatchObject({
      outcome: "accepted",
      conceptId: concept.id,
      score: 0.75,
      confidence: 0.8,
      attemptsN: 2
    });
  });

  test("recordMasteryUpdate can set attempts explicitly", () => {
    const concept = createConcept(db, { slug: "mastery-set", name: "Mastery set" });

    const first = recordMasteryUpdate(db, {
      conceptId: concept.id,
      score: 0.4,
      confidence: 0.6,
      attemptsN: 5,
      lastSeenAt: "2026-06-12T03:00:00.000Z"
    });
    const second = recordMasteryUpdate(db, {
      conceptId: concept.id,
      score: 0.5,
      confidence: 0.7,
      attemptsN: 3,
      lastSeenAt: "2026-06-12T04:00:00.000Z"
    });

    expect(first.attemptsN).toBe(5);
    expect(second.attemptsN).toBe(3);
    expect(second.id).toBe(first.id);
  });

  test("recordMasteryUpdate accepts score and confidence boundaries", () => {
    const concept = createConcept(db, { slug: "mastery-boundaries", name: "Mastery boundaries" });

    const first = recordMasteryUpdate(db, {
      conceptId: concept.id,
      score: 0,
      confidence: 1,
      attemptsN: 0,
      lastSeenAt: "2026-06-12T05:30:00.000Z"
    });
    const second = recordMasteryUpdate(db, {
      conceptId: concept.id,
      score: 1,
      confidence: 0,
      attemptsN: 1,
      lastSeenAt: "2026-06-12T05:45:00.000Z"
    });

    expect(first).toMatchObject({ score: 0, confidence: 1, attemptsN: 0 });
    expect(second).toMatchObject({ score: 1, confidence: 0, attemptsN: 1 });
    expect(countMasteryRows()).toBe(1);
  });

  test.each([
    ["score", { score: -0.01, confidence: 0.5 }, "score_out_of_range"],
    ["score", { score: 1.01, confidence: 0.5 }, "score_out_of_range"],
    ["confidence", { score: 0.5, confidence: -0.01 }, "confidence_out_of_range"],
    ["confidence", { score: 0.5, confidence: 1.01 }, "confidence_out_of_range"]
  ] as const)("recordMasteryUpdate rejects %s outside [0,1]", (_field, values, reason) => {
    const concept = createConcept(db, { slug: `invalid-${reason}-${values.score}`, name: "Invalid mastery" });

    const error = captureContentStoreError(() => {
      recordMasteryUpdate(db, {
        conceptId: concept.id,
        score: values.score,
        confidence: values.confidence,
        lastSeenAt: "2026-06-12T05:00:00.000Z"
      });
    });

    expect(error.reason).toBe(reason);
    expect(countMasteryRows()).toBe(0);
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["nan", Number.NaN]
  ] as const)("recordMasteryUpdate rejects invalid attemptsN: %s", (_label, attemptsN) => {
    const concept = createConcept(db, { slug: `invalid-attempts-${_label}`, name: "Invalid attempts" });

    const error = captureContentStoreError(() => {
      recordMasteryUpdate(db, {
        conceptId: concept.id,
        score: 0.5,
        confidence: 0.5,
        attemptsN,
        lastSeenAt: "2026-06-12T06:00:00.000Z"
      });
    });

    expect(error.reason).toBe("attempts_n_out_of_range");
    expect(countMasteryRows()).toBe(0);
  });

  test("recordMasteryUpdate rejects a missing concept before inserting it", () => {
    const error = captureContentStoreError(() => {
      recordMasteryUpdate(db, {
        conceptId: 404,
        score: 0.5,
        confidence: 0.5,
        lastSeenAt: "2026-06-12T06:30:00.000Z"
      });
    });

    expect(error.reason).toBe("missing_concept");
    expect(countMasteryRows()).toBe(0);
  });

  test("createSourceWithChunk rolls back source insert when chunk insert fails", () => {
    expect(() => {
      createSourceWithChunk(db, {
        adapterId: "fixture",
        docRef: "rollback.md",
        title: "Rollback",
        fingerprint: "fingerprint-rollback",
        chunkText: "Invalid chunk seq should roll back the source insert.",
        seq: 0
      });
    }).toThrow();

    expect(countSources()).toBe(0);
    expect(countChunks()).toBe(0);
  });

  function insertRawPublicPage(conceptId: number, citations: readonly unknown[]): void {
    db.prepare(
      `INSERT INTO pages (concept_id, version, markdown, citations, visibility)
       VALUES (?, 1, 'Stored malformed citations', ?, 'public')`
    ).run(conceptId, JSON.stringify(citations));
  }

  function selectPageCitationIds(pageId: number): number[] {
    const row = db.prepare("SELECT citations FROM pages WHERE id = ?").get(pageId) as { citations: string };
    return JSON.parse(row.citations) as number[];
  }

  function countPages(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM pages").get() as { count: number }).count;
  }

  function countSources(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM sources").get() as { count: number }).count;
  }

  function countChunks(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count;
  }

  function countMasteryRows(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM mastery").get() as { count: number }).count;
  }
});

function captureContentStoreError(action: () => void): ContentStoreValidationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ContentStoreValidationError);
    return error as ContentStoreValidationError;
  }

  throw new Error("Expected ContentStoreValidationError");
}

const fixedTraceClock = {
  now: () => new Date("2026-06-12T00:00:00.000Z")
};
