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
  },
  {
    id: "0002_trace_events",
    name: "Trace events table",
    sql: `
CREATE TABLE IF NOT EXISTS trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('chunk', 'extract', 'merge', 'link', 'page-gen', 'plan', 'grade', 'diagnose')),
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(data))
);

CREATE INDEX IF NOT EXISTS trace_events_run_id_id_idx ON trace_events (run_id, id);
CREATE INDEX IF NOT EXISTS trace_events_run_id_stage_id_idx ON trace_events (run_id, stage, id);
`
  },
  {
    id: "0003_health_extensions",
    name: "Health extensions schema",
    sql: `
CREATE TABLE IF NOT EXISTS health_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_key TEXT NOT NULL CHECK (length(trim(metric_key)) > 0),
  metric_label TEXT NOT NULL CHECK (length(trim(metric_label)) > 0),
  value REAL NOT NULL CHECK (value = value AND abs(value) < 1.0e308),
  unit TEXT NOT NULL CHECK (length(trim(unit)) > 0 AND length(unit) <= 32),
  observed_at TEXT NOT NULL CHECK (length(trim(observed_at)) > 0),
  source TEXT NOT NULL CHECK (source IN ('manual', 'csv', 'mock')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS health_metrics_key_observed_idx ON health_metrics (metric_key, observed_at, id);
CREATE INDEX IF NOT EXISTS health_metrics_observed_idx ON health_metrics (observed_at, id);

CREATE TABLE IF NOT EXISTS health_metric_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id INTEGER NOT NULL,
  changed_at TEXT NOT NULL CHECK (length(trim(changed_at)) > 0),
  changed_by TEXT NOT NULL CHECK (changed_by IN ('cli', 'api')),
  previous_json TEXT NOT NULL CHECK (json_valid(previous_json)),
  next_json TEXT NOT NULL CHECK (json_valid(next_json)),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  FOREIGN KEY (metric_id) REFERENCES health_metrics(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS health_metric_audit_metric_changed_idx ON health_metric_audit_events (metric_id, changed_at, id);

CREATE TABLE IF NOT EXISTS health_metric_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_filename TEXT NOT NULL CHECK (length(trim(source_filename)) > 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
  imported_at TEXT NOT NULL CHECK (length(trim(imported_at)) > 0),
  content_hash TEXT NOT NULL UNIQUE CHECK (length(trim(content_hash)) > 0),
  CHECK (accepted_count + rejected_count = row_count)
);
CREATE INDEX IF NOT EXISTS health_metric_imports_imported_idx ON health_metric_imports (imported_at, id);

CREATE TABLE IF NOT EXISTS exercise_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE CHECK (length(trim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  default_days TEXT NOT NULL CHECK (json_valid(default_days) AND json_type(default_days) = 'array'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS exercise_templates_active_slug_idx ON exercise_templates (active, slug);

CREATE TABLE IF NOT EXISTS exercise_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  week_start TEXT NOT NULL CHECK (length(trim(week_start)) = 10),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  generated_from TEXT NOT NULL CHECK (length(trim(generated_from)) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id) REFERENCES exercise_templates(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS exercise_plans_active_week_idx ON exercise_plans (week_start) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS exercise_plans_template_week_idx ON exercise_plans (template_id, week_start, id);

CREATE TABLE IF NOT EXISTS exercise_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER,
  template_session_key TEXT,
  scheduled_for TEXT,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'completed', 'missed', 'ad_hoc')),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  intensity TEXT CHECK (intensity IS NULL OR intensity IN ('low', 'moderate', 'high')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status != 'planned' OR scheduled_for IS NOT NULL),
  CHECK (status != 'completed' OR completed_at IS NOT NULL),
  FOREIGN KEY (plan_id) REFERENCES exercise_plans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS exercise_sessions_plan_scheduled_idx ON exercise_sessions (plan_id, scheduled_for, id);
CREATE INDEX IF NOT EXISTS exercise_sessions_completed_idx ON exercise_sessions (completed_at, id);

CREATE TABLE IF NOT EXISTS sedentary_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT UNIQUE,
  span_start TEXT NOT NULL CHECK (length(trim(span_start)) > 0),
  span_end TEXT NOT NULL CHECK (length(trim(span_end)) > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'idle', 'unknown')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (span_end > span_start)
);
CREATE INDEX IF NOT EXISTS sedentary_spans_window_idx ON sedentary_spans (span_start, span_end, id);
CREATE INDEX IF NOT EXISTS sedentary_spans_state_window_idx ON sedentary_spans (state, span_start, span_end, id);

CREATE TABLE IF NOT EXISTS sedentary_streaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start TEXT NOT NULL CHECK (length(trim(window_start)) > 0),
  window_end TEXT NOT NULL CHECK (length(trim(window_end)) > 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  source_span_ids TEXT NOT NULL CHECK (json_valid(source_span_ids) AND json_type(source_span_ids) = 'array'),
  computed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (window_end > window_start)
);
CREATE INDEX IF NOT EXISTS sedentary_streaks_window_idx ON sedentary_streaks (window_start, window_end, id);
CREATE INDEX IF NOT EXISTS sedentary_streaks_duration_idx ON sedentary_streaks (duration_minutes, id);

CREATE TABLE IF NOT EXISTS break_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streak_id INTEGER NOT NULL,
  eligible_at TEXT NOT NULL CHECK (length(trim(eligible_at)) > 0),
  status TEXT NOT NULL CHECK (status IN ('eligible', 'suppressed', 'delivered', 'expired')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  delivered_at TEXT,
  delivery_channel TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (streak_id, eligible_at),
  FOREIGN KEY (streak_id) REFERENCES sedentary_streaks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS break_reminders_status_eligible_idx ON break_reminders (status, eligible_at, id);

CREATE TABLE IF NOT EXISTS coach_digest_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL CHECK (length(trim(date)) = 10),
  metrics_summary_json TEXT NOT NULL CHECK (json_valid(metrics_summary_json)),
  exercise_summary_json TEXT NOT NULL CHECK (json_valid(exercise_summary_json)),
  sedentary_summary_json TEXT NOT NULL CHECK (json_valid(sedentary_summary_json)),
  compass_context_json TEXT NOT NULL CHECK (json_valid(compass_context_json)),
  rendered_markdown TEXT NOT NULL CHECK (length(trim(rendered_markdown)) > 0),
  source_hash TEXT NOT NULL CHECK (length(trim(source_hash)) > 0),
  published_at TEXT,
  publish_result_json TEXT CHECK (publish_result_json IS NULL OR json_valid(publish_result_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (date, source_hash)
);
CREATE INDEX IF NOT EXISTS coach_digest_snapshots_date_idx ON coach_digest_snapshots (date, id);
CREATE INDEX IF NOT EXISTS coach_digest_snapshots_published_idx ON coach_digest_snapshots (published_at, id);

CREATE TABLE IF NOT EXISTS health_trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('metric', 'exercise', 'sedentary', 'coach', 'live-evidence')),
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(data))
);
CREATE INDEX IF NOT EXISTS health_trace_events_run_id_id_idx ON health_trace_events (run_id, id);
CREATE INDEX IF NOT EXISTS health_trace_events_run_id_stage_id_idx ON health_trace_events (run_id, stage, id);
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
