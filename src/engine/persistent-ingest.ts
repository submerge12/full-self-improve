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
import type { DocRef, RawDoc, SourceAdapter } from "./source-adapter.js";
import type { TraceEvent, TraceLevel, TraceStage } from "./trace.js";

export interface PersistentMockIngestSummary {
  runId: string;
  sourcesSeen: number;
  sourcesProcessed: number;
  sourcesSkipped: number;
  sourcesFailed: number;
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
  const preflight = await preflightSources(db, adapter);
  const fallbackTraceEvents: TraceEvent[] = [];
  const runId = options.runId ?? `mock-ingest-${slugify(adapter.id)}`;
  const context: PersistenceContext = {
    runId,
    trace: options.trace,
    fallbackTraceEvents
  };
  const processingRead = await readProcessingDocuments(adapter, preflight.refsForProcessing);
  const skippedRead = await readSkippedDocuments(adapter, preflight.skippedUnchangedSources);
  const sourceFailures = [...preflight.failedSources, ...processingRead.failedSources, ...skippedRead.failedSources];
  recordSourceFailureTraces(sourceFailures, context);
  const ingestAdapter = new PreflightSourceAdapter(adapter, processingRead.documents, preflight.fingerprintsByDocRef);
  const mockResult = await runMockIngest(ingestAdapter, { ...options, runId });

  const counts = persistMockResult(
    db,
    mockResult,
    ingestAdapter.getProcessedDocuments(),
    skippedRead.documents,
    sourceFailures,
    context
  );
  recordPreflightSkippedSources(skippedRead.succeededSources, context);
  const traceEvents =
    options.trace?.getEvents({ runId: mockResult.runId }) ?? [...mockResult.traceEvents, ...fallbackTraceEvents];

  return {
    runId: mockResult.runId,
    sourcesSeen: preflight.sourcesSeen,
    sourcesProcessed: counts.sourcesProcessed,
    sourcesSkipped: counts.sourcesSkipped + skippedRead.succeededSources.length,
    sourcesFailed: sourceFailures.length,
    chunksCreated: counts.chunksCreated,
    conceptsCreated: counts.conceptsCreated,
    pagesCreated: counts.pagesCreated,
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
  status: string;
}

interface IdRow {
  id: number;
}

interface ConceptRow {
  id: number;
  slug: string;
  name: string;
  summary: string | null;
}

interface ChunkRow {
  id: number;
  seq: number;
}

interface ChunkTextRow {
  id: number;
  text: string;
}

interface ChunkSourceRow {
  docRef: string;
}

interface AffectedPageRow {
  id: number;
  conceptId: number;
  slug: string;
  citations: string;
}

interface OldAffectedConcept {
  id: number;
  slug: string;
  preservedCitationIds: Set<number>;
}

interface PreflightSkippedSource {
  adapterId: string;
  ref: DocRef;
  fingerprint: string;
}

interface PreflightProcessableSource {
  ref: DocRef;
  fingerprint: string;
}

interface SourceFailure {
  adapterId: string;
  ref: DocRef;
  fingerprint?: string;
  reason: string;
  phase: "fingerprint" | "read";
}

interface PreflightResult {
  sourcesSeen: number;
  refsForProcessing: PreflightProcessableSource[];
  skippedUnchangedSources: PreflightSkippedSource[];
  failedSources: SourceFailure[];
  fingerprintsByDocRef: ReadonlyMap<string, string>;
}

interface ProcessingReadResult {
  documents: Map<string, RawDoc>;
  failedSources: SourceFailure[];
}

interface SkippedReadResult {
  documents: Map<string, RawDoc>;
  succeededSources: PreflightSkippedSource[];
  failedSources: SourceFailure[];
}

class PreflightSourceAdapter implements SourceAdapter {
  readonly id: string;
  readonly kind: string;

  constructor(
    private readonly adapter: SourceAdapter,
    private readonly documents: ReadonlyMap<string, RawDoc>,
    private readonly fingerprintsByDocRef: ReadonlyMap<string, string>
  ) {
    this.id = adapter.id;
    this.kind = adapter.kind;
  }

  async *listDocuments(): AsyncIterable<DocRef> {
    for (const rawDoc of this.documents.values()) {
      yield rawDoc.ref;
    }
  }

  async readDocument(ref: DocRef): Promise<RawDoc> {
    const rawDoc = this.documents.get(ref.path);
    if (rawDoc === undefined) {
      throw new Error(`Missing preflight document: ${ref.path}`);
    }

    this.processedDocuments.set(rawDoc.ref.id, rawDoc);
    return rawDoc;
  }

  fingerprint(ref: DocRef): string {
    const fingerprint = this.fingerprintsByDocRef.get(ref.path);
    if (fingerprint === undefined) {
      throw new Error(`Missing preflight fingerprint: ${ref.path}`);
    }

    return fingerprint;
  }

  getProcessedDocuments(): ReadonlyMap<string, RawDoc> {
    return this.processedDocuments;
  }

  private readonly processedDocuments = new Map<string, RawDoc>();
}

async function preflightSources(db: Database.Database, adapter: SourceAdapter): Promise<PreflightResult> {
  const statements = preparePreflightStatements(db);
  const refsForProcessing: PreflightProcessableSource[] = [];
  const skippedUnchangedSources: PreflightSkippedSource[] = [];
  const failedSources: SourceFailure[] = [];
  const fingerprintsByDocRef = new Map<string, string>();
  let sourcesSeen = 0;

  for await (const ref of adapter.listDocuments()) {
    sourcesSeen += 1;
    let fingerprint: string;
    try {
      fingerprint = adapter.fingerprint(ref);
    } catch (error) {
      const existing = statements.selectSource.get(adapter.id, ref.path) as SourceRow | undefined;
      failedSources.push({
        adapterId: adapter.id,
        ref,
        fingerprint: existing?.fingerprint,
        reason: reasonFromError(error),
        phase: "fingerprint"
      });
      continue;
    }

    fingerprintsByDocRef.set(ref.path, fingerprint);
    const existing = statements.selectSource.get(adapter.id, ref.path) as SourceRow | undefined;
    if (existing !== undefined && existing.status !== "error" && existing.fingerprint === fingerprint) {
      skippedUnchangedSources.push({ adapterId: adapter.id, ref, fingerprint });
    } else {
      refsForProcessing.push({ ref, fingerprint });
    }
  }

  return { sourcesSeen, refsForProcessing, skippedUnchangedSources, failedSources, fingerprintsByDocRef };
}

function preparePreflightStatements(db: Database.Database) {
  return {
    selectSource: db.prepare(
      `SELECT id, fingerprint, status
       FROM sources
       WHERE adapter_id = ? AND doc_ref = ?`
    )
  };
}

async function readProcessingDocuments(
  adapter: SourceAdapter,
  sources: readonly PreflightProcessableSource[]
): Promise<ProcessingReadResult> {
  const documents = new Map<string, RawDoc>();
  const failedSources: SourceFailure[] = [];

  for (const source of sources) {
    try {
      const rawDoc = await adapter.readDocument(source.ref);
      documents.set(rawDoc.ref.path, rawDoc);
    } catch (error) {
      failedSources.push({
        adapterId: adapter.id,
        ref: source.ref,
        fingerprint: source.fingerprint,
        reason: reasonFromError(error),
        phase: "read"
      });
    }
  }

  return { documents, failedSources };
}

function recordPreflightSkippedSources(sources: PreflightSkippedSource[], context: PersistenceContext): void {
  for (const source of sources) {
    recordPersistentTrace(context, "chunk", "info", "Skipped unchanged source.", {
      outcome: "skipped_unchanged",
      adapterId: source.adapterId,
      docRef: source.ref.path,
      fingerprint: source.fingerprint
    });
  }
}

async function readSkippedDocuments(
  adapter: SourceAdapter,
  sources: readonly PreflightSkippedSource[]
): Promise<SkippedReadResult> {
  const docs = new Map<string, RawDoc>();
  const succeededSources: PreflightSkippedSource[] = [];
  const failedSources: SourceFailure[] = [];
  for (const source of sources) {
    try {
      docs.set(source.ref.path, await adapter.readDocument(source.ref));
      succeededSources.push(source);
    } catch (error) {
      failedSources.push({
        adapterId: adapter.id,
        ref: source.ref,
        fingerprint: source.fingerprint,
        reason: reasonFromError(error),
        phase: "read"
      });
    }
  }

  return { documents: docs, succeededSources, failedSources };
}

function persistMockResult(
  db: Database.Database,
  result: MockIngestResult,
  processedDocuments: ReadonlyMap<string, RawDoc>,
  skippedDocuments: ReadonlyMap<string, RawDoc>,
  sourceFailures: readonly SourceFailure[],
  context: PersistenceContext
): PersistenceCounts {
  const statements = prepareStatements(db);
  const persist = db.transaction(() => {
    const state = createPersistenceState(processedDocuments, skippedDocuments);
    persistSourceFailures(sourceFailures, statements);
    persistSources(result, statements, state, context);
    persistConcepts(result.concepts, statements, state);
    reconcileOldAffectedConcepts(statements, state);
    persistEdges(result.edges, statements, state);
    persistPreservedConceptEdges(statements, state);
    persistProcessedRelatedEdges(result.concepts, statements, state);
    persistConceptPrerequisiteEdges(result.concepts, statements, state);
    persistPages(result.pages, result.concepts, statements, state);
    restorePreservedPages(statements, state);
    return state.counts;
  });

  return persist();
}

function prepareStatements(db: Database.Database) {
  return {
    selectSource: db.prepare(
      `SELECT id, fingerprint, status
       FROM sources
       WHERE adapter_id = ? AND doc_ref = ?`
    ),
    insertSource: db.prepare(
      `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
       VALUES (?, ?, ?, ?, 'ingested')`
    ),
    updateSource: db.prepare(
      `UPDATE sources
       SET title = ?, fingerprint = ?, status = 'ingested', ingested_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ),
    insertSourceError: db.prepare(
      `INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status)
       VALUES (?, ?, ?, ?, 'error')`
    ),
    updateSourceError: db.prepare(
      `UPDATE sources
       SET title = ?, fingerprint = ?, status = 'error', ingested_at = CURRENT_TIMESTAMP
       WHERE id = ?`
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
    selectChunkText: db.prepare(
      `SELECT id, text
       FROM chunks
       WHERE id = ?`
    ),
    selectChunkSource: db.prepare(
      `SELECT sources.doc_ref AS docRef
       FROM chunks
       INNER JOIN sources ON sources.id = chunks.source_id
       WHERE chunks.id = ?`
    ),
    deleteChunksBySource: db.prepare(
      `DELETE FROM chunks
       WHERE source_id = ?`
    ),
    selectAffectedPagesByCitation: db.prepare(
      `SELECT DISTINCT
         pages.id,
         pages.concept_id AS conceptId,
         concepts.slug,
         pages.citations
       FROM pages
       INNER JOIN concepts ON concepts.id = pages.concept_id
       CROSS JOIN json_each(pages.citations) AS citation
       WHERE citation.value = ?`
    ),
    deletePageById: db.prepare(
      `DELETE FROM pages
       WHERE id = ?`
    ),
    selectConcept: db.prepare(
      `SELECT id
       FROM concepts
       WHERE slug = ?`
    ),
    selectConceptById: db.prepare(
      `SELECT id, slug, name, summary
       FROM concepts
       WHERE id = ?`
    ),
    insertConcept: db.prepare(
      `INSERT INTO concepts (slug, name, summary, domain, status)
       VALUES (?, ?, ?, NULL, 'generated')`
    ),
    updateConcept: db.prepare(
      `UPDATE concepts
       SET name = ?, summary = ?, status = 'generated'
       WHERE id = ?`
    ),
    deleteConceptById: db.prepare(
      `DELETE FROM concepts
       WHERE id = ?`
    ),
    deleteOwnedEdgesForConcept: db.prepare(
      `DELETE FROM concept_edges
       WHERE (kind = 'related' AND from_concept_id = ?)
          OR (kind IN ('prerequisite', 'part_of') AND to_concept_id = ?)`
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

function persistSourceFailures(failures: readonly SourceFailure[], statements: Statements): void {
  for (const failure of failures) {
    const existing = statements.selectSource.get(failure.adapterId, failure.ref.path) as SourceRow | undefined;
    const fingerprint = failure.fingerprint ?? existing?.fingerprint ?? "";
    if (existing === undefined) {
      statements.insertSourceError.run(failure.adapterId, failure.ref.path, failure.ref.title, fingerprint);
    } else {
      statements.updateSourceError.run(failure.ref.title, fingerprint, existing.id);
    }
  }
}

function recordSourceFailureTraces(
  failures: readonly SourceFailure[],
  context: PersistenceContext
): void {
  if (failures.length === 0) {
    return;
  }

  for (const failure of failures) {
    recordPersistentTrace(context, "chunk", "error", "Source failed during persistent ingest.", {
      outcome: "source_error",
      adapterId: failure.adapterId,
      docRef: failure.ref.path,
      fingerprint: failure.fingerprint,
      reason: failure.reason,
      phase: failure.phase
    });
  }
}

interface PersistenceState {
  sourceDbIds: Map<string, number>;
  chunkDbIds: Map<string, number>;
  conceptDbIds: Map<string, number>;
  processedSourceIds: Set<string>;
  processedDocuments: ReadonlyMap<string, RawDoc>;
  skippedDocuments: ReadonlyMap<string, RawDoc>;
  contributingConceptSlugs: Set<string>;
  affectedConceptIds: Set<number>;
  preservedConceptIds: Set<number>;
  oldAffectedConcepts: Map<number, OldAffectedConcept>;
  preservedCitationIdsByConceptId: Map<number, number[]>;
  deletedConceptIds: Set<number>;
  counts: PersistenceCounts;
}

function createPersistenceState(
  processedDocuments: ReadonlyMap<string, RawDoc>,
  skippedDocuments: ReadonlyMap<string, RawDoc>
): PersistenceState {
  return {
    sourceDbIds: new Map(),
    chunkDbIds: new Map(),
    conceptDbIds: new Map(),
    processedSourceIds: new Set(),
    processedDocuments,
    skippedDocuments,
    contributingConceptSlugs: new Set(),
    affectedConceptIds: new Set(),
    preservedConceptIds: new Set(),
    oldAffectedConcepts: new Map(),
    preservedCitationIdsByConceptId: new Map(),
    deletedConceptIds: new Set(),
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
    if (existing.status !== "error" && existing.fingerprint === source.fingerprint) {
      state.counts.sourcesSkipped += 1;
      mapExistingChunks(source.id, result.chunks, existing.id, statements, state);
      recordPersistentTrace(context, "chunk", "info", "Skipped unchanged source.", {
        outcome: "skipped_unchanged",
        adapterId: source.adapterId,
        docRef: source.path,
        fingerprint: source.fingerprint
      });
    } else {
      reprocessExistingSource(source, chunksForSource(result.chunks, source.id), existing.id, statements, state);
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

  insertChunks(sourceDbId, chunks, statements, state);
}

function reprocessExistingSource(
  source: MockIngestSource,
  chunks: MockChunk[],
  sourceDbId: number,
  statements: Statements,
  state: PersistenceState
): void {
  const oldChunks = statements.selectChunksBySource.all(sourceDbId) as ChunkRow[];

  collectOldAffectedConcepts(oldChunks, statements, state);
  deletePagesCitingChunks(oldChunks, statements);
  statements.deleteChunksBySource.run(sourceDbId);
  statements.updateSource.run(source.title, source.fingerprint, sourceDbId);

  state.sourceDbIds.set(source.id, sourceDbId);
  state.processedSourceIds.add(source.id);
  state.counts.sourcesProcessed += 1;
  insertChunks(sourceDbId, chunks, statements, state);
}

function insertChunks(
  sourceDbId: number,
  chunks: MockChunk[],
  statements: Statements,
  state: PersistenceState
): void {
  for (const chunk of chunks) {
    const chunkResult = statements.insertChunk.run(sourceDbId, chunk.seq, chunk.text, JSON.stringify(chunkMeta(chunk)));
    state.chunkDbIds.set(chunk.id, toNumberId(chunkResult.lastInsertRowid));
    state.counts.chunksCreated += 1;
  }
}

function deletePagesCitingChunks(chunks: ChunkRow[], statements: Statements): void {
  const pageIds = new Set<number>();
  for (const chunk of chunks) {
    const rows = statements.selectAffectedPagesByCitation.all(chunk.id) as AffectedPageRow[];
    for (const row of rows) {
      pageIds.add(row.id);
    }
  }

  for (const pageId of pageIds) {
    statements.deletePageById.run(pageId);
  }
}

function collectOldAffectedConcepts(
  chunks: ChunkRow[],
  statements: Statements,
  state: PersistenceState
): void {
  const oldChunkIds = new Set(chunks.map((chunk) => chunk.id));
  for (const chunk of chunks) {
    const rows = statements.selectAffectedPagesByCitation.all(chunk.id) as AffectedPageRow[];
    for (const row of rows) {
      const existing = state.oldAffectedConcepts.get(row.conceptId);
      const affected = existing ?? {
        id: row.conceptId,
        slug: row.slug,
        preservedCitationIds: new Set<number>()
      };

      for (const citationId of citationIdsFromJson(row.citations)) {
        if (!oldChunkIds.has(citationId)) {
          affected.preservedCitationIds.add(citationId);
        }
      }

      state.oldAffectedConcepts.set(row.conceptId, affected);
    }
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
    if (!concept.sourceIds.some((sourceId) => state.processedSourceIds.has(sourceId))) {
      continue;
    }

    state.contributingConceptSlugs.add(concept.slug);
    const existing = statements.selectConcept.get(concept.slug) as IdRow | undefined;
    if (existing !== undefined) {
      state.conceptDbIds.set(concept.slug, existing.id);
      state.affectedConceptIds.add(existing.id);
      statements.updateConcept.run(concept.name, concept.summary, existing.id);
    } else {
      const result = statements.insertConcept.run(concept.slug, concept.name, concept.summary);
      const conceptId = toNumberId(result.lastInsertRowid);
      state.conceptDbIds.set(concept.slug, conceptId);
      state.affectedConceptIds.add(conceptId);
      state.counts.conceptsCreated += 1;
    }
  }
}

function reconcileOldAffectedConcepts(statements: Statements, state: PersistenceState): void {
  for (const affected of state.oldAffectedConcepts.values()) {
    const preservedCitationIds = existingCitationIds([...affected.preservedCitationIds], statements);
    if (preservedCitationIds.length > 0) {
      state.preservedCitationIdsByConceptId.set(affected.id, preservedCitationIds);
      state.affectedConceptIds.add(affected.id);
      state.preservedConceptIds.add(affected.id);

      if (!state.contributingConceptSlugs.has(affected.slug)) {
        const concept = statements.selectConceptById.get(affected.id) as ConceptRow | undefined;
        if (concept !== undefined) {
          statements.updateConcept.run(
            concept.name,
            summaryFromCitations(concept.name, preservedCitationIds, statements),
            affected.id
          );
        }
      }
    }

    if (state.contributingConceptSlugs.has(affected.slug)) {
      continue;
    }

    if (preservedCitationIds.length === 0) {
      statements.deleteConceptById.run(affected.id);
      state.deletedConceptIds.add(affected.id);
    }
  }
}

function persistEdges(edges: MockConceptEdge[], statements: Statements, state: PersistenceState): void {
  deleteOwnedAffectedEdges(statements, state);

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

function persistPreservedConceptEdges(statements: Statements, state: PersistenceState): void {
  for (const conceptId of state.preservedConceptIds) {
    if (state.deletedConceptIds.has(conceptId)) {
      continue;
    }

    const citationIds = state.preservedCitationIdsByConceptId.get(conceptId) ?? [];
    persistPreservedPrerequisiteEdges(conceptId, citationIds, statements, state);
    persistPreservedRelatedEdges(conceptId, citationIds, statements, state);
  }
}

function persistPreservedPrerequisiteEdges(
  conceptId: number,
  citationIds: number[],
  statements: Statements,
  state: PersistenceState
): void {
  const prerequisites = new Set<string>();

  for (const citationId of citationIds) {
    const chunk = statements.selectChunkText.get(citationId) as ChunkTextRow | undefined;
    if (chunk === undefined) {
      continue;
    }

    for (const prerequisite of summaryPrerequisites(chunk.text)) {
      prerequisites.add(prerequisite);
    }
  }

  for (const doc of skippedDocumentsForCitations(citationIds, statements, state)) {
    for (const prerequisite of metadataPrerequisites(doc.metadata)) {
      prerequisites.add(prerequisite);
    }
  }

  for (const prerequisite of prerequisites) {
    const fromId = conceptIdForSlug(prerequisite, statements, state);
    if (fromId !== undefined && fromId !== conceptId) {
      statements.insertEdge.run(fromId, conceptId, "prerequisite", 1);
    }
  }
}

function persistPreservedRelatedEdges(
  conceptId: number,
  citationIds: number[],
  statements: Statements,
  state: PersistenceState
): void {
  for (const doc of skippedDocumentsForCitations(citationIds, statements, state)) {
    for (const link of doc.links) {
      const toId = conceptIdForSlug(slugify(link), statements, state);
      if (toId !== undefined && toId !== conceptId) {
        statements.insertEdge.run(conceptId, toId, "related", 0.5);
      }
    }
  }
}

function skippedDocumentsForCitations(
  citationIds: number[],
  statements: Statements,
  state: PersistenceState
): RawDoc[] {
  const docs = new Map<string, RawDoc>();
  for (const citationId of citationIds) {
    const source = statements.selectChunkSource.get(citationId) as ChunkSourceRow | undefined;
    if (source === undefined) {
      continue;
    }

    const doc = state.skippedDocuments.get(source.docRef);
    if (doc !== undefined) {
      docs.set(source.docRef, doc);
    }
  }

  return [...docs.values()];
}

function persistProcessedRelatedEdges(
  concepts: MockConcept[],
  statements: Statements,
  state: PersistenceState
): void {
  for (const concept of concepts) {
    if (!state.contributingConceptSlugs.has(concept.slug)) {
      continue;
    }

    const fromId = conceptIdForSlug(concept.slug, statements, state);
    if (fromId === undefined) {
      continue;
    }

    for (const sourceId of concept.sourceIds) {
      const rawDoc = state.processedDocuments.get(sourceId);
      if (rawDoc === undefined) {
        continue;
      }

      for (const link of rawDoc.links) {
        const linkedSlug = slugify(link);
        const toId = conceptIdForSlug(linkedSlug, statements, state);
        if (toId !== undefined && toId !== fromId) {
          statements.insertEdge.run(fromId, toId, "related", 0.5);
        }
      }
    }
  }
}

function persistConceptPrerequisiteEdges(
  concepts: MockConcept[],
  statements: Statements,
  state: PersistenceState
): void {
  for (const concept of concepts) {
    if (!state.contributingConceptSlugs.has(concept.slug)) {
      continue;
    }

    const toId = conceptIdForSlug(concept.slug, statements, state);
    if (toId === undefined) {
      continue;
    }

    for (const prerequisite of concept.prerequisites) {
      const fromId = conceptIdForSlug(prerequisite, statements, state);
      if (fromId !== undefined && fromId !== toId) {
        statements.insertEdge.run(fromId, toId, "prerequisite", 1);
      }
    }
  }
}

function deleteOwnedAffectedEdges(statements: Statements, state: PersistenceState): void {
  for (const conceptId of state.affectedConceptIds) {
    statements.deleteOwnedEdgesForConcept.run(conceptId, conceptId);
  }
}

function edgeOriginIsContributing(edge: MockConceptEdge, state: PersistenceState): boolean {
  if (edge.kind === "related") {
    return state.contributingConceptSlugs.has(edge.from);
  }

  return state.contributingConceptSlugs.has(edge.to);
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

function persistPages(
  pages: MockPage[],
  concepts: MockConcept[],
  statements: Statements,
  state: PersistenceState
): void {
  const conceptBySlug = new Map(concepts.map((concept) => [concept.slug, concept]));

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

    const newCitationIds = citationIds.filter((citationId): citationId is number => citationId !== undefined);
    const allCitationIds = uniqueNumberIds([
      ...newCitationIds,
      ...(state.preservedCitationIdsByConceptId.get(conceptId) ?? [])
    ]);
    const concept = conceptBySlug.get(page.slug);
    const markdown = allCitationIds.length === newCitationIds.length || concept === undefined
      ? page.markdown
      : createPageMarkdown(concept.name, concept.summary, allCitationIds, statements);

    statements.insertPage.run(conceptId, markdown, JSON.stringify(allCitationIds), page.visibility);
    state.counts.pagesCreated += 1;
  }
}

function restorePreservedPages(statements: Statements, state: PersistenceState): void {
  for (const [conceptId, citationIds] of state.preservedCitationIdsByConceptId.entries()) {
    if (state.deletedConceptIds.has(conceptId) || state.contributingConceptSlugs.has(slugForConcept(conceptId, statements))) {
      continue;
    }

    if (statements.selectPage.get(conceptId) !== undefined) {
      continue;
    }

    const concept = statements.selectConceptById.get(conceptId) as ConceptRow | undefined;
    if (concept === undefined) {
      continue;
    }

    statements.insertPage.run(
      conceptId,
      createPageMarkdown(concept.name, summaryFromCitations(concept.name, citationIds, statements), citationIds, statements),
      JSON.stringify(citationIds),
      "private"
    );
    state.counts.pagesCreated += 1;
  }
}

function existingCitationIds(citationIds: number[], statements: Statements): number[] {
  return citationIds.filter((citationId) => statements.selectChunkText.get(citationId) !== undefined);
}

function citationIdsFromJson(citations: string): number[] {
  const parsed = JSON.parse(citations) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((citation): citation is number => Number.isSafeInteger(citation));
}

function createPageMarkdown(
  title: string,
  summary: string,
  citationIds: number[],
  statements: Statements
): string {
  const body = citationIds
    .map((citationId) => statements.selectChunkText.get(citationId) as ChunkTextRow | undefined)
    .filter(isDefined)
    .map((chunk) => chunk.text)
    .filter((text) => text.length > 0)
    .join("\n\n");

  return [`# ${title}`, "", summary, "", body, "", `Citations: ${citationIds.join(", ")}`]
    .filter((part) => part.length > 0)
    .join("\n");
}

function summaryFromCitations(title: string, citationIds: number[], statements: Statements): string {
  for (const citationId of citationIds) {
    const chunk = statements.selectChunkText.get(citationId) as ChunkTextRow | undefined;
    if (chunk !== undefined) {
      const sentence = firstSentence(chunk.text);
      if (sentence.length > 0) {
        return `${title}: ${sentence}`;
      }
    }
  }

  return `Mock concept extracted from heading "${title}".`;
}

function firstSentence(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return "";
  }

  const sentence = /^[^.?!]+[.?!]/.exec(compact);
  return sentence === null ? compact : sentence[0];
}

function summaryPrerequisites(summary: string): string[] {
  const match = /(?:prerequisites?|requires):\s*([^.;\n]+)/i.exec(summary);
  if (match === null) {
    return [];
  }

  return splitList(match[1]).map((value) => slugify(value));
}

function metadataPrerequisites(metadata: Record<string, unknown>): string[] {
  return ["prerequisite", "prerequisites"]
    .flatMap((key) => stringsFromUnknown(metadata[key]))
    .map((value) => slugify(value));
}

function stringsFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return splitList(value);
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").flatMap(splitList);
  }

  return [];
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function slugForConcept(conceptId: number, statements: Statements): string {
  const concept = statements.selectConceptById.get(conceptId) as ConceptRow | undefined;
  return concept?.slug ?? "";
}

function uniqueNumberIds(values: number[]): number[] {
  return [...new Set(values)];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
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

function reasonFromError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown source adapter error.";
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

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "concept";
}
