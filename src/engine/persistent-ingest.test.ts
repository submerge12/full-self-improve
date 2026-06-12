import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listPublicPages } from "../db/content-store.js";
import { applyMigrations } from "../db/migrations.js";
import type { DocRef, RawDoc, SourceAdapter } from "./source-adapter.js";
import { runPersistentMockIngest } from "./persistent-ingest.js";

interface FixtureDoc {
  id: string;
  title: string;
  text: string;
  links?: string[];
  metadata?: Record<string, unknown>;
}

interface TableCounts {
  sources: number;
  chunks: number;
  concepts: number;
  conceptEdges: number;
  pages: number;
}

class FixtureSourceAdapter implements SourceAdapter {
  readonly id = "fixture";
  readonly kind = "fixture";
  private fingerprintVersion = "v1";

  constructor(private readonly docs: FixtureDoc[]) {}

  setFingerprintVersion(version: string): void {
    this.fingerprintVersion = version;
  }

  setDocumentFingerprintVersion(docId: string, version: string): void {
    const doc = this.docs.find((candidate) => candidate.id === docId);
    if (doc === undefined) {
      throw new Error(`Missing fixture doc: ${docId}`);
    }

    doc.metadata = {
      ...doc.metadata,
      fingerprintVersion: version
    };
  }

  setDocumentText(docId: string, text: string): void {
    const doc = this.docs.find((candidate) => candidate.id === docId);
    if (doc === undefined) {
      throw new Error(`Missing fixture doc: ${docId}`);
    }

    doc.text = text;
  }

  setDocumentLinks(docId: string, links: string[]): void {
    const doc = this.docs.find((candidate) => candidate.id === docId);
    if (doc === undefined) {
      throw new Error(`Missing fixture doc: ${docId}`);
    }

    doc.links = links;
  }

  addDocument(doc: FixtureDoc): void {
    this.docs.push(doc);
  }

  async *listDocuments(): AsyncIterable<DocRef> {
    for (const doc of [...this.docs].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
      yield this.toRef(doc);
    }
  }

  async readDocument(ref: DocRef): Promise<RawDoc> {
    const doc = this.docs.find((candidate) => candidate.id === ref.id);
    if (doc === undefined) {
      throw new Error(`Missing fixture doc: ${ref.id}`);
    }

    return {
      ref: this.toRef(doc),
      text: doc.text,
      links: doc.links ?? [],
      mediaRefs: [],
      metadata: doc.metadata ?? {}
    };
  }

  fingerprint(ref: DocRef): string {
    const doc = this.docs.find((candidate) => candidate.id === ref.id);
    const version = typeof doc?.metadata?.fingerprintVersion === "string"
      ? doc.metadata.fingerprintVersion
      : this.fingerprintVersion;

    return `${version}:${ref.id}:${ref.title}`;
  }

  private toRef(doc: FixtureDoc): DocRef {
    return {
      adapterId: this.id,
      id: doc.id,
      kind: this.kind,
      path: doc.id,
      title: doc.title
    };
  }
}

describe("persistent mock ingest", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("persists first mock ingest output with numeric private page citations", async () => {
    const adapter = createFixtureAdapter();

    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-first" });

    expect(summary).toMatchObject({
      runId: "persistent-first",
      sourcesSeen: 2,
      sourcesProcessed: 2,
      sourcesSkipped: 0,
      chunksCreated: 2,
      conceptsCreated: 2,
      pagesCreated: 2
    });
    expect(readTableCounts()).toEqual({
      sources: 2,
      chunks: 2,
      concepts: 2,
      conceptEdges: 1,
      pages: 2
    });
    expect(readSources()).toEqual([
      {
        adapterId: "fixture",
        docRef: "advanced.md",
        title: "Advanced",
        fingerprint: "v1:advanced.md:Advanced",
        status: "ingested"
      },
      {
        adapterId: "fixture",
        docRef: "fundamentals.md",
        title: "Fundamentals",
        fingerprint: "v1:fundamentals.md:Fundamentals",
        status: "ingested"
      }
    ]);

    for (const page of readPages()) {
      expect(page.visibility).toBe("private");
      expect(page.citations.length).toBeGreaterThan(0);
      for (const citationId of page.citations) {
        expect(Number.isSafeInteger(citationId)).toBe(true);
        expect(chunkExists(citationId)).toBe(true);
      }
    }

    db.prepare("UPDATE pages SET visibility = 'public'").run();
    expect(listPublicPages(db)).toHaveLength(2);
  });

  test("skips identical source fingerprints on a second run without changing row counts", async () => {
    const adapter = createFixtureAdapter();
    await runPersistentMockIngest(db, adapter, { runId: "persistent-first" });
    const before = readTableCounts();

    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-second" });

    expect(summary).toMatchObject({
      runId: "persistent-second",
      sourcesSeen: 2,
      sourcesProcessed: 0,
      sourcesSkipped: 2,
      chunksCreated: 0,
      conceptsCreated: 0,
      pagesCreated: 0
    });
    expect(readTableCounts()).toEqual(before);

    const skipEvents = summary.traceEvents.filter(
      (event) => event.stage === "chunk" && traceDataOutcome(event.data) === "skipped_unchanged"
    );
    expect(skipEvents).toHaveLength(2);
    expect(skipEvents.map((event) => traceDataDocRef(event.data))).toEqual(["advanced.md", "fundamentals.md"]);
  });

  test("preflights unchanged sources before the mock pipeline on a second run", async () => {
    const adapter = createFixtureAdapter();
    await runPersistentMockIngest(db, adapter, { runId: "persistent-first" });

    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-second" });

    expect(summary).toMatchObject({
      runId: "persistent-second",
      sourcesSeen: 2,
      sourcesProcessed: 0,
      sourcesSkipped: 2,
      chunksCreated: 0,
      conceptsCreated: 0,
      pagesCreated: 0
    });
    expect(summary.traceEvents.filter((event) => event.stage === "extract")).toEqual([]);
    expect(summary.traceEvents.filter((event) => event.stage === "page-gen")).toEqual([]);
    expect(
      summary.traceEvents.filter(
        (event) => event.stage === "chunk" && traceDataOutcome(event.data) !== "skipped_unchanged"
      )
    ).toEqual([]);
    expect(
      summary.traceEvents.filter(
        (event) => event.stage === "chunk" && traceDataOutcome(event.data) === "skipped_unchanged"
      )
    ).toHaveLength(2);
  });

  test("preflights unchanged sources while processing a newly added source", async () => {
    const adapter = createFixtureAdapter();
    await runPersistentMockIngest(db, adapter, { runId: "persistent-first" });
    adapter.addDocument({
      id: "fresh.md",
      title: "Fresh",
      text: "# Fresh\nFresh idea."
    });

    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-mixed" });

    expect(summary).toMatchObject({
      runId: "persistent-mixed",
      sourcesSeen: 3,
      sourcesProcessed: 1,
      sourcesSkipped: 2,
      chunksCreated: 1,
      conceptsCreated: 1,
      pagesCreated: 1
    });
    expect(
      summary.traceEvents
        .filter((event) => event.stage === "extract")
        .map((event) => traceDataSourceId(event.data))
    ).toEqual(["fresh.md"]);
    expect(
      summary.traceEvents
        .filter((event) => event.stage === "chunk" && traceDataOutcome(event.data) !== "skipped_unchanged")
        .map((event) => traceDataSourceId(event.data))
    ).toEqual(["fresh.md"]);
    expect(
      summary.traceEvents
        .filter((event) => event.stage === "chunk" && traceDataOutcome(event.data) === "skipped_unchanged")
        .map((event) => traceDataDocRef(event.data))
    ).toEqual(["advanced.md", "fundamentals.md"]);
  });

  test("skips changed source fingerprints safely without overwriting existing rows", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "change.md",
        title: "Change",
        text: "# Change\nOriginal body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-original" });
    const before = readTableCounts();

    adapter.setFingerprintVersion("v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-changed" });

    expect(summary).toMatchObject({
      runId: "persistent-changed",
      sourcesSeen: 1,
      sourcesProcessed: 0,
      sourcesSkipped: 1,
      chunksCreated: 0,
      conceptsCreated: 0,
      pagesCreated: 0
    });
    expect(readTableCounts()).toEqual(before);
    expect(readSources()[0]?.fingerprint).toBe("v1:change.md:Change");

    const warningEvents = summary.traceEvents.filter(
      (event) => event.stage === "merge" && traceDataOutcome(event.data) === "skipped_changed_fingerprint"
    );
    expect(warningEvents).toMatchObject([
      {
        level: "warn",
        data: {
          adapterId: "fixture",
          docRef: "change.md",
          existingFingerprint: "v1:change.md:Change",
          incomingFingerprint: "v2:change.md:Change"
        }
      }
    ]);
  });

  test("does not insert edges when changed fingerprints introduce new links between existing concepts", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "a.md",
        title: "A",
        text: "# A\nOriginal A body."
      },
      {
        id: "b.md",
        title: "B",
        text: "# B\nOriginal B body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-no-edge" });
    const before = readTableCounts();

    expect(before).toMatchObject({
      sources: 2,
      chunks: 2,
      concepts: 2,
      conceptEdges: 0,
      pages: 2
    });

    adapter.setDocumentText("a.md", "# A\nPrerequisites: B. Changed A body.");
    adapter.setDocumentFingerprintVersion("a.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-changed-edge" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 0,
      sourcesSkipped: 2,
      chunksCreated: 0,
      conceptsCreated: 0,
      pagesCreated: 0
    });
    expect(readTableCounts()).toEqual(before);
  });

  test("does not insert edges when changed and new sources merge into the same concept slug", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "prereq.md",
        title: "Prereq",
        text: "# Existing Prereq\nExisting prerequisite body."
      },
      {
        id: "changed.md",
        title: "Changed",
        text: "# Shared\nOriginal shared body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-shared-original" });
    const before = readTableCounts();

    adapter.setDocumentText("changed.md", "# Shared\nPrerequisites: Existing Prereq. Changed shared body.");
    adapter.setDocumentFingerprintVersion("changed.md", "v2");
    adapter.addDocument({
      id: "new-shared.md",
      title: "New Shared",
      text: "# Shared\nNew shared body."
    });

    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-shared-merged" });

    expect(summary).toMatchObject({
      sourcesSeen: 3,
      sourcesProcessed: 1,
      sourcesSkipped: 2,
      chunksCreated: 1,
      conceptsCreated: 0,
      pagesCreated: 0
    });
    expect(readTableCounts()).toEqual({
      ...before,
      sources: before.sources + 1,
      chunks: before.chunks + 1,
      conceptEdges: before.conceptEdges
    });
  });

  test("does not persist changed-source related edges that point at a newly processed concept", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "changed.md",
        title: "Changed",
        text: "# Changed\nOriginal changed body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-related-original" });
    const before = readTableCounts();

    adapter.setDocumentText("changed.md", "# Changed\nChanged body links to [[New Concept]].");
    adapter.setDocumentLinks("changed.md", ["New Concept"]);
    adapter.setDocumentFingerprintVersion("changed.md", "v2");
    adapter.addDocument({
      id: "new.md",
      title: "New",
      text: "# New Concept\nNew concept body."
    });

    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-related-mixed" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 1,
      pagesCreated: 1
    });
    expect(readTableCounts()).toEqual({
      ...before,
      sources: before.sources + 1,
      chunks: before.chunks + 1,
      concepts: before.concepts + 1,
      conceptEdges: before.conceptEdges,
      pages: before.pages + 1
    });
  });

  test("uses deterministic timestamps for fallback persistent skip traces", async () => {
    const adapter = createFixtureAdapter();
    await runPersistentMockIngest(db, adapter, { runId: "persistent-first" });

    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-deterministic-trace" });

    const skipEvents = summary.traceEvents.filter(
      (event) => event.stage === "chunk" && traceDataOutcome(event.data) === "skipped_unchanged"
    );
    expect(skipEvents.map((event) => event.timestamp)).toEqual([
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z"
    ]);
  });

  function readTableCounts(): TableCounts {
    return {
      sources: countRows("sources"),
      chunks: countRows("chunks"),
      concepts: countRows("concepts"),
      conceptEdges: countRows("concept_edges"),
      pages: countRows("pages")
    };
  }

  function countRows(tableName: "sources" | "chunks" | "concepts" | "concept_edges" | "pages"): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
  }

  function readSources(): Array<{
    adapterId: string;
    docRef: string;
    title: string;
    fingerprint: string;
    status: string;
  }> {
    return db
      .prepare(
        `SELECT
           adapter_id AS adapterId,
           doc_ref AS docRef,
           title,
           fingerprint,
           status
         FROM sources
         ORDER BY doc_ref`
      )
      .all() as Array<{
      adapterId: string;
      docRef: string;
      title: string;
      fingerprint: string;
      status: string;
    }>;
  }

  function readPages(): Array<{ visibility: string; citations: number[] }> {
    const rows = db
      .prepare(
        `SELECT visibility, citations
         FROM pages
         ORDER BY id`
      )
      .all() as Array<{ visibility: string; citations: string }>;

    return rows.map((row) => ({
      visibility: row.visibility,
      citations: JSON.parse(row.citations) as number[]
    }));
  }

  function chunkExists(chunkId: number): boolean {
    return db.prepare("SELECT 1 FROM chunks WHERE id = ?").get(chunkId) !== undefined;
  }
});

function createFixtureAdapter(): FixtureSourceAdapter {
  return new FixtureSourceAdapter([
    {
      id: "fundamentals.md",
      title: "Fundamentals",
      text: "# Fundamentals\nCore idea."
    },
    {
      id: "advanced.md",
      title: "Advanced",
      text: "# Advanced\nPrerequisites: Fundamentals. Advanced idea."
    }
  ]);
}

function traceDataOutcome(data: unknown): string | undefined {
  return typeof data === "object" && data !== null && "outcome" in data
    ? String((data as { outcome: unknown }).outcome)
    : undefined;
}

function traceDataDocRef(data: unknown): string | undefined {
  return typeof data === "object" && data !== null && "docRef" in data
    ? String((data as { docRef: unknown }).docRef)
    : undefined;
}

function traceDataSourceId(data: unknown): string | undefined {
  return typeof data === "object" && data !== null && "sourceId" in data
    ? String((data as { sourceId: unknown }).sourceId)
    : undefined;
}
