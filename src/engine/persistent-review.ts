import type Database from "better-sqlite3";

import { recordPersistentMasteryUpdate, type MasteryRecord } from "./persistent-mastery.js";
import { createTraceRecorder, type TraceEvent, type TraceRecorder } from "./trace.js";

export type PersistentReviewRating = "again" | "hard" | "good" | "easy";

export interface UpsertPersistentReviewScheduleInput {
  conceptId: number;
  fsrsState: unknown;
  dueAt: string | Date;
}

export interface RecordPersistentReviewAttemptInput {
  conceptSlug: string;
  rating: PersistentReviewRating;
  reviewedAt: string | Date;
  runId?: string;
  trace?: TraceRecorder;
}

export interface ListDuePersistentReviewsOptions {
  target: string | Date;
  limit?: number;
}

export interface PersistentReviewRecord {
  id: number;
  conceptId: number;
  conceptSlug: string;
  conceptName: string;
  fsrsState: Record<string, unknown>;
  dueAt: string;
}

export interface PersistentReviewAttemptResult {
  runId: string;
  conceptSlug: string;
  rating: PersistentReviewRating;
  reviewedAt: string;
  previousDueAt: string;
  nextDueAt: string;
  fsrsState: Record<string, unknown>;
  mastery: MasteryRecord;
  masteryDelta: number;
  traceEvents: TraceEvent[];
}

interface ReviewRow {
  id: number;
  conceptId: number;
  conceptSlug: string;
  conceptName: string;
  fsrsState: string;
  dueAt: string;
}

interface StoredConceptRow {
  id: number;
}

interface ConceptSlugRow {
  id: number;
  slug: string;
}

interface MasteryScoreRow {
  score: number;
}

interface JsonObjectResult {
  json: string;
  value: Record<string, unknown>;
}

type JsonValidationPathSegment = string | number;

const REVIEW_RATING_RULES = {
  again: { intervalDays: 1, masteryDelta: -0.08, confidence: 0.4 },
  hard: { intervalDays: 2, masteryDelta: -0.02, confidence: 0.4 },
  good: { intervalDays: 4, masteryDelta: 0.06, confidence: 0.8 },
  easy: { intervalDays: 7, masteryDelta: 0.1, confidence: 0.8 }
} as const satisfies Record<PersistentReviewRating, { intervalDays: number; masteryDelta: number; confidence: number }>;

export function upsertPersistentReviewSchedule(
  db: Database.Database,
  input: UpsertPersistentReviewScheduleInput
): PersistentReviewRecord {
  validateConceptExists(db, input.conceptId);
  const fsrsState = normalizeJsonObject(input.fsrsState, "fsrsState");
  const dueAt = normalizeDateTime(input.dueAt, "dueAt");

  db.prepare(
    `INSERT INTO reviews (concept_id, fsrs_state, due_at)
     VALUES (?, ?, ?)
     ON CONFLICT(concept_id) DO UPDATE SET
       fsrs_state = excluded.fsrs_state,
       due_at = excluded.due_at`
  ).run(input.conceptId, fsrsState.json, dueAt);

  return getReviewByConceptId(db, input.conceptId);
}

export function recordPersistentReviewAttempt(
  db: Database.Database,
  input: RecordPersistentReviewAttemptInput
): PersistentReviewAttemptResult {
  const conceptSlug = requiredConceptSlug(input.conceptSlug);
  const rating = requiredRating(input.rating);
  const reviewedAt = requiredReviewedAt(input.reviewedAt);
  const runId = input.runId ?? `persistent-review-${conceptSlug}`;
  const trace = input.trace ?? createTraceRecorder();

  const attempt = db.transaction((): Omit<PersistentReviewAttemptResult, "traceEvents"> => {
    const concept = getConceptBySlug(db, conceptSlug);
    const review = getReviewByConceptIdForAttempt(db, concept);
    const fsrsState = nextFsrsState(review, rating, reviewedAt);
    const nextDueAt = addUtcDays(reviewedAt, REVIEW_RATING_RULES[rating].intervalDays);

    db.prepare(
      `UPDATE reviews
       SET fsrs_state = ?, due_at = ?
       WHERE id = ?`
    ).run(normalizeJsonObject(fsrsState, "fsrsState").json, nextDueAt, review.id);

    recordReviewAttemptTrace(trace, runId, {
      outcome: "accepted",
      rating,
      conceptSlug: concept.slug,
      nextDueAt,
      masteryDelta: REVIEW_RATING_RULES[rating].masteryDelta
    });

    const nextScore = clampUnitInterval(currentMasteryScore(db, concept.id) + REVIEW_RATING_RULES[rating].masteryDelta);
    const mastery = recordPersistentMasteryUpdate(db, {
      conceptId: concept.id,
      score: nextScore,
      confidence: REVIEW_RATING_RULES[rating].confidence,
      lastSeenAt: reviewedAt,
      trace,
      runId
    });

    return {
      runId,
      conceptSlug: concept.slug,
      rating,
      reviewedAt,
      previousDueAt: review.dueAt,
      nextDueAt,
      fsrsState,
      mastery,
      masteryDelta: REVIEW_RATING_RULES[rating].masteryDelta
    };
  })();

  return {
    ...attempt,
    traceEvents: trace.getEvents({ runId })
  };
}

export function listDuePersistentReviews(
  db: Database.Database,
  options: ListDuePersistentReviewsOptions
): PersistentReviewRecord[] {
  const cutoff = nextUtcDay(options.target);
  const limit = normalizeLimit(options.limit);
  const params: Array<string | number> = [cutoff];
  let limitClause = "";

  if (limit !== undefined) {
    params.push(limit);
    limitClause = "LIMIT ?";
  }

  const rows = db
    .prepare(
      `SELECT
         reviews.id,
         reviews.concept_id AS conceptId,
         concepts.slug AS conceptSlug,
         concepts.name AS conceptName,
         reviews.fsrs_state AS fsrsState,
         reviews.due_at AS dueAt
       FROM reviews
       INNER JOIN concepts ON concepts.id = reviews.concept_id
       WHERE reviews.due_at < ?
         AND concepts.status IN ('generated', 'reviewed')
       ORDER BY reviews.due_at ASC, concepts.slug ASC
       ${limitClause}`
    )
    .all(...params) as ReviewRow[];

  return rows.map(mapReviewRow);
}

function requiredConceptSlug(conceptSlug: string): string {
  if (typeof conceptSlug !== "string" || conceptSlug.trim().length === 0) {
    throw new Error("Persistent review attempt requires a non-empty conceptSlug.");
  }

  return conceptSlug.trim();
}

function requiredRating(rating: PersistentReviewRating): PersistentReviewRating {
  if (!isPersistentReviewRating(rating)) {
    throw new Error("Persistent review rating must be one of again, hard, good, or easy.");
  }

  return rating;
}

function isPersistentReviewRating(rating: unknown): rating is PersistentReviewRating {
  return rating === "again" || rating === "hard" || rating === "good" || rating === "easy";
}

function requiredReviewedAt(reviewedAt: string | Date | undefined): string {
  if (reviewedAt === undefined) {
    throw new Error("Persistent review attempt requires reviewedAt.");
  }

  return normalizeDateTime(reviewedAt, "reviewedAt");
}

function getConceptBySlug(db: Database.Database, slug: string): ConceptSlugRow {
  const row = db
    .prepare(
      `SELECT id, slug
       FROM concepts
       WHERE slug = ?`
    )
    .get(slug) as ConceptSlugRow | undefined;

  if (row === undefined) {
    throw new Error(`Concept ${slug} was not found.`);
  }

  return row;
}

function getReviewByConceptIdForAttempt(db: Database.Database, concept: ConceptSlugRow): PersistentReviewRecord {
  const row = db
    .prepare(
      `SELECT
         reviews.id,
         reviews.concept_id AS conceptId,
         concepts.slug AS conceptSlug,
         concepts.name AS conceptName,
         reviews.fsrs_state AS fsrsState,
         reviews.due_at AS dueAt
       FROM reviews
       INNER JOIN concepts ON concepts.id = reviews.concept_id
       WHERE reviews.concept_id = ?`
    )
    .get(concept.id) as ReviewRow | undefined;

  if (row === undefined) {
    throw new Error(`Review schedule for concept ${concept.slug} does not exist.`);
  }

  return mapReviewRow(row);
}

function nextFsrsState(
  review: PersistentReviewRecord,
  rating: PersistentReviewRating,
  reviewedAt: string
): Record<string, unknown> {
  const previousReviewCount = typeof review.fsrsState.reviewCount === "number" ? review.fsrsState.reviewCount : 0;
  const previousLapses = typeof review.fsrsState.lapses === "number" ? review.fsrsState.lapses : 0;
  const intervalDays = REVIEW_RATING_RULES[rating].intervalDays;

  return {
    ...review.fsrsState,
    lastRating: rating,
    reviewCount: previousReviewCount + 1,
    lapses: rating === "again" ? previousLapses + 1 : previousLapses,
    lastReviewedAt: reviewedAt,
    nextIntervalDays: intervalDays
  };
}

function addUtcDays(isoDateTime: string, days: number): string {
  const date = new Date(isoDateTime);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function currentMasteryScore(db: Database.Database, conceptId: number): number {
  const row = db
    .prepare(
      `SELECT score
       FROM mastery
       WHERE concept_id = ?`
    )
    .get(conceptId) as MasteryScoreRow | undefined;

  return row?.score ?? 0;
}

function clampUnitInterval(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 1_000_000_000_000) / 1_000_000_000_000;
}

function recordReviewAttemptTrace(trace: TraceRecorder, runId: string, data: Record<string, unknown>): void {
  trace.record({
    runId,
    stage: "grade",
    level: "info",
    message: "Review attempt recorded",
    data
  });
}

function getReviewByConceptId(db: Database.Database, conceptId: number): PersistentReviewRecord {
  const row = db
    .prepare(
      `SELECT
         reviews.id,
         reviews.concept_id AS conceptId,
         concepts.slug AS conceptSlug,
         concepts.name AS conceptName,
         reviews.fsrs_state AS fsrsState,
         reviews.due_at AS dueAt
       FROM reviews
       INNER JOIN concepts ON concepts.id = reviews.concept_id
       WHERE reviews.concept_id = ?`
    )
    .get(conceptId) as ReviewRow | undefined;

  if (row === undefined) {
    throw new Error(`Review schedule for concept ${conceptId} was not found after upsert`);
  }

  return mapReviewRow(row);
}

function mapReviewRow(row: ReviewRow): PersistentReviewRecord {
  return {
    id: row.id,
    conceptId: row.conceptId,
    conceptSlug: row.conceptSlug,
    conceptName: row.conceptName,
    fsrsState: parseStoredFsrsState(row),
    dueAt: row.dueAt
  };
}

function validateConceptExists(db: Database.Database, conceptId: number): void {
  if (!Number.isSafeInteger(conceptId) || conceptId < 1) {
    throw new Error("conceptId must be a positive safe integer");
  }

  const row = db.prepare("SELECT id FROM concepts WHERE id = ?").get(conceptId) as StoredConceptRow | undefined;
  if (row === undefined) {
    throw new Error(`Concept ${conceptId} does not exist`);
  }
}

function normalizeJsonObject(value: unknown, label: string): JsonObjectResult {
  if (!isPlainJsonRecord(value)) {
    throw new Error(`${label} must be a plain JSON object`);
  }

  validateJsonValue(value, label, [], new WeakSet<object>());

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be serializable as a JSON object`, { cause: error });
  }

  if (json === undefined) {
    throw new Error(`${label} must be serializable as a JSON object`);
  }

  const parsed = JSON.parse(json) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return {
    json,
    value: parsed
  };
}

function validateJsonValue(
  value: unknown,
  label: string,
  path: JsonValidationPathSegment[],
  ancestors: WeakSet<object>
): void {
  if (value === null) {
    return;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${label} contains a non-finite number at ${formatJsonPath(path)}`);
      }
      return;
    case "undefined":
      throw new Error(`${label} contains undefined at ${formatJsonPath(path)}`);
    case "function":
      throw new Error(`${label} contains a function at ${formatJsonPath(path)}`);
    case "symbol":
      throw new Error(`${label} contains a symbol at ${formatJsonPath(path)}`);
    case "bigint":
      throw new Error(`${label} contains a bigint at ${formatJsonPath(path)}`);
    case "object":
      validateJsonContainer(value, label, path, ancestors);
      return;
  }
}

function validateJsonContainer(
  value: object,
  label: string,
  path: JsonValidationPathSegment[],
  ancestors: WeakSet<object>
): void {
  if (ancestors.has(value)) {
    throw new Error(`${label} contains a circular structure at ${formatJsonPath(path)}`);
  }

  if (hasCustomJsonSerialization(value)) {
    throw new Error(`${label} contains custom JSON serialization at ${formatJsonPath(path)}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      validateJsonArray(value, label, path, ancestors);
      return;
    }

    if (!isPlainJsonRecord(value)) {
      throw new Error(`${label} contains a non-plain object at ${formatJsonPath(path)}`);
    }

    validateJsonObjectMembers(value, label, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function validateJsonArray(
  value: unknown[],
  label: string,
  path: JsonValidationPathSegment[],
  ancestors: WeakSet<object>
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new Error(`${label} contains a symbol key at ${formatJsonPath(path)}`);
    }

    if (key !== "length" && !isArrayIndexKey(key, value.length)) {
      throw new Error(`${label} contains a non-JSON array property at ${formatJsonPath([...path, key])}`);
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw new Error(`${label} contains an array hole at ${formatJsonPath([...path, index])}`);
    }

    validateJsonValue(value[index], label, [...path, index], ancestors);
  }
}

function validateJsonObjectMembers(
  value: object,
  label: string,
  path: JsonValidationPathSegment[],
  ancestors: WeakSet<object>
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new Error(`${label} contains a symbol key at ${formatJsonPath(path)}`);
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }

    if (!descriptor.enumerable) {
      throw new Error(`${label} contains a non-enumerable property at ${formatJsonPath([...path, key])}`);
    }

    if (!("value" in descriptor)) {
      throw new Error(`${label} contains an accessor property at ${formatJsonPath([...path, key])}`);
    }

    validateJsonValue(descriptor.value, label, [...path, key], ancestors);
  }
}

function hasCustomJsonSerialization(value: object): boolean {
  return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return false;
  }

  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function formatJsonPath(path: JsonValidationPathSegment[]): string {
  if (path.length === 0) {
    return "$";
  }

  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") {
      return `${formatted}[${segment}]`;
    }

    return `${formatted}.${segment}`;
  }, "$");
}

function parseStoredFsrsState(row: ReviewRow): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.fsrsState) as unknown;
  } catch (error) {
    throw new Error(`Review ${row.id} fsrs_state must be a JSON object`, { cause: error });
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Review ${row.id} fsrs_state must be a JSON object`);
  }

  return parsed;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (!isJsonObject(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeDateTime(value: string | Date, label: string): string {
  const parsed = parseValidDate(value, label);
  return parsed.toISOString();
}

function nextUtcDay(value: string | Date): string {
  const parsed = parseValidDate(value, "review target");
  const utcDayStart = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate() + 1);
  return new Date(utcDayStart).toISOString();
}

function parseValidDate(value: string | Date, label: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`Invalid ${label}`);
    }

    return value;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }

  validateDatePrefix(value, label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function validateDatePrefix(value: string, label: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) {
    return;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  const expected = `${match[1]}-${match[2]}-${match[3]}`;
  if (normalized !== expected) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive safe integer");
  }

  return limit;
}
