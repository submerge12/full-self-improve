import { existsSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import { buildOpsDashboardSummary } from "./dashboard.js";

const DASHBOARD_TABLES = ["sources", "chunks", "concepts", "pages", "mastery", "trace_events"] as const;

type DashboardTable = (typeof DASHBOARD_TABLES)[number];

function createScratchDb(): { db: Database.Database; dbPath: string; cleanup(): void } {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-ops-dashboard-db-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  applyMigrations(db);

  return {
    db,
    dbPath,
    cleanup(): void {
      db.close();
      unlinkIfExists(dbPath);
      unlinkIfExists(`${dbPath}-journal`);
      unlinkIfExists(`${dbPath}-wal`);
      unlinkIfExists(`${dbPath}-shm`);
      rmdirIfEmpty(dbDir);
    }
  };
}

function unlinkIfExists(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

function rmdirIfEmpty(dirPath: string): void {
  if (existsSync(dirPath) && readdirSync(dirPath).length === 0) {
    rmdirSync(dirPath);
  }
}

function countDashboardRows(db: Database.Database): Record<DashboardTable, number> {
  return Object.fromEntries(DASHBOARD_TABLES.map((table) => [table, countRows(db, table)])) as Record<
    DashboardTable,
    number
  >;
}

function countRows(db: Database.Database, table: DashboardTable): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function seedDashboardRows(db: Database.Database): void {
  const insertSource = db.prepare(
    `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
     VALUES (?, ?, ?, ?, ?)`
  );
  const alphaOk = insertSource.run("alpha", "alpha-ok.md", "Alpha OK", "fp-alpha-ok", "ingested");
  insertSource.run("alpha", "alpha-error.md", "Alpha Error", "fp-alpha-error", "error");
  const betaError = insertSource.run("beta", "beta-error.md", "Beta Error", "fp-beta-error", "error");

  const insertChunk = db.prepare(
    `INSERT INTO chunks (source_id, seq, text, meta)
     VALUES (?, ?, ?, ?)`
  );
  const alphaChunk = insertChunk.run(alphaOk.lastInsertRowid, 1, "Alpha chunk text", "{}");
  insertChunk.run(betaError.lastInsertRowid, 1, "Beta chunk text", "{}");

  const insertConcept = db.prepare(
    `INSERT INTO concepts (slug, name, summary, domain, status)
     VALUES (?, ?, ?, ?, ?)`
  );
  const firstConcept = insertConcept.run("alpha-concept", "Alpha Concept", null, "ops", "generated");
  const secondConcept = insertConcept.run("beta-concept", "Beta Concept", null, "ops", "generated");

  const insertPage = db.prepare(
    `INSERT INTO pages (concept_id, version, markdown, citations, visibility)
     VALUES (?, ?, ?, ?, ?)`
  );
  insertPage.run(firstConcept.lastInsertRowid, 1, "Public page", JSON.stringify([alphaChunk.lastInsertRowid]), "public");
  insertPage.run(secondConcept.lastInsertRowid, 1, "Private page", "[]", "private");

  db.prepare(
    `INSERT INTO mastery (concept_id, score, confidence, attempts_n, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(firstConcept.lastInsertRowid, 0.7, 0.8, 3, "2026-06-15T11:00:00.000Z");

  const insertTraceEvent = db.prepare(
    `INSERT INTO trace_events (run_id, stage, level, message, timestamp, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insertTraceEvent.run("run-recent", "chunk", "info", "Recent event", "2026-06-15T11:00:00.000Z", "null");
  insertTraceEvent.run("run-cutoff", "plan", "warn", "Cutoff event", "2026-06-14T12:00:00.000Z", "null");
  insertTraceEvent.run("run-old", "grade", "error", "Old event", "2026-06-14T11:59:59.999Z", "null");
}

describe("buildOpsDashboardSummary", () => {
  test("summarizes a migrated DB with counts, adapters, visibility, mastery, generated time, and recent traces", () => {
    const scratch = createScratchDb();
    try {
      seedDashboardRows(scratch.db);

      const summary = buildOpsDashboardSummary(scratch.db, {
        now: () => new Date("2026-06-15T12:00:00.000Z")
      });

      expect(summary).toEqual({
        generatedAt: "2026-06-15T12:00:00.000Z",
        tableCounts: {
          sources: 3,
          chunks: 2,
          concepts: 2,
          pages: 2,
          mastery: 1,
          trace_events: 3
        },
        sourceAdapters: [
          { adapterId: "alpha", sourceCount: 2, failedCount: 1 },
          { adapterId: "beta", sourceCount: 1, failedCount: 1 }
        ],
        publicPageCount: 1,
        privatePageCount: 1,
        masteryCount: 1,
        recentTraceEventCount: 2
      });
    } finally {
      scratch.cleanup();
    }
  });

  test("returns zeros and no adapter breakdown for an empty migrated DB", () => {
    const scratch = createScratchDb();
    try {
      const summary = buildOpsDashboardSummary(scratch.db, {
        now: () => new Date("2026-06-15T12:00:00.000Z")
      });

      expect(summary.tableCounts).toEqual({
        sources: 0,
        chunks: 0,
        concepts: 0,
        pages: 0,
        mastery: 0,
        trace_events: 0
      });
      expect(summary.sourceAdapters).toEqual([]);
      expect(summary.publicPageCount).toBe(0);
      expect(summary.privatePageCount).toBe(0);
      expect(summary.masteryCount).toBe(0);
      expect(summary.recentTraceEventCount).toBe(0);
    } finally {
      scratch.cleanup();
    }
  });

  test("does not write while building the dashboard summary", () => {
    const scratch = createScratchDb();
    try {
      seedDashboardRows(scratch.db);
      const before = countDashboardRows(scratch.db);

      buildOpsDashboardSummary(scratch.db, {
        now: () => new Date("2026-06-15T12:00:00.000Z")
      });

      expect(countDashboardRows(scratch.db)).toEqual(before);
    } finally {
      scratch.cleanup();
    }
  });
});
