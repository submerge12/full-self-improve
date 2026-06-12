import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { MIGRATIONS, applyMigrations, listTables } from "./migrations.js";

const EXPECTED_TABLES = [
  "attempts",
  "chunks",
  "concept_edges",
  "concepts",
  "items",
  "mastery",
  "pages",
  "reviews",
  "schema_migrations",
  "sources",
  "study_plans",
  "teachbacks"
].sort();

describe("database migrations", () => {
  test("migrates an empty database to the expected table set", () => {
    const db = new Database(":memory:");

    try {
      const applied = applyMigrations(db);

      expect(applied).toEqual(MIGRATIONS.map((migration) => migration.id));
      expect(listTables(db)).toEqual(EXPECTED_TABLES);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  test("can be replayed without duplicate migration records", () => {
    const db = new Database(":memory:");

    try {
      applyMigrations(db);
      const secondRun = applyMigrations(db);
      const records = db
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all() as Array<{ id: string }>;

      expect(secondRun).toEqual([]);
      expect(records.map((record) => record.id)).toEqual(MIGRATIONS.map((migration) => migration.id));
    } finally {
      db.close();
    }
  });

  test("enforces source, concept, and citation table relationships", () => {
    const db = new Database(":memory:");

    try {
      applyMigrations(db);

      const sourceId = insertAndReturnId(
        db,
        `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
         VALUES ('fixture-adapter', 'docs/intro.md', 'Intro', 'fp-1', 'ingested')
         RETURNING id`
      );
      const chunkId = insertAndReturnId(
        db,
        `INSERT INTO chunks (source_id, seq, text, meta)
         VALUES (${sourceId}, 1, 'Grounded source text', '{}')
         RETURNING id`
      );
      const conceptId = insertAndReturnId(
        db,
        `INSERT INTO concepts (slug, name, status)
         VALUES ('intro', 'Intro', 'stub')
         RETURNING id`
      );
      const pageId = insertAndReturnId(
        db,
        `INSERT INTO pages (concept_id, version, markdown, citations, visibility)
         VALUES (${conceptId}, 1, '# Intro', '[${chunkId}]', 'private')
         RETURNING id`
      );

      const page = db.prepare("SELECT citations FROM pages WHERE id = ?").get(pageId) as { citations: string };

      expect(JSON.parse(page.citations)).toEqual([chunkId]);
      expect(() =>
        db
          .prepare("INSERT INTO chunks (source_id, seq, text, meta) VALUES (9999, 2, 'Orphan', '{}')")
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO pages (concept_id, version, markdown, citations, visibility) VALUES (9999, 1, '# Missing', '[]', 'private')")
          .run()
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pages (concept_id, version, markdown, citations, visibility) VALUES (?, 2, '# Public', '[]', 'public')"
          )
          .run(conceptId)
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pages (concept_id, version, markdown, citations, visibility) VALUES (?, 3, '# Invalid', 'not-json', 'private')"
          )
          .run(conceptId)
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pages (concept_id, version, markdown, citations, visibility) VALUES (?, 4, '# Object', '{}', 'private')"
          )
          .run(conceptId)
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

function insertAndReturnId(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as { id: number };
  return row.id;
}
