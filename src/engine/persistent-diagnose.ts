import type Database from "better-sqlite3";

import { createRunId, createTraceRecorder, type TraceEvent, type TraceRecorder } from "./trace.js";

export interface DiagnosePersistentWeakSpotsOptions {
  masteryThreshold?: number;
  limit?: number;
  runId?: string;
  trace?: TraceRecorder;
}

export interface PersistentWeakSpot {
  conceptSlug: string;
  conceptName: string;
  score: number;
  confidence: number;
  attemptsN: number;
  lastSeenAt: string | null;
  reasons: string[];
  recommendation: string;
}

export interface PersistentWeakSpotSummary {
  weakSpotCount: number;
  threshold: number;
  lowestScore: number | null;
}

export interface PersistentDiagnoseResult {
  runId: string;
  masteryThreshold: number;
  weakSpots: PersistentWeakSpot[];
  summary: PersistentWeakSpotSummary;
  traceEvents: TraceEvent[];
}

interface WeakSpotRow {
  conceptSlug: string;
  conceptName: string;
  score: number;
  confidence: number;
  attemptsN: number;
  lastSeenAt: string | null;
}

export function diagnosePersistentWeakSpots(
  db: Database.Database,
  options: DiagnosePersistentWeakSpotsOptions = {}
): PersistentDiagnoseResult {
  const masteryThreshold = options.masteryThreshold ?? 0.8;
  validateMasteryThreshold(masteryThreshold);
  validateLimit(options.limit);

  const runId = options.runId ?? createRunId("persistent-diagnose");
  const trace = options.trace ?? createTraceRecorder();
  const weakSpots = selectWeakSpots(db, masteryThreshold, options.limit).map((row) =>
    mapWeakSpot(row, masteryThreshold)
  );
  const summary = createSummary(weakSpots, masteryThreshold);

  recordDiagnoseTrace(trace, runId, masteryThreshold, weakSpots.length);

  return {
    runId,
    masteryThreshold,
    weakSpots,
    summary,
    traceEvents: trace.getEvents({ runId })
  };
}

function selectWeakSpots(db: Database.Database, threshold: number, limit: number | undefined): WeakSpotRow[] {
  const sql = `${weakSpotSelectSql()}
       ORDER BY mastery.score ASC, concepts.slug ASC${limit === undefined ? "" : "\n       LIMIT ?"}`;
  const statement = db.prepare(sql);
  const params = limit === undefined ? [threshold] : [threshold, limit];

  return statement.all(...params) as WeakSpotRow[];
}

function recordDiagnoseTrace(
  trace: TraceRecorder,
  runId: string,
  masteryThreshold: number,
  weakSpotCount: number
): void {
  trace.record({
    runId,
    stage: "diagnose",
    level: "info",
    message: "Persistent weak spots diagnosed",
    data: {
      masteryThreshold,
      weakSpotCount
    }
  });
}

function weakSpotSelectSql(): string {
  return `SELECT
         concepts.slug AS conceptSlug,
         concepts.name AS conceptName,
         mastery.score,
         mastery.confidence,
         mastery.attempts_n AS attemptsN,
         mastery.last_seen_at AS lastSeenAt
       FROM concepts
       INNER JOIN mastery ON mastery.concept_id = concepts.id
       WHERE concepts.status IN ('generated', 'reviewed')
         AND mastery.attempts_n > 0
         AND mastery.score < ?`;
}

function mapWeakSpot(row: WeakSpotRow, threshold: number): PersistentWeakSpot {
  return {
    conceptSlug: row.conceptSlug,
    conceptName: row.conceptName,
    score: row.score,
    confidence: row.confidence,
    attemptsN: row.attemptsN,
    lastSeenAt: row.lastSeenAt,
    reasons: reasonsFor(row, threshold),
    recommendation: recommendationFor(row)
  };
}

function reasonsFor(row: WeakSpotRow, threshold: number): string[] {
  const reasons = [`Mastery score ${formatUnit(row.score)} is below threshold ${formatUnit(threshold)}.`];
  if (row.confidence < 0.5) {
    reasons.push(`Confidence ${formatUnit(row.confidence)} is low.`);
  }

  return reasons;
}

function recommendationFor(row: WeakSpotRow): string {
  if (row.score <= 0.2) {
    return "Re-study the concept, then practice with a fresh quiz.";
  }

  return "Review the concept and practice until mastery improves.";
}

function createSummary(weakSpots: PersistentWeakSpot[], threshold: number): PersistentWeakSpotSummary {
  return {
    weakSpotCount: weakSpots.length,
    threshold,
    lowestScore: weakSpots[0]?.score ?? null
  };
}

function validateMasteryThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("masteryThreshold must be finite and between 0 and 1");
  }
}

function validateLimit(limit: number | undefined): void {
  if (limit === undefined) {
    return;
  }

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive safe integer");
  }
}

function formatUnit(value: number): string {
  return value.toFixed(2);
}
