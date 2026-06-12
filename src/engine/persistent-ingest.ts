import type Database from "better-sqlite3";

import {
  runMockIngest,
  type MockChunk,
  type MockConcept,
  type MockConceptEdge,
  type MockIngestOptions,
  type MockIngestResult,
  type MockIngestSource,
  type MockPage
} from "./mock-commands.js";
import type { SourceAdapter } from "./source-adapter.js";
import type { TraceEvent, TraceLevel, TraceStage } from "./trace.js";

export interface PersistentMockIngestSummary {
  runId: string;
  sourcesSeen: number;
  sourcesProcessed: number;
  sourcesSkipped: number;
  chunksCreated: number;
  conceptsCreated: number;
  pagesCreated: number;
  traceEvents: TraceEvent[];
}

export async function runPersistentMockIngest(
  db: Database.Database,
  adapter: SourceAdapter,
  options: MockIngestOptions = {}
): Promise<PersistentMockIngestSummary> {
  const mockResult = await runMockIngest(adapter, options);
  const fallbackTraceEvents: TraceEvent[] = [];
  const context: PersistenceContext = {
    runId: mockResult.runId,
    trace: options.trace,
    fallbackTraceEvents
  };

  const counts = persistMockResult(db, mockResult, context);
  const traceEvents =
    options.trace?.getEvents({ runId: mockResult.runId }) ?? [...mockResult.traceEvents, ...fallbackTraceEvents];

  return {
    runId: mockResult.runId,
    sourcesSeen: mockResult.sources.length,
    ...counts,
    traceEvents
  };
}

interface PersistenceCounts {
  sourcesProcessed: number;
  sourcesSkipped: number;
  chunksCreated: number;
  conceptsCreated: number;
  pagesCreated: number;
}

interface PersistenceContext {
  runId: string;
  trace?: NonNullable<MockIngestOptions["trace"]>;
  fallbackTraceEvents: TraceEvent[];
}

interface SourceRow {
  id: number;
  fingerprint: string;
}

interface IdRow {
  id: number;
}

interface ChunkRow {
  id: number;
  seq: number;
}

function persistMockResult(
  db: Database.Database,
  result: MockIngestResult,
  context: PersistenceContext
): PersistenceCounts {
  const statements = prepareStatements(db);
  const persist = db.transaction(() => {
    const state = createPersistenceState();
    persistSources(result, statements, state, context);
    persistConcepts(result.concepts, statements, state);
    persistEdges(result.edges, statements, state);
    persistPages(result.pages, statements, state);
    return state.counts;
  });

  return persist();
}

function prepareStatements(db: Database.Database) {
  return {
    selectSource: db.prepare(
      `SELECT id, fingerprint
       FROM sources
       WHERE adapter_id = ? AND doc_ref = ?`
    ),
    insertSource: db.prepare(
      `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
       VALUES (?, ?, ?, ?, 'ingested')`
    ),
    insertChunk: db.prepare(
      `INSERT INTO chunks (source_id, seq, text, meta)
       VALUES (?, ?, ?, ?)`
    ),
    selectChunksBySource: db.prepare(
      `SELECT id, seq
       FROM chunks
       WHERE source_id = ?
       ORDER BY seq`
    ),
    selectConcept: db.prepare(
      `SELECT id
       FROM concepts
       WHERE slug = ?`
    ),
    insertConcept: db.prepare(
      `INSERT INTO concepts (slug, name, summary, domain, status)
       VALUES (?, ?, ?, NULL, 'generated')`
    ),
    insertEdge: db.prepare(
      `INSERT OR IGNORE INTO concept_edges (from_concept_id, to_concept_id, kind, weight)
       VALUES (?, ?, ?, ?)`
    ),
    selectPage: db.prepare(
      `SELECT id
       FROM pages
       WHERE concept_id = ? AND version = 1`
    ),
    insertPage: db.prepare(
      `INSERT INTO pages (concept_id, version, markdown, citations, visibility)
       VALUES (?, 1, ?, ?, ?)`
    )
  };
}

type Statements = ReturnType<typeof prepareStatements>;

interface PersistenceState {
  sourceDbIds: Map<string, number>;
  chunkDbIds: Map<string, number>;
  conceptDbIds: Map<string, number>;
  processedSourceIds: Set<string>;
  changedSkippedSourceIds: Set<string>;
  contributingConceptSlugs: Set<string>;
  changedContributedConceptSlugs: Set<string>;
  counts: PersistenceCounts;
}

function createPersistenceState(): PersistenceState {
  return {
    sourceDbIds: new Map(),
    chunkDbIds: new Map(),
    conceptDbIds: new Map(),
    processedSourceIds: new Set(),
    changedSkippedSourceIds: new Set(),
    contributingConceptSlugs: new Set(),
    changedContributedConceptSlugs: new Set(),
    counts: {
      sourcesProcessed: 0,
      sourcesSkipped: 0,
      chunksCreated: 0,
      conceptsCreated: 0,
      pagesCreated: 0
    }
  };
}

function persistSources(
  result: MockIngestResult,
  statements: Statements,
  state: PersistenceState,
  context: PersistenceContext
): void {
  for (const source of result.sources) {
    const existing = statements.selectSource.get(source.adapterId, source.path) as SourceRow | undefined;
    if (existing === undefined) {
      insertNewSource(source, chunksForSource(result.chunks, source.id), statements, state);
      continue;
    }

    state.sourceDbIds.set(source.id, existing.id);
    state.counts.sourcesSkipped += 1;
    if (existing.fingerprint === source.fingerprint) {
      mapExistingChunks(source.id, result.chunks, existing.id, statements, state);
      recordPersistentTrace(context, "chunk", "info", "Skipped unchanged source.", {
        outcome: "skipped_unchanged",
        adapterId: source.adapterId,
        docRef: source.path,
        fingerprint: source.fingerprint
      });
    } else {
      state.changedSkippedSourceIds.add(source.id);
      recordPersistentTrace(context, "merge", "warn", "Skipped changed source fingerprint.", {
        outcome: "skipped_changed_fingerprint",
        adapterId: source.adapterId,
        docRef: source.path,
        existingFingerprint: existing.fingerprint,
        incomingFingerprint: source.fingerprint
      });
    }
  }
}

function insertNewSource(
  source: MockIngestSource,
  chunks: MockChunk[],
  statements: Statements,
  state: PersistenceState
): void {
  const result = statements.insertSource.run(source.adapterId, source.path, source.title, source.fingerprint);
  const sourceDbId = toNumberId(result.lastInsertRowid);

  state.sourceDbIds.set(source.id, sourceDbId);
  state.processedSourceIds.add(source.id);
  state.counts.sourcesProcessed += 1;

  for (const chunk of chunks) {
    const chunkResult = statements.insertChunk.run(sourceDbId, chunk.seq, chunk.text, JSON.stringify(chunkMeta(chunk)));
    state.chunkDbIds.set(chunk.id, toNumberId(chunkResult.lastInsertRowid));
    state.counts.chunksCreated += 1;
  }
}

function mapExistingChunks(
  sourceId: string,
  chunks: MockChunk[],
  sourceDbId: number,
  statements: Statements,
  state: PersistenceState
): void {
  const rows = statements.selectChunksBySource.all(sourceDbId) as ChunkRow[];
  const idBySeq = new Map(rows.map((row) => [row.seq, row.id]));

  for (const chunk of chunksForSource(chunks, sourceId)) {
    const chunkDbId = idBySeq.get(chunk.seq);
    if (chunkDbId !== undefined) {
      state.chunkDbIds.set(chunk.id, chunkDbId);
    }
  }
}

function persistConcepts(concepts: MockConcept[], statements: Statements, state: PersistenceState): void {
  for (const concept of concepts) {
    if (concept.sourceIds.some((sourceId) => state.changedSkippedSourceIds.has(sourceId))) {
      state.changedContributedConceptSlugs.add(concept.slug);
    }

    if (!concept.sourceIds.some((sourceId) => state.processedSourceIds.has(sourceId))) {
      continue;
    }

    state.contributingConceptSlugs.add(concept.slug);
    const existing = statements.selectConcept.get(concept.slug) as IdRow | undefined;
    if (existing !== undefined) {
      state.conceptDbIds.set(concept.slug, existing.id);
    } else {
      const result = statements.insertConcept.run(concept.slug, concept.name, concept.summary);
      state.conceptDbIds.set(concept.slug, toNumberId(result.lastInsertRowid));
      state.counts.conceptsCreated += 1;
    }
  }
}

function persistEdges(edges: MockConceptEdge[], statements: Statements, state: PersistenceState): void {
  for (const edge of edges) {
    if (!edgeOriginIsContributing(edge, state)) {
      continue;
    }

    const fromId = conceptIdForSlug(edge.from, statements, state);
    const toId = conceptIdForSlug(edge.to, statements, state);
    if (fromId !== undefined && toId !== undefined) {
      statements.insertEdge.run(fromId, toId, edge.kind, edge.weight ?? 1);
    }
  }
}

function edgeOriginIsContributing(edge: MockConceptEdge, state: PersistenceState): boolean {
  if (edge.kind === "related") {
    return state.contributingConceptSlugs.has(edge.from) && !state.changedContributedConceptSlugs.has(edge.from);
  }

  return state.contributingConceptSlugs.has(edge.to) && !state.changedContributedConceptSlugs.has(edge.to);
}

function conceptIdForSlug(slug: string, statements: Statements, state: PersistenceState): number | undefined {
  const cached = state.conceptDbIds.get(slug);
  if (cached !== undefined) {
    return cached;
  }

  const existing = statements.selectConcept.get(slug) as IdRow | undefined;
  if (existing !== undefined) {
    state.conceptDbIds.set(slug, existing.id);
    return existing.id;
  }

  return undefined;
}

function persistPages(pages: MockPage[], statements: Statements, state: PersistenceState): void {
  for (const page of pages) {
    if (!state.contributingConceptSlugs.has(page.slug)) {
      continue;
    }

    const conceptId = state.conceptDbIds.get(page.slug);
    if (conceptId === undefined || statements.selectPage.get(conceptId) !== undefined) {
      continue;
    }

    const citationIds = page.citations.map((citation) => state.chunkDbIds.get(citation));
    if (citationIds.some((citationId) => citationId === undefined)) {
      continue;
    }

    statements.insertPage.run(conceptId, page.markdown, JSON.stringify(citationIds), page.visibility);
    state.counts.pagesCreated += 1;
  }
}

function chunksForSource(chunks: MockChunk[], sourceId: string): MockChunk[] {
  return chunks.filter((chunk) => chunk.sourceId === sourceId).sort((left, right) => left.seq - right.seq);
}

function chunkMeta(chunk: MockChunk): Record<string, unknown> {
  return {
    mockChunkId: chunk.id,
    heading: chunk.heading,
    level: chunk.level
  };
}

function recordPersistentTrace(
  context: PersistenceContext,
  stage: TraceStage,
  level: TraceLevel,
  message: string,
  data: Record<string, unknown>
): void {
  const eventInput = {
    runId: context.runId,
    stage,
    level,
    message,
    data
  };

  if (context.trace !== undefined) {
    context.trace.record(eventInput);
    return;
  }

  context.fallbackTraceEvents.push({
    ...eventInput,
    timestamp: "1970-01-01T00:00:00.000Z"
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
