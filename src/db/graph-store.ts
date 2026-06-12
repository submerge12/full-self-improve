import type Database from "better-sqlite3";

import type { TraceRecorder } from "../engine/trace.js";

export type ConceptStatus = "stub" | "generated" | "reviewed";
export type ConceptEdgeKind = "prerequisite" | "related" | "part_of";
export type ConceptEdgeRejectionReason = "self_edge" | "cycle";

export interface Concept {
  id: number;
  slug: string;
  name: string;
  summary: string | null;
  domain: string | null;
  status: ConceptStatus;
}

export interface ConceptEdge {
  id: number;
  fromConceptId: number;
  toConceptId: number;
  kind: ConceptEdgeKind;
  weight: number;
}

export interface CreateConceptInput {
  slug: string;
  name: string;
  summary?: string | null;
  domain?: string | null;
  status?: ConceptStatus;
}

export interface AddConceptEdgeInput {
  fromConceptId: number;
  toConceptId: number;
  kind: ConceptEdgeKind;
  weight?: number;
}

export interface GraphTraceContext {
  traceRecorder?: TraceRecorder;
  runId?: string;
}

export class ConceptEdgeRejectedError extends Error {
  readonly reason: ConceptEdgeRejectionReason;
  readonly data: EdgeTraceData;

  constructor(reason: ConceptEdgeRejectionReason, message: string, data: EdgeTraceData) {
    super(message);
    this.name = "ConceptEdgeRejectedError";
    this.reason = reason;
    this.data = data;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface ConceptRow {
  id: number;
  slug: string;
  name: string;
  summary: string | null;
  domain: string | null;
  status: ConceptStatus;
}

interface ConceptEdgeRow {
  id: number;
  fromConceptId: number;
  toConceptId: number;
  kind: ConceptEdgeKind;
  weight: number;
}

interface EdgeTraceData {
  outcome: "accepted" | "rejected";
  fromConceptId: number;
  toConceptId: number;
  kind: ConceptEdgeKind;
  weight: number;
  edgeId?: number;
  reason?: ConceptEdgeRejectionReason;
}

export function createConcept(db: Database.Database, input: CreateConceptInput): Concept {
  const result = db
    .prepare(
      `INSERT INTO concepts (slug, name, summary, domain, status)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.slug, input.name, input.summary ?? null, input.domain ?? null, input.status ?? "stub");

  return getConceptById(db, toNumberId(result.lastInsertRowid));
}

export function addConceptEdge(
  db: Database.Database,
  input: AddConceptEdgeInput,
  traceContext: GraphTraceContext = {}
): ConceptEdge {
  const weight = input.weight ?? 1;
  const traceData: EdgeTraceData = {
    outcome: "rejected",
    fromConceptId: input.fromConceptId,
    toConceptId: input.toConceptId,
    kind: input.kind,
    weight
  };

  if (input.fromConceptId === input.toConceptId) {
    rejectEdge("self_edge", "Concept edge cannot link a concept to itself", traceData, traceContext);
  }

  if (wouldCreateDirectedCycle(db, input.fromConceptId, input.toConceptId)) {
    rejectEdge("cycle", "Concept edge would create a directed cycle", traceData, traceContext);
  }

  const result = db
    .prepare(
      `INSERT INTO concept_edges (from_concept_id, to_concept_id, kind, weight)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.fromConceptId, input.toConceptId, input.kind, weight);

  const edge = getConceptEdgeById(db, toNumberId(result.lastInsertRowid));
  recordLinkTrace(traceContext, "info", "Concept edge inserted", {
    ...traceData,
    outcome: "accepted",
    edgeId: edge.id
  });

  return edge;
}

export function listConceptEdges(db: Database.Database): ConceptEdge[] {
  const rows = db
    .prepare(
      `SELECT
         id,
         from_concept_id AS fromConceptId,
         to_concept_id AS toConceptId,
         kind,
         weight
       FROM concept_edges
       ORDER BY id`
    )
    .all() as ConceptEdgeRow[];

  return rows.map(mapConceptEdgeRow);
}

function getConceptById(db: Database.Database, id: number): Concept {
  const row = db
    .prepare(
      `SELECT id, slug, name, summary, domain, status
       FROM concepts
       WHERE id = ?`
    )
    .get(id) as ConceptRow | undefined;

  if (row === undefined) {
    throw new Error(`Concept ${id} was not found after insert`);
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    domain: row.domain,
    status: row.status
  };
}

function getConceptEdgeById(db: Database.Database, id: number): ConceptEdge {
  const row = db
    .prepare(
      `SELECT
         id,
         from_concept_id AS fromConceptId,
         to_concept_id AS toConceptId,
         kind,
         weight
       FROM concept_edges
       WHERE id = ?`
    )
    .get(id) as ConceptEdgeRow | undefined;

  if (row === undefined) {
    throw new Error(`Concept edge ${id} was not found after insert`);
  }

  return mapConceptEdgeRow(row);
}

function mapConceptEdgeRow(row: ConceptEdgeRow): ConceptEdge {
  return {
    id: row.id,
    fromConceptId: row.fromConceptId,
    toConceptId: row.toConceptId,
    kind: row.kind,
    weight: row.weight
  };
}

function wouldCreateDirectedCycle(db: Database.Database, fromConceptId: number, toConceptId: number): boolean {
  const row = db
    .prepare(
      `WITH RECURSIVE reachable(id) AS (
         SELECT to_concept_id
         FROM concept_edges
         WHERE from_concept_id = ?
         UNION
         SELECT concept_edges.to_concept_id
         FROM concept_edges
         INNER JOIN reachable ON concept_edges.from_concept_id = reachable.id
       )
       SELECT 1
       FROM reachable
       WHERE id = ?
       LIMIT 1`
    )
    .get(toConceptId, fromConceptId);

  return row !== undefined;
}

function rejectEdge(
  reason: ConceptEdgeRejectionReason,
  message: string,
  traceData: EdgeTraceData,
  traceContext: GraphTraceContext
): never {
  const data: EdgeTraceData = {
    ...traceData,
    reason
  };

  recordLinkTrace(traceContext, "error", "Concept edge rejected", data);
  throw new ConceptEdgeRejectedError(reason, message, data);
}

function recordLinkTrace(
  traceContext: GraphTraceContext,
  level: "info" | "warn" | "error",
  message: string,
  data: EdgeTraceData
): void {
  if (traceContext.traceRecorder === undefined || traceContext.runId === undefined) {
    return;
  }

  traceContext.traceRecorder.record({
    runId: traceContext.runId,
    stage: "link",
    level,
    message,
    data
  });
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
