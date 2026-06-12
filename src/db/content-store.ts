import type Database from "better-sqlite3";

import type { TraceRecorder } from "../engine/trace.js";

export type SourceStatus = "pending" | "ingested" | "error";
export type PageVisibility = "private" | "public";

export type ContentStoreValidationReason =
  | "public_page_requires_citation"
  | "invalid_citation_ids"
  | "invalid_citation_id"
  | "missing_citation"
  | "missing_concept"
  | "score_out_of_range"
  | "confidence_out_of_range"
  | "attempts_n_out_of_range";

export interface ContentStoreTraceContext {
  traceRecorder?: TraceRecorder;
  runId?: string;
}

export interface SourceRecord {
  id: number;
  adapterId: string;
  docRef: string;
  title: string;
  fingerprint: string;
  status: SourceStatus;
  ingestedAt: string;
}

export interface ChunkRecord {
  id: number;
  sourceId: number;
  seq: number;
  text: string;
  meta: string;
}

export interface SourceWithChunk {
  source: SourceRecord;
  chunk: ChunkRecord;
}

export interface CreateSourceWithChunkInput {
  adapterId: string;
  docRef: string;
  title: string;
  fingerprint: string;
  chunkText: string;
  status?: SourceStatus;
  seq?: number;
  chunkMeta?: Record<string, unknown>;
}

export interface PageRecord {
  id: number;
  conceptId: number;
  version: number;
  markdown: string;
  citationIds: number[];
  visibility: PageVisibility;
}

export interface CreatePageInput {
  conceptId: number;
  version: number;
  markdown: string;
  citationIds: number[];
  visibility: PageVisibility;
}

export interface MasteryRecord {
  id: number;
  conceptId: number;
  score: number;
  confidence: number;
  attemptsN: number;
  lastSeenAt: string | null;
}

export interface RecordMasteryUpdateInput {
  conceptId: number;
  score: number;
  confidence: number;
  attemptsN?: number;
  lastSeenAt?: string;
}

export class ContentStoreValidationError extends Error {
  readonly reason: ContentStoreValidationReason;
  readonly data: Record<string, unknown>;

  constructor(reason: ContentStoreValidationReason, message: string, data: Record<string, unknown>) {
    super(message);
    this.name = "ContentStoreValidationError";
    this.reason = reason;
    this.data = data;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface SourceRow {
  id: number;
  adapterId: string;
  docRef: string;
  title: string;
  fingerprint: string;
  status: SourceStatus;
  ingestedAt: string;
}

interface ChunkRow {
  id: number;
  sourceId: number;
  seq: number;
  text: string;
  meta: string;
}

interface PageRow {
  id: number;
  conceptId: number;
  version: number;
  markdown: string;
  citations: string;
  visibility: PageVisibility;
}

interface MasteryRow {
  id: number;
  conceptId: number;
  score: number;
  confidence: number;
  attemptsN: number;
  lastSeenAt: string | null;
}

export function createSourceWithChunk(
  db: Database.Database,
  input: CreateSourceWithChunkInput
): SourceWithChunk {
  const create = db.transaction((): SourceWithChunk => {
    const sourceResult = db
      .prepare(
        `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.adapterId, input.docRef, input.title, input.fingerprint, input.status ?? "ingested");
    const source = getSourceById(db, toNumberId(sourceResult.lastInsertRowid));
    const chunkResult = db
      .prepare(
        `INSERT INTO chunks (source_id, seq, text, meta)
         VALUES (?, ?, ?, ?)`
      )
      .run(source.id, input.seq ?? 1, input.chunkText, JSON.stringify(input.chunkMeta ?? {}));

    return {
      source,
      chunk: getChunkById(db, toNumberId(chunkResult.lastInsertRowid))
    };
  });

  return create();
}

export function createPage(
  db: Database.Database,
  input: CreatePageInput,
  traceContext: ContentStoreTraceContext = {}
): PageRecord {
  const create = db.transaction((): PageRecord => {
    const citationIds = validatePageInput(db, input, traceContext);
    const result = db
      .prepare(
        `INSERT INTO pages (concept_id, version, markdown, citations, visibility)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.conceptId, input.version, input.markdown, JSON.stringify(citationIds), input.visibility);
    const page = getPageById(db, toNumberId(result.lastInsertRowid));

    recordPageTrace(traceContext, "info", "Page inserted", {
      outcome: "accepted",
      pageId: page.id,
      conceptId: page.conceptId,
      version: page.version,
      visibility: page.visibility,
      citationIds: page.citationIds
    });

    return page;
  });

  return create();
}

export function listPublicPages(db: Database.Database): PageRecord[] {
  const rows = db
    .prepare(
      `SELECT
         id,
         concept_id AS conceptId,
         version,
         markdown,
         citations,
         visibility
       FROM pages
       WHERE visibility = 'public'
       ORDER BY id`
    )
    .all() as PageRow[];

  return rows.map(mapPageRow);
}

export function recordMasteryUpdate(
  db: Database.Database,
  input: RecordMasteryUpdateInput,
  traceContext: ContentStoreTraceContext = {}
): MasteryRecord {
  const update = db.transaction((): MasteryRecord => {
    validateMasteryInput(db, input, traceContext);
    const lastSeenAt = input.lastSeenAt ?? new Date().toISOString();

    if (input.attemptsN === undefined) {
      db.prepare(
        `INSERT INTO mastery (concept_id, score, confidence, attempts_n, last_seen_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(concept_id) DO UPDATE SET
           score = excluded.score,
           confidence = excluded.confidence,
           attempts_n = mastery.attempts_n + 1,
           last_seen_at = excluded.last_seen_at`
      ).run(input.conceptId, input.score, input.confidence, lastSeenAt);
    } else {
      db.prepare(
        `INSERT INTO mastery (concept_id, score, confidence, attempts_n, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(concept_id) DO UPDATE SET
           score = excluded.score,
           confidence = excluded.confidence,
           attempts_n = excluded.attempts_n,
           last_seen_at = excluded.last_seen_at`
      ).run(input.conceptId, input.score, input.confidence, input.attemptsN, lastSeenAt);
    }

    const mastery = getMasteryByConceptId(db, input.conceptId);
    recordGradeTrace(traceContext, "info", "Mastery updated", {
      outcome: "accepted",
      conceptId: mastery.conceptId,
      score: mastery.score,
      confidence: mastery.confidence,
      attemptsN: mastery.attemptsN,
      lastSeenAt: mastery.lastSeenAt
    });

    return mastery;
  });

  return update();
}

function validatePageInput(
  db: Database.Database,
  input: CreatePageInput,
  traceContext: ContentStoreTraceContext
): number[] {
  const citationIds = validateCitationIdsContainer(input, traceContext);

  if (input.visibility === "public" && citationIds.length === 0) {
    rejectPage("public_page_requires_citation", "Public pages require at least one citation", input, traceContext);
  }

  for (const citationId of citationIds) {
    if (!isValidCitationId(citationId)) {
      rejectPage("invalid_citation_id", "Citation id must be a positive safe integer", input, traceContext, {
        invalidCitationId: citationId
      });
    }

    if (!chunkExists(db, citationId)) {
      rejectPage("missing_citation", `Citation chunk ${citationId} does not exist`, input, traceContext, {
        missingCitationId: citationId
      });
    }
  }

  if (!conceptExists(db, input.conceptId)) {
    rejectPage("missing_concept", `Concept ${input.conceptId} does not exist`, input, traceContext);
  }

  return citationIds;
}

function validateMasteryInput(
  db: Database.Database,
  input: RecordMasteryUpdateInput,
  traceContext: ContentStoreTraceContext
): void {
  if (!isUnitInterval(input.score)) {
    rejectMastery("score_out_of_range", "Mastery score must be between 0 and 1", input, traceContext);
  }

  if (!isUnitInterval(input.confidence)) {
    rejectMastery("confidence_out_of_range", "Mastery confidence must be between 0 and 1", input, traceContext);
  }

  if (input.attemptsN !== undefined && (!Number.isSafeInteger(input.attemptsN) || input.attemptsN < 0)) {
    rejectMastery("attempts_n_out_of_range", "Mastery attemptsN must be a nonnegative safe integer", input, traceContext);
  }

  if (!conceptExists(db, input.conceptId)) {
    rejectMastery("missing_concept", `Concept ${input.conceptId} does not exist`, input, traceContext);
  }
}

function getSourceById(db: Database.Database, id: number): SourceRecord {
  const row = db
    .prepare(
      `SELECT
         id,
         adapter_id AS adapterId,
         doc_ref AS docRef,
         title,
         fingerprint,
         status,
         ingested_at AS ingestedAt
       FROM sources
       WHERE id = ?`
    )
    .get(id) as SourceRow | undefined;

  if (row === undefined) {
    throw new Error(`Source ${id} was not found after insert`);
  }

  return {
    id: row.id,
    adapterId: row.adapterId,
    docRef: row.docRef,
    title: row.title,
    fingerprint: row.fingerprint,
    status: row.status,
    ingestedAt: row.ingestedAt
  };
}

function getChunkById(db: Database.Database, id: number): ChunkRecord {
  const row = db
    .prepare(
      `SELECT
         id,
         source_id AS sourceId,
         seq,
         text,
         meta
       FROM chunks
       WHERE id = ?`
    )
    .get(id) as ChunkRow | undefined;

  if (row === undefined) {
    throw new Error(`Chunk ${id} was not found after insert`);
  }

  return {
    id: row.id,
    sourceId: row.sourceId,
    seq: row.seq,
    text: row.text,
    meta: row.meta
  };
}

function getPageById(db: Database.Database, id: number): PageRecord {
  const row = db
    .prepare(
      `SELECT
         id,
         concept_id AS conceptId,
         version,
         markdown,
         citations,
         visibility
       FROM pages
       WHERE id = ?`
    )
    .get(id) as PageRow | undefined;

  if (row === undefined) {
    throw new Error(`Page ${id} was not found after insert`);
  }

  return mapPageRow(row);
}

function getMasteryByConceptId(db: Database.Database, conceptId: number): MasteryRecord {
  const row = db
    .prepare(
      `SELECT
         id,
         concept_id AS conceptId,
         score,
         confidence,
         attempts_n AS attemptsN,
         last_seen_at AS lastSeenAt
       FROM mastery
       WHERE concept_id = ?`
    )
    .get(conceptId) as MasteryRow | undefined;

  if (row === undefined) {
    throw new Error(`Mastery for concept ${conceptId} was not found after upsert`);
  }

  return {
    id: row.id,
    conceptId: row.conceptId,
    score: row.score,
    confidence: row.confidence,
    attemptsN: row.attemptsN,
    lastSeenAt: row.lastSeenAt
  };
}

function mapPageRow(row: PageRow): PageRecord {
  return {
    id: row.id,
    conceptId: row.conceptId,
    version: row.version,
    markdown: row.markdown,
    citationIds: parseStoredCitationIds(row),
    visibility: row.visibility
  };
}

function conceptExists(db: Database.Database, conceptId: number): boolean {
  return db.prepare("SELECT 1 FROM concepts WHERE id = ?").get(conceptId) !== undefined;
}

function chunkExists(db: Database.Database, chunkId: number): boolean {
  return db.prepare("SELECT 1 FROM chunks WHERE id = ?").get(chunkId) !== undefined;
}

function rejectPage(
  reason: ContentStoreValidationReason,
  message: string,
  input: CreatePageInput,
  traceContext: ContentStoreTraceContext,
  data: Record<string, unknown> = {}
): never {
  const traceData = {
    outcome: "rejected",
    conceptId: input.conceptId,
    version: input.version,
    visibility: input.visibility,
    citationIds: citationIdsForTrace(input),
    ...data
  };

  recordPageTrace(traceContext, "error", "Page rejected", { ...traceData, reason });
  throw new ContentStoreValidationError(reason, message, { ...traceData, reason });
}

function rejectMastery(
  reason: ContentStoreValidationReason,
  message: string,
  input: RecordMasteryUpdateInput,
  traceContext: ContentStoreTraceContext
): never {
  const traceData = {
    outcome: "rejected",
    conceptId: input.conceptId,
    score: input.score,
    confidence: input.confidence,
    attemptsN: input.attemptsN ?? null,
    reason
  };

  recordGradeTrace(traceContext, "error", "Mastery update rejected", traceData);
  throw new ContentStoreValidationError(reason, message, traceData);
}

function recordPageTrace(
  traceContext: ContentStoreTraceContext,
  level: "info" | "error",
  message: string,
  data: Record<string, unknown>
): void {
  if (traceContext.traceRecorder === undefined || traceContext.runId === undefined) {
    return;
  }

  traceContext.traceRecorder.record({
    runId: traceContext.runId,
    stage: "page-gen",
    level,
    message,
    data
  });
}

function recordGradeTrace(
  traceContext: ContentStoreTraceContext,
  level: "info" | "error",
  message: string,
  data: Record<string, unknown>
): void {
  if (traceContext.traceRecorder === undefined || traceContext.runId === undefined) {
    return;
  }

  traceContext.traceRecorder.record({
    runId: traceContext.runId,
    stage: "grade",
    level,
    message,
    data
  });
}

function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateCitationIdsContainer(
  input: CreatePageInput,
  traceContext: ContentStoreTraceContext
): number[] {
  if (!Array.isArray(input.citationIds)) {
    rejectPage("invalid_citation_ids", "Page citationIds must be an array", input, traceContext);
  }

  return input.citationIds;
}

function parseStoredCitationIds(row: PageRow): number[] {
  const parsed = JSON.parse(row.citations) as unknown;

  if (!Array.isArray(parsed)) {
    throw new ContentStoreValidationError("invalid_citation_ids", `Page ${row.id} citations must be an array`, {
      reason: "invalid_citation_ids",
      pageId: row.id,
      citations: parsed ?? null
    });
  }

  return validateStoredCitationIds(row.id, parsed);
}

function validateStoredCitationIds(pageId: number, citationIds: unknown[]): number[] {
  const validCitationIds: number[] = [];

  for (const citationId of citationIds) {
    if (!isValidCitationId(citationId)) {
      throw new ContentStoreValidationError("invalid_citation_id", `Page ${pageId} contains an invalid citation id`, {
        reason: "invalid_citation_id",
        pageId,
        invalidCitationId: citationId
      });
    }

    validCitationIds.push(citationId);
  }

  return validCitationIds;
}

function isValidCitationId(citationId: unknown): citationId is number {
  return typeof citationId === "number" && Number.isSafeInteger(citationId) && citationId > 0;
}

function citationIdsForTrace(input: CreatePageInput): unknown {
  if (Array.isArray(input.citationIds)) {
    return [...input.citationIds];
  }

  return input.citationIds ?? null;
}

function toNumberId(id: number | bigint): number {
  if (typeof id === "bigint") {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId)) {
      throw new Error(`SQLite row id is outside the safe integer range: ${id.toString()}`);
    }

    return numericId;
  }

  return id;
}
