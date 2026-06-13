import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import { applyMigrations } from "../../db/migrations.js";
import {
  createPage,
  createSourceWithChunk,
  recordMasteryUpdate
} from "../../db/content-store.js";
import {
  getPublicWikiPageDetail,
  getLearningDashboardData,
  listPublicWikiPageSummaries,
  readWithRuntimeDb
} from "./page-data.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("page data helpers", () => {
  test("public wiki summaries exclude private pages and include ids for linking", () => {
    db = createMigratedDb();
    const publicConceptId = insertConcept(db, "public-concept", "Public Concept");
    const privateConceptId = insertConcept(db, "private-concept", "Private Concept");
    const citation = createSourceWithChunk(db, {
      adapterId: "fixture",
      docRef: "public.md",
      title: "Public Source",
      fingerprint: "public-fingerprint",
      chunkText: "Public source text"
    }).chunk;

    createPage(db, {
      conceptId: publicConceptId,
      version: 1,
      markdown: "# Public Concept\n\nVisible summary.",
      citationIds: [citation.id],
      visibility: "public"
    });
    createPage(db, {
      conceptId: privateConceptId,
      version: 1,
      markdown: "# Private Concept\n\nHidden summary.",
      citationIds: [],
      visibility: "private"
    });

    expect(listPublicWikiPageSummaries(db)).toEqual([
      {
        id: 1,
        conceptId: publicConceptId,
        conceptName: "Public Concept",
        version: 1,
        excerpt: "Public Concept Visible summary."
      }
    ]);
  });

  test("public wiki detail returns public page with citations in stored order", () => {
    db = createMigratedDb();
    const conceptId = insertConcept(db, "ordered-citations", "Ordered Citations");
    const firstCitation = createSourceWithChunk(db, {
      adapterId: "vault",
      docRef: "first.md",
      title: "First Source",
      fingerprint: "first-fingerprint",
      chunkText: "First cited chunk"
    }).chunk;
    const secondCitation = createSourceWithChunk(db, {
      adapterId: "markdown",
      docRef: "second.md",
      title: "Second Source",
      fingerprint: "second-fingerprint",
      chunkText: "Second cited chunk"
    }).chunk;
    const page = createPage(db, {
      conceptId,
      version: 3,
      markdown: "# Ordered Citations\n\nThe page body.",
      citationIds: [secondCitation.id, firstCitation.id],
      visibility: "public"
    });

    expect(getPublicWikiPageDetail(db, page.id)).toEqual({
      id: page.id,
      conceptId,
      conceptName: "Ordered Citations",
      version: 3,
      markdown: "# Ordered Citations\n\nThe page body.",
      citations: [
        {
          chunkId: secondCitation.id,
          text: "Second cited chunk",
          sourceTitle: "Second Source",
          docRef: "second.md",
          adapterId: "markdown"
        },
        {
          chunkId: firstCitation.id,
          text: "First cited chunk",
          sourceTitle: "First Source",
          docRef: "first.md",
          adapterId: "vault"
        }
      ]
    });
  });

  test("public wiki detail returns null for private, missing, and invalid page ids", () => {
    db = createMigratedDb();
    const conceptId = insertConcept(db, "private-detail", "Private Detail");
    const privatePage = createPage(db, {
      conceptId,
      version: 1,
      markdown: "# Private Detail",
      citationIds: [],
      visibility: "private"
    });

    expect(getPublicWikiPageDetail(db, privatePage.id)).toBeNull();
    expect(getPublicWikiPageDetail(db, 999)).toBeNull();
    expect(getPublicWikiPageDetail(db, "not-a-page")).toBeNull();
  });

  test("public wiki detail throws when a stored citation chunk is missing", () => {
    const testDb = createMigratedDb();
    db = testDb;
    const conceptId = insertConcept(testDb, "broken-citation", "Broken Citation");
    testDb.prepare(
      `INSERT INTO pages (concept_id, version, markdown, citations, visibility)
       VALUES (?, ?, ?, ?, ?)`
    ).run(conceptId, 1, "# Broken Citation", JSON.stringify([404]), "public");

    expect(() => getPublicWikiPageDetail(testDb, 1)).toThrow("Public wiki page 1 cites missing chunk 404");
  });

  test("public wiki detail throws when a stored citation id is malformed", () => {
    const testDb = createMigratedDb();
    db = testDb;
    const conceptId = insertConcept(testDb, "malformed-citation", "Malformed Citation");
    testDb.prepare(
      `INSERT INTO pages (concept_id, version, markdown, citations, visibility)
       VALUES (?, ?, ?, ?, ?)`
    ).run(conceptId, 1, "# Malformed Citation", JSON.stringify(["bad"]), "public");

    expect(() => getPublicWikiPageDetail(testDb, 1)).toThrow(
      "Public wiki page 1 contains an invalid citation id"
    );
  });

  test("learning dashboard returns empty plan and mastery states from empty DB", () => {
    db = createMigratedDb();

    expect(getLearningDashboardData(db, "2026-06-13")).toEqual({
      date: "2026-06-13",
      plan: null,
      mastery: []
    });
  });

  test("learning dashboard returns stored plan and mastery rows when seeded", () => {
    db = createMigratedDb();
    const conceptId = insertConcept(db, "retrieval-practice", "Retrieval Practice");
    db.prepare(
      `INSERT INTO study_plans (date, queue, rationale, status)
       VALUES (?, ?, ?, ?)`
    ).run(
      "2026-06-13",
      JSON.stringify([{ kind: "learn", conceptId }]),
      "Start with a new concept.",
      "active"
    );
    recordMasteryUpdate(db, {
      conceptId,
      score: 0.4,
      confidence: 0.7,
      attemptsN: 3,
      lastSeenAt: "2026-06-12T10:00:00.000Z"
    });

    expect(getLearningDashboardData(db, "2026-06-13")).toEqual({
      date: "2026-06-13",
      plan: {
        date: "2026-06-13",
        queue: [{ kind: "learn", conceptId }],
        rationale: "Start with a new concept.",
        status: "active"
      },
      mastery: [
        {
          conceptId,
          conceptName: "Retrieval Practice",
          score: 0.4,
          confidence: 0.7,
          attemptsN: 3,
          lastSeenAt: "2026-06-12T10:00:00.000Z"
        }
      ]
    });
  });

  test("runtime DB reader closes the opened database after reads", () => {
    const events: string[] = [];
    const runtimeDb = createMigratedDb();

    const result = readWithRuntimeDb(
      (readerDb) => {
        events.push(readerDb.open ? "open" : "closed");
        return "read-complete";
      },
      {
        openDb: () => {
          events.push("openDb");
          return runtimeDb;
        },
        applyMigrations: () => {
          events.push("migrate");
        }
      }
    );

    expect(result).toBe("read-complete");
    expect(runtimeDb.open).toBe(false);
    expect(events).toEqual(["openDb", "migrate", "open"]);
  });

  test("runtime DB reader closes the opened database when reads fail", () => {
    const runtimeDb = createMigratedDb();

    expect(() =>
      readWithRuntimeDb(
        () => {
          throw new Error("read failed");
        },
        {
          openDb: () => runtimeDb,
          applyMigrations: () => undefined
        }
      )
    ).toThrow("read failed");

    expect(runtimeDb.open).toBe(false);
  });
});

function createMigratedDb(): Database.Database {
  const migratedDb = new Database(":memory:");
  applyMigrations(migratedDb);
  return migratedDb;
}

function insertConcept(db: Database.Database, slug: string, name: string): number {
  const result = db
    .prepare("INSERT INTO concepts (slug, name, status) VALUES (?, ?, 'generated')")
    .run(slug, name);

  return Number(result.lastInsertRowid);
}
