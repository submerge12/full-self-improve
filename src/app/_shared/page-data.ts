import Database from "better-sqlite3";

import { __routeAdapterInternals } from "../api/_shared/route-adapter.js";
import { applyMigrations } from "../../db/migrations.js";

export interface PublicWikiPageSummary {
  readonly id: number;
  readonly conceptId: number;
  readonly conceptName: string;
  readonly version: number;
  readonly excerpt: string;
}

export interface LearningDashboardPlan {
  readonly date: string;
  readonly queue: unknown;
  readonly rationale: string;
  readonly status: string;
}

export interface LearningDashboardMastery {
  readonly conceptId: number;
  readonly conceptName: string;
  readonly score: number;
  readonly confidence: number;
  readonly attemptsN: number;
  readonly lastSeenAt: string | null;
}

export interface LearningDashboardData {
  readonly date: string;
  readonly plan: LearningDashboardPlan | null;
  readonly mastery: readonly LearningDashboardMastery[];
}

export interface RuntimeDbReaderOptions {
  readonly openDb?: () => Database.Database;
  readonly applyMigrations?: (db: Database.Database) => void;
}

interface PublicWikiPageSummaryRow {
  id: number;
  conceptId: number;
  conceptName: string;
  version: number;
  markdown: string;
}

interface StudyPlanRow {
  date: string;
  queue: string;
  rationale: string;
  status: string;
}

interface MasterySummaryRow {
  conceptId: number;
  conceptName: string;
  score: number;
  confidence: number;
  attemptsN: number;
  lastSeenAt: string | null;
}

export function listPublicWikiPageSummaries(db: Database.Database): PublicWikiPageSummary[] {
  const rows = db
    .prepare(
      `SELECT
         pages.id,
         pages.concept_id AS conceptId,
         concepts.name AS conceptName,
         pages.version,
         pages.markdown
       FROM pages
       INNER JOIN concepts ON concepts.id = pages.concept_id
       WHERE pages.visibility = 'public'
       ORDER BY pages.id`
    )
    .all() as PublicWikiPageSummaryRow[];

  return rows.map((row) => ({
    id: row.id,
    conceptId: row.conceptId,
    conceptName: row.conceptName,
    version: row.version,
    excerpt: markdownExcerpt(row.markdown)
  }));
}

export function getLearningDashboardData(db: Database.Database, date: string): LearningDashboardData {
  return {
    date,
    plan: getStudyPlanForDate(db, date),
    mastery: listMasterySummaries(db)
  };
}

export function getRuntimePublicWikiPageSummaries(): PublicWikiPageSummary[] {
  return readWithRuntimeDb((db) => listPublicWikiPageSummaries(db));
}

export function getRuntimeLearningDashboardData(date = todayDateString()): LearningDashboardData {
  return readWithRuntimeDb((db) => getLearningDashboardData(db, date));
}

export function readWithRuntimeDb<T>(
  read: (db: Database.Database) => T,
  options: RuntimeDbReaderOptions = {}
): T {
  const db = (options.openDb ?? openRuntimeDb)();

  try {
    (options.applyMigrations ?? applyMigrations)(db);
    return read(db);
  } finally {
    db.close();
  }
}

function getStudyPlanForDate(db: Database.Database, date: string): LearningDashboardPlan | null {
  const row = db
    .prepare(
      `SELECT date, queue, rationale, status
       FROM study_plans
       WHERE date = ?`
    )
    .get(date) as StudyPlanRow | undefined;

  if (row === undefined) {
    return null;
  }

  return {
    date: row.date,
    queue: JSON.parse(row.queue) as unknown,
    rationale: row.rationale,
    status: row.status
  };
}

function listMasterySummaries(db: Database.Database): LearningDashboardMastery[] {
  const rows = db
    .prepare(
      `SELECT
         mastery.concept_id AS conceptId,
         concepts.name AS conceptName,
         mastery.score,
         mastery.confidence,
         mastery.attempts_n AS attemptsN,
         mastery.last_seen_at AS lastSeenAt
       FROM mastery
       INNER JOIN concepts ON concepts.id = mastery.concept_id
       ORDER BY mastery.score ASC, mastery.confidence ASC, concepts.name ASC`
    )
    .all() as MasterySummaryRow[];

  return rows.map((row) => ({
    conceptId: row.conceptId,
    conceptName: row.conceptName,
    score: row.score,
    confidence: row.confidence,
    attemptsN: row.attemptsN,
    lastSeenAt: row.lastSeenAt
  }));
}

function openRuntimeDb(): Database.Database {
  return new Database(__routeAdapterInternals.resolveRuntimeDbPath());
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function markdownExcerpt(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[-#>*_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= 160) {
    return plain;
  }

  return `${plain.slice(0, 157).trimEnd()}...`;
}
