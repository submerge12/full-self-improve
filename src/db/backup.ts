import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, type Stats } from "node:fs";
import path from "node:path";

export interface SqliteBackupManifest {
  readonly sourcePath: string;
  readonly backupPath: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly tableCounts: Record<string, number>;
}

export interface SqliteRestoreDrillResult {
  readonly backupPath: string;
  readonly sha256: string;
  readonly integrityOk: boolean;
  readonly tableCounts: Record<string, number>;
}

const APPLICATION_TABLES = [
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
] as const;

export async function createSqliteBackup(sourcePath: string, backupPath: string): Promise<SqliteBackupManifest> {
  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedBackupPath = path.resolve(backupPath);

  const sourceStat = assertExistingFile(resolvedSourcePath, "Source database");
  assertDifferentPaths(resolvedSourcePath, resolvedBackupPath);
  assertDestinationAvailable(resolvedBackupPath, sourceStat);
  mkdirSync(path.dirname(resolvedBackupPath), { recursive: true });

  const sourceDb = new Database(resolvedSourcePath, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(resolvedBackupPath);
  } finally {
    sourceDb.close();
  }

  return {
    sourcePath: resolvedSourcePath,
    backupPath: resolvedBackupPath,
    byteSize: statSync(resolvedBackupPath).size,
    sha256: hashFile(resolvedBackupPath),
    createdAt: new Date().toISOString(),
    tableCounts: readTableCounts(resolvedBackupPath)
  };
}

export function runSqliteRestoreDrill(backupPath: string): SqliteRestoreDrillResult {
  const resolvedBackupPath = path.resolve(backupPath);
  assertExistingFile(resolvedBackupPath, "Backup database");

  return {
    backupPath: resolvedBackupPath,
    sha256: hashFile(resolvedBackupPath),
    integrityOk: checkIntegrity(resolvedBackupPath),
    tableCounts: readTableCounts(resolvedBackupPath)
  };
}

function readTableCounts(databasePath: string): Record<string, number> {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const counts: Record<string, number> = {};
    for (const tableName of APPLICATION_TABLES) {
      if (!tableExists(db, tableName)) {
        continue;
      }
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get() as { count: number };
      counts[tableName] = row.count;
    }
    return counts;
  } finally {
    db.close();
  }
}

function checkIntegrity(databasePath: string): boolean {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, string>>;
    return rows.length === 1 && Object.values(rows[0])[0] === "ok";
  } finally {
    db.close();
  }
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertExistingFile(filePath: string, label: string): Stats {
  try {
    const fileStat = statSync(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
    return fileStat;
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`${label} does not exist: ${filePath}`);
    }
    throw error;
  }
}

function assertDestinationAvailable(backupPath: string, sourceStat: Stats): void {
  let backupStat: Stats;
  try {
    backupStat = statSync(backupPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw new Error(`Cannot inspect destination backup path: ${String(error)}`);
  }

  if (hasSameFileIdentity(sourceStat, backupStat)) {
    throw new Error("SQLite backup source and destination resolve to the same file");
  }
  throw new Error(`Destination backup already exists: ${backupPath}`);
}

function assertDifferentPaths(sourcePath: string, backupPath: string): void {
  if (normalizeForComparison(sourcePath) === normalizeForComparison(backupPath)) {
    throw new Error("SQLite backup source and destination resolve to the same path");
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table'
         AND name = ?`
    )
    .get(tableName);
  return row !== undefined;
}

function hasSameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && (left.dev !== 0 || left.ino !== 0);
}

function normalizeForComparison(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
