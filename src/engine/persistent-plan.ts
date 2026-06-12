import type Database from "better-sqlite3";

import {
  createDailyPlan,
  type DailyPlanActivity,
  type MockConceptEdge,
  type PlanActivityType,
  type PlanConceptInput
} from "./mock-commands.js";
import { createTraceRecorder, type TraceEvent, type TraceRecorder } from "./trace.js";

export type StudyPlanStatus = "planned" | "active" | "completed" | "skipped";

export interface PersistentDailyPlanOptions {
  date: string | Date;
  masteryThreshold?: number;
  runId?: string;
  trace?: TraceRecorder;
}

export interface PersistentDailyPlan {
  runId: string;
  date: string;
  queue: DailyPlanActivity[];
  rationale: string;
  status: StudyPlanStatus;
  traceEvents: TraceEvent[];
}

interface ConceptPlanningRow {
  id: number;
  slug: string;
  name: string;
  summary: string | null;
  masteryScore: number | null;
}

interface PrerequisiteEdgeRow {
  fromConceptId: number;
  fromSlug: string;
  fromMasteryScore: number | null;
  toConceptId: number;
  toSlug: string;
}

interface StudyPlanRow {
  date: string;
  queue: string;
  rationale: string;
  status: StudyPlanStatus;
}

interface TraceContext {
  runId: string;
  recorder: TraceRecorder;
}

export function createPersistentDailyPlan(
  db: Database.Database,
  options: PersistentDailyPlanOptions
): PersistentDailyPlan {
  const date = normalizeDate(options.date);
  const threshold = options.masteryThreshold ?? 0.8;
  validateMasteryThreshold(threshold);
  const trace = createTraceContext(options.runId ?? `persistent-plan-${date}`, options.trace, date);

  const plan = db.transaction((): PersistentDailyPlan => {
    const existing = getStudyPlanByDate(db, date);
    if (existing !== undefined) {
      return toPersistentPlan(existing, trace, "reused");
    }

    const draft = createDailyPlan({
      concepts: selectEligibleConcepts(db, threshold),
      date,
      edges: selectEligiblePrerequisiteEdges(db, threshold)
    });

    insertStudyPlan(db, date, draft.queue, draft.rationale);
    const created = getStudyPlanByDate(db, date);
    if (created === undefined) {
      throw new Error(`Study plan ${date} was not found after insert`);
    }

    return toPersistentPlan(created, trace, "created");
  })();

  return plan;
}

function selectEligibleConcepts(db: Database.Database, threshold: number): PlanConceptInput[] {
  const concepts = selectPlanConceptRows(db);
  const prerequisiteScores = buildPrerequisiteScores(selectPrerequisiteEdgeRows(db));

  return concepts
    .filter((concept) => masteryScore(concept) < threshold)
    .filter((concept) => prerequisitesAreMastered(prerequisiteScores.get(concept.id) ?? [], threshold))
    .map((concept) => ({
      slug: concept.slug,
      name: concept.name,
      summary: concept.summary ?? undefined,
      mastery: masteryScore(concept)
    }));
}

function selectEligiblePrerequisiteEdges(db: Database.Database, threshold: number): MockConceptEdge[] {
  const eligibleSlugs = new Set(selectEligibleConcepts(db, threshold).map((concept) => concept.slug));

  return selectPrerequisiteEdgeRows(db)
    .filter((edge) => eligibleSlugs.has(edge.fromSlug) && eligibleSlugs.has(edge.toSlug))
    .map((edge) => ({
      from: edge.fromSlug,
      to: edge.toSlug,
      kind: "prerequisite" as const
    }));
}

function selectPlanConceptRows(db: Database.Database): ConceptPlanningRow[] {
  return db
    .prepare(
      `SELECT
         concepts.id,
         concepts.slug,
         concepts.name,
         concepts.summary,
         mastery.score AS masteryScore
       FROM concepts
       LEFT JOIN mastery ON mastery.concept_id = concepts.id
       WHERE concepts.status IN ('generated', 'reviewed')
       ORDER BY concepts.slug`
    )
    .all() as ConceptPlanningRow[];
}

function selectPrerequisiteEdgeRows(db: Database.Database): PrerequisiteEdgeRow[] {
  return db
    .prepare(
      `SELECT
         concept_edges.from_concept_id AS fromConceptId,
         prerequisite.slug AS fromSlug,
         prerequisite_mastery.score AS fromMasteryScore,
         concept_edges.to_concept_id AS toConceptId,
         dependent.slug AS toSlug
       FROM concept_edges
       INNER JOIN concepts AS prerequisite ON prerequisite.id = concept_edges.from_concept_id
       INNER JOIN concepts AS dependent ON dependent.id = concept_edges.to_concept_id
       LEFT JOIN mastery AS prerequisite_mastery ON prerequisite_mastery.concept_id = prerequisite.id
       WHERE concept_edges.kind = 'prerequisite'
       ORDER BY prerequisite.slug, dependent.slug`
    )
    .all() as PrerequisiteEdgeRow[];
}

function buildPrerequisiteScores(edges: PrerequisiteEdgeRow[]): Map<number, number[]> {
  const scoresByDependentId = new Map<number, number[]>();

  for (const edge of edges) {
    const scores = scoresByDependentId.get(edge.toConceptId) ?? [];
    scores.push(edge.fromMasteryScore ?? 0);
    scoresByDependentId.set(edge.toConceptId, scores);
  }

  return scoresByDependentId;
}

function prerequisitesAreMastered(scores: number[], threshold: number): boolean {
  return scores.every((score) => score >= threshold);
}

function masteryScore(concept: ConceptPlanningRow): number {
  return concept.masteryScore ?? 0;
}

function insertStudyPlan(db: Database.Database, date: string, queue: DailyPlanActivity[], rationale: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO study_plans (date, queue, rationale, status)
     VALUES (?, ?, ?, 'planned')`
  ).run(date, JSON.stringify(queue), rationale);
}

function getStudyPlanByDate(db: Database.Database, date: string): StudyPlanRow | undefined {
  return db
    .prepare(
      `SELECT date, queue, rationale, status
       FROM study_plans
       WHERE date = ?`
    )
    .get(date) as StudyPlanRow | undefined;
}

function toPersistentPlan(row: StudyPlanRow, trace: TraceContext, outcome: "created" | "reused"): PersistentDailyPlan {
  const queue = parseQueue(row);
  recordPlanTrace(trace, outcome, row.date, queue.length, row.status);

  return {
    runId: trace.runId,
    date: row.date,
    queue,
    rationale: row.rationale,
    status: row.status,
    traceEvents: trace.recorder.getEvents({ runId: trace.runId })
  };
}

function parseQueue(row: StudyPlanRow): DailyPlanActivity[] {
  const parsed = JSON.parse(row.queue) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Stored study plan ${row.date} queue is not an array`);
  }

  return parsed.map((activity, index) => parsePlanActivity(row.date, activity, index));
}

function parsePlanActivity(date: string, activity: unknown, index: number): DailyPlanActivity {
  if (typeof activity !== "object" || activity === null) {
    throw new Error(`Stored study plan ${date} activity ${index + 1} is not an object`);
  }

  const record = activity as Record<string, unknown>;
  const type = record.type;
  if (!isPlanActivityType(type)) {
    throw new Error(`Stored study plan ${date} activity ${index + 1} has invalid type`);
  }

  const id = parseRequiredString(record.id, date, index, "id");
  const conceptSlug = parseRequiredString(record.conceptSlug, date, index, "conceptSlug");
  const conceptName = parseRequiredString(record.conceptName, date, index, "conceptName");
  const order = record.order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 1) {
    throw new Error(`Stored study plan ${date} activity ${index + 1} has invalid order`);
  }

  return {
    id,
    order,
    type,
    conceptSlug,
    conceptName
  };
}

function parseRequiredString(value: unknown, date: string, index: number, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Stored study plan ${date} activity ${index + 1} has invalid ${field}`);
  }

  return value;
}

function isPlanActivityType(value: unknown): value is PlanActivityType {
  return value === "learn" || value === "quiz" || value === "teachback";
}

function createTraceContext(runId: string, recorder: TraceRecorder | undefined, date: string): TraceContext {
  return {
    runId,
    recorder: recorder ?? createTraceRecorder({ now: () => new Date(`${date}T00:00:00.000Z`) })
  };
}

function recordPlanTrace(
  trace: TraceContext,
  outcome: "created" | "reused",
  date: string,
  activityCount: number,
  status: StudyPlanStatus
): void {
  trace.recorder.record({
    runId: trace.runId,
    stage: "plan",
    level: "info",
    message: outcome === "created" ? "Persistent daily plan created" : "Persistent daily plan reused",
    data: {
      outcome,
      date,
      activityCount,
      status
    }
  });
}

function validateMasteryThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("masteryThreshold must be between 0 and 1");
  }
}

function normalizeDate(date: string | Date): string {
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid plan date.");
    }

    return date.toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid plan date: ${date}.`);
    }

    return date;
  }

  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid plan date: ${date}.`);
  }

  return parsed.toISOString().slice(0, 10);
}
