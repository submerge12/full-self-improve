import Database from "better-sqlite3";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createSqliteBackup, runSqliteRestoreDrill } from "./backup.js";
import { applyMigrations } from "./migrations.js";

const tempFiles: string[] = [];
const tempDirs: string[] = [];

const EXPECTED_APPLICATION_TABLES = [
  "attempts",
  "break_reminders",
  "chunks",
  "coach_digest_snapshots",
  "concept_edges",
  "concepts",
  "exercise_plans",
  "exercise_sessions",
  "exercise_templates",
  "health_metric_audit_events",
  "health_metric_imports",
  "health_metrics",
  "health_trace_events",
  "items",
  "mastery",
  "pages",
  "reviews",
  "schema_migrations",
  "sedentary_spans",
  "sedentary_streaks",
  "sources",
  "study_plans",
  "teachbacks",
  "trace_events"
].sort();

afterEach(async () => {
  for (const file of tempFiles.splice(0).reverse()) {
    await ignoreMissing(() => unlink(file));
  }
  for (const dir of tempDirs.splice(0).reverse()) {
    await ignoreMissing(() => rmdir(dir));
  }
});

describe("SQLite backup helpers", () => {
  test("createSqliteBackup creates a manifest for a migrated database at an explicit backup path", async () => {
    const { db, dbPath } = await createMigratedDatabase();
    const backupDir = await createTempDir("knowledge-loop-backup-target-");
    const backupPath = path.join(backupDir, "nested", "knowledge-loop.backup.db");
    tempDirs.push(path.dirname(backupPath));
    trackSqliteFiles(backupPath);

    try {
      insertSource(db, "backup-fixture", "docs/intro.md");

      const manifest = await createSqliteBackup(dbPath, backupPath);

      expect(manifest.sourcePath).toBe(path.resolve(dbPath));
      expect(manifest.backupPath).toBe(path.resolve(backupPath));
      expect(manifest.byteSize).toBeGreaterThan(0);
      expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(new Date(manifest.createdAt).toISOString()).toBe(manifest.createdAt);
      expect(manifest.tableCounts).toMatchObject({
        schema_migrations: 3,
        sources: 1,
        chunks: 0,
        concepts: 0,
        pages: 0,
        trace_events: 0
      });
    } finally {
      db.close();
    }
  });

  test("createSqliteBackup rejects a missing source database", async () => {
    const scratchDir = await createTempDir("knowledge-loop-backup-missing-");
    const missingSourcePath = path.join(scratchDir, "missing.db");
    const backupPath = path.join(scratchDir, "backup.db");

    await expect(createSqliteBackup(missingSourcePath, backupPath)).rejects.toThrow(/source database does not exist/i);
  });

  test("createSqliteBackup rejects source and destination paths that resolve to the same file", async () => {
    const { db, dbPath } = await createMigratedDatabase();

    try {
      await expect(createSqliteBackup(dbPath, path.join(path.dirname(dbPath), ".", path.basename(dbPath)))).rejects.toThrow(
        /same path/i
      );
    } finally {
      db.close();
    }
  });

  test("createSqliteBackup rejects an existing destination file instead of overwriting it", async () => {
    const { db, dbPath } = await createMigratedDatabase();
    const backupDir = await createTempDir("knowledge-loop-existing-backup-");
    const backupPath = path.join(backupDir, "already-there.db");
    trackSqliteFiles(backupPath);

    try {
      await writeFile(backupPath, "existing backup placeholder", "utf8");

      await expect(createSqliteBackup(dbPath, backupPath)).rejects.toThrow(/destination backup already exists/i);
    } finally {
      db.close();
    }
  });

  test("runSqliteRestoreDrill opens a backup read-only without applying migrations and reports counts and integrity", async () => {
    const { db, dbPath } = await createMigratedDatabase();
    const backupDir = await createTempDir("knowledge-loop-restore-drill-");
    const backupPath = path.join(backupDir, "knowledge-loop.backup.db");
    trackSqliteFiles(backupPath);

    try {
      insertSource(db, "restore-fixture", "docs/restore.md");
      await createSqliteBackup(dbPath, backupPath);

      const drill = runSqliteRestoreDrill(backupPath);

      expect(drill.backupPath).toBe(path.resolve(backupPath));
      expect(drill.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(drill.integrityOk).toBe(true);
      expect(drill.tableCounts).toMatchObject({
        schema_migrations: 3,
        sources: 1,
        chunks: 0,
        concepts: 0,
        pages: 0,
        trace_events: 0
      });
    } finally {
      db.close();
    }
  });

  test("backup and restore drill counts exclude custom non-application tables", async () => {
    const { db, dbPath } = await createMigratedDatabase();
    const backupDir = await createTempDir("knowledge-loop-custom-table-backup-");
    const backupPath = path.join(backupDir, "custom-table.backup.db");
    trackSqliteFiles(backupPath);

    try {
      db.exec("CREATE TABLE custom_reporting_cache (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
      db.prepare("INSERT INTO custom_reporting_cache (note) VALUES (?)").run("not part of application counts");

      const manifest = await createSqliteBackup(dbPath, backupPath);
      const drill = runSqliteRestoreDrill(backupPath);

      expect(Object.keys(manifest.tableCounts).sort()).toEqual(EXPECTED_APPLICATION_TABLES);
      expect(Object.keys(drill.tableCounts).sort()).toEqual(EXPECTED_APPLICATION_TABLES);
      expect(manifest.tableCounts).not.toHaveProperty("custom_reporting_cache");
      expect(drill.tableCounts).not.toHaveProperty("custom_reporting_cache");
    } finally {
      db.close();
    }
  });

  test("createSqliteBackup preserves committed WAL-mode rows for restore drills", async () => {
    const { db, dbPath } = await createMigratedDatabase();
    const backupDir = await createTempDir("knowledge-loop-wal-backup-");
    const backupPath = path.join(backupDir, "wal.backup.db");
    trackSqliteFiles(backupPath);

    try {
      expect(db.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
      insertSource(db, "wal-fixture", "docs/wal.md");

      const manifest = await createSqliteBackup(dbPath, backupPath);
      const drill = runSqliteRestoreDrill(backupPath);

      expect(manifest.tableCounts.sources).toBe(1);
      expect(drill.integrityOk).toBe(true);
      expect(drill.tableCounts.sources).toBe(1);
    } finally {
      db.close();
    }
  });
});

async function createMigratedDatabase(): Promise<{ db: Database.Database; dbPath: string }> {
  const rootDir = await createTempDir("knowledge-loop-db-backup-");
  const dbPath = path.join(rootDir, "knowledge-loop.db");
  trackSqliteFiles(dbPath);
  const db = new Database(dbPath);
  applyMigrations(db);
  return { db, dbPath };
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function insertSource(db: Database.Database, adapterId: string, docRef: string): void {
  db.prepare(
    `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(adapterId, docRef, docRef, `sha256:${adapterId}:${docRef}`, "ingested");
}

function trackSqliteFiles(dbPath: string): void {
  tempFiles.push(dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`);
}

async function ignoreMissing(removePath: () => Promise<void>): Promise<void> {
  try {
    await removePath();
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
