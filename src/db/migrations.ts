import type Database from "better-sqlite3";

export interface Migration {
  id: string;
  name: string;
  sql: string;
}

export const MIGRATIONS = [
  {
    id: "0001_initial_knowledge_loop_schema",
    name: "Initial knowledge-loop schema",
    sql: `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter_id TEXT NOT NULL,
  doc_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ingested', 'error')),
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (adapter_id, doc_ref)
);

CREATE INDEX IF NOT EXISTS sources_status_idx ON sources (status);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  text TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  UNIQUE (source_id, seq),
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chunks_source_id_idx ON chunks (source_id);

CREATE TABLE IF NOT EXISTS concepts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT,
  domain TEXT,
  status TEXT NOT NULL DEFAULT 'stub' CHECK (status IN ('stub', 'generated', 'reviewed'))
);

CREATE INDEX IF NOT EXISTS concepts_status_idx ON concepts (status);

CREATE TABLE IF NOT EXISTS concept_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_concept_id INTEGER NOT NULL,
  to_concept_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prerequisite', 'related', 'part_of')),
  weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
  UNIQUE (from_concept_id, to_concept_id, kind),
  FOREIGN KEY (from_concept_id) REFERENCES concepts(id) ON DELETE CASCADE,
  FOREIGN KEY (to_concept_id) REFERENCES concepts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS concept_edges_to_concept_id_idx ON concept_edges (to_concept_id);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  markdown TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations) AND json_type(citations) = 'array'),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  UNIQUE (concept_id, version),
  CHECK (visibility != 'public' OR json_array_length(citations) > 0),
  FOREIGN KEY (concept_id) REFERENCES concepts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pages_visibility_idx ON pages (visibility);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id INTEGER NOT NULL,
  concept_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(concept_ids) AND json_type(concept_ids) = 'array'),
  type TEXT NOT NULL CHECK (type IN ('mcq', 'fill_in', 'free_form')),
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  statement TEXT NOT NULL,
  answer_spec TEXT NOT NULL CHECK (json_valid(answer_spec)),
  FOREIGN KEY (concept_id) REFERENCES concepts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS items_concept_id_idx ON items (concept_id);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  response TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'partial')),
  grading_method TEXT NOT NULL CHECK (grading_method IN ('exact', 'rubric')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS attempts_item_id_idx ON attempts (item_id);

CREATE TABLE IF NOT EXISTS teachbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id INTEGER NOT NULL,
  transcript TEXT NOT NULL,
  rubric_report TEXT NOT NULL CHECK (json_valid(rubric_report)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (concept_id) REFERENCES concepts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS teachbacks_concept_id_idx ON teachbacks (concept_id);

CREATE TABLE IF NOT EXISTS mastery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id INTEGER NOT NULL UNIQUE,
  score REAL NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 1),
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  attempts_n INTEGER NOT NULL DEFAULT 0 CHECK (attempts_n >= 0),
  last_seen_at TEXT,
  FOREIGN KEY (concept_id) REFERENCES concepts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  queue TEXT NOT NULL CHECK (json_valid(queue)),
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed', 'skipped'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id INTEGER NOT NULL UNIQUE,
  fsrs_state TEXT NOT NULL CHECK (json_valid(fsrs_state)),
  due_at TEXT NOT NULL,
  FOREIGN KEY (concept_id) REFERENCES concepts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reviews_due_at_idx ON reviews (due_at);
`
  }
] as const satisfies readonly Migration[];

export function applyMigrations(db: Database.Database): string[] {
  db.pragma("foreign_keys = ON");
  ensureMigrationsTable(db);

  const applied: string[] = [];
  const runPendingMigrations = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (hasMigrationRecord(db, migration.id)) {
        continue;
      }

      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(migration.id, migration.name);
      applied.push(migration.id);
    }
  });

  runPendingMigrations();
  return applied;
}

export function listTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as Array<{ name: string }>;

  return rows.map((row) => row.name);
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
}

function hasMigrationRecord(db: Database.Database, id: string): boolean {
  const row = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(id);
  return row !== undefined;
}
