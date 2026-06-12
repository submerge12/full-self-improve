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

  test("reprocesses only the edited source while preflight-skipping unchanged sources", async () => {
    const adapter = createFixtureAdapter();
    await runPersistentMockIngest(db, adapter, { runId: "persistent-original" });

    adapter.setDocumentText("advanced.md", "# Advanced\nChanged advanced idea.");
    adapter.setDocumentFingerprintVersion("advanced.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-changed" });

    expect(summary).toMatchObject({
      runId: "persistent-changed",
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 0,
      pagesCreated: 1
    });
    expect(readSources()).toEqual([
      {
        adapterId: "fixture",
        docRef: "advanced.md",
        title: "Advanced",
        fingerprint: "v2:advanced.md:Advanced",
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

    const advancedChunks = readChunksForSource("advanced.md");
    expect(advancedChunks).toMatchObject([{ seq: 1, text: "Changed advanced idea." }]);
    expect(readChunksForSource("fundamentals.md")).toMatchObject([{ seq: 1, text: "Core idea." }]);

    const advancedPage = readPageForSlug("advanced");
    expect(advancedPage.markdown).toContain("Changed advanced idea.");
    expect(advancedPage.markdown).not.toContain("Advanced idea.");
    expect(advancedPage.citations).toEqual([advancedChunks[0]?.id]);
    expect(readConceptEdges()).toEqual([]);

    expect(
      summary.traceEvents
        .filter((event) => event.stage === "extract")
        .map((event) => traceDataSourceId(event.data))
    ).toEqual(["advanced.md"]);
    expect(
      summary.traceEvents
        .filter((event) => event.stage === "chunk" && traceDataOutcome(event.data) !== "skipped_unchanged")
        .map((event) => traceDataSourceId(event.data))
    ).toEqual(["advanced.md"]);
    expect(
      summary.traceEvents
        .filter((event) => event.stage === "chunk" && traceDataOutcome(event.data) === "skipped_unchanged")
        .map((event) => traceDataDocRef(event.data))
    ).toEqual(["fundamentals.md"]);
    expect(
      summary.traceEvents
        .filter((event) => event.stage === "page-gen")
        .map((event) => traceDataSlug(event.data))
    ).toEqual(["advanced"]);
  });

  test("rewrites prerequisite edges for a changed source", async () => {
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
    expect(readConceptEdges()).toEqual([]);

    adapter.setDocumentText("a.md", "# A\nPrerequisites: B. Changed A body.");
    adapter.setDocumentFingerprintVersion("a.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-changed-edge" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 0,
      pagesCreated: 1
    });
    expect(readConceptEdges()).toEqual([{ from: "b", to: "a", kind: "prerequisite", weight: 1 }]);

    adapter.setDocumentText("a.md", "# A\nChanged A body without prerequisites.");
    adapter.setDocumentFingerprintVersion("a.md", "v3");
    const removalSummary = await runPersistentMockIngest(db, adapter, { runId: "persistent-removed-edge" });

    expect(removalSummary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 0,
      pagesCreated: 1
    });
    expect(readConceptEdges()).toEqual([]);
  });

  test("removes stale concepts and edges when a changed source heading is renamed", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "base.md",
        title: "Base",
        text: "# Base\nBase body."
      },
      {
        id: "topic.md",
        title: "Topic",
        text: "# Old Topic\nPrerequisites: Base. Old body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-rename-original" });
    expect(readConceptSlugs()).toEqual(["base", "old-topic"]);
    expect(readConceptEdges()).toEqual([{ from: "base", to: "old-topic", kind: "prerequisite", weight: 1 }]);

    adapter.setDocumentText("topic.md", "# New Topic\nPrerequisites: Base. New body.");
    adapter.setDocumentFingerprintVersion("topic.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-renamed-heading" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 1,
      pagesCreated: 1
    });
    expect(readConceptSlugs()).toEqual(["base", "new-topic"]);
    expect(pageExistsForSlug("old-topic")).toBe(false);
    expect(pageExistsForSlug("new-topic")).toBe(true);
    expect(readConceptEdges()).toEqual([{ from: "base", to: "new-topic", kind: "prerequisite", weight: 1 }]);
  });

  test("removes stale concepts and edges when a changed source drops a heading", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "base.md",
        title: "Base",
        text: "# Base\nBase body."
      },
      {
        id: "topic.md",
        title: "Topic",
        text: "# Keep\nKeep body.\n## Removed\nPrerequisites: Base. Removed body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-multi-heading-original" });
    expect(readConceptSlugs()).toEqual(["base", "keep", "removed"]);
    expect(readConceptEdges()).toEqual([{ from: "base", to: "removed", kind: "prerequisite", weight: 1 }]);

    adapter.setDocumentText("topic.md", "# Keep\nChanged keep body.");
    adapter.setDocumentFingerprintVersion("topic.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-heading-removed" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 0,
      pagesCreated: 1
    });
    expect(readConceptSlugs()).toEqual(["base", "keep"]);
    expect(readPageForSlug("keep").markdown).toContain("Changed keep body.");
    expect(pageExistsForSlug("removed")).toBe(false);
    expect(readConceptEdges()).toEqual([]);
  });

  test("preserves valid related edges from unchanged sources when a linked concept is reprocessed", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "changed.md",
        title: "Changed",
        text: "# Changed\nOriginal changed body."
      },
      {
        id: "existing.md",
        title: "Existing",
        text: "# Existing\nExisting body.",
        links: ["Changed"]
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-related-original" });
    expect(readConceptEdges()).toEqual([{ from: "existing", to: "changed", kind: "related", weight: 0.5 }]);

    adapter.setDocumentText("changed.md", "# Changed\nChanged body.");
    adapter.setDocumentFingerprintVersion("changed.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-related-preserve" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 0,
      pagesCreated: 1
    });
    expect(readConceptEdges()).toEqual([{ from: "existing", to: "changed", kind: "related", weight: 0.5 }]);
  });

  test("restores related edges from a changed source to an existing skipped concept", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "source.md",
        title: "Source",
        text: "# Source\nOriginal source body."
      },
      {
        id: "target.md",
        title: "Target",
        text: "# Target\nTarget body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-link-original" });
    expect(readConceptEdges()).toEqual([]);

    adapter.setDocumentText("source.md", "# Source\nChanged source body.");
    adapter.setDocumentLinks("source.md", ["Target"]);
    adapter.setDocumentFingerprintVersion("source.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-link-restored" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 0,
      pagesCreated: 1
    });
    expect(readConceptEdges()).toEqual([{ from: "source", to: "target", kind: "related", weight: 0.5 }]);
  });

  test("does not add related edges from skipped unchanged sources to a newly processed concept", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "linker.md",
        title: "Linker",
        text: "# Linker\nExisting linker body.",
        links: ["New Concept"]
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-skipped-link-original" });

    adapter.addDocument({
      id: "new.md",
      title: "New",
      text: "# New Concept\nNew body."
    });
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-skipped-link-new" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 1,
      pagesCreated: 1
    });
    expect(readConceptEdges()).toEqual([]);
  });

  test("keeps unchanged same-slug contributions when one source is reprocessed", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "changed-shared.md",
        title: "Changed Shared",
        text: "# Shared\nOriginal changed shared body."
      },
      {
        id: "unchanged-shared.md",
        title: "Unchanged Shared",
        text: "# Shared\nUnchanged shared body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-same-slug-original" });
    expect(readPageForSlug("shared").citations).toHaveLength(2);

    adapter.setDocumentText("changed-shared.md", "# Shared\nChanged shared body.");
    adapter.setDocumentFingerprintVersion("changed-shared.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-same-slug-reprocess" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 1,
      sourcesSkipped: 1,
      chunksCreated: 1,
      conceptsCreated: 0,
      pagesCreated: 1
    });

    const page = readPageForSlug("shared");
    expect(page.citations).toHaveLength(2);
    expect(page.markdown).toContain("Changed shared body.");
    expect(page.markdown).toContain("Unchanged shared body.");
    expect(page.markdown).not.toContain("Original changed shared body.");
  });

  test("removes stale owned edges when a changed source stops contributing to a preserved same-slug concept", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "base.md",
        title: "Base",
        text: "# Base\nBase body."
      },
      {
        id: "changed-shared.md",
        title: "Changed Shared",
        text: "# Shared\nPrerequisites: Base. Original changed shared body."
      },
      {
        id: "unchanged-shared.md",
        title: "Unchanged Shared",
        text: "# Shared\nUnchanged shared body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-preserved-edge-original" });
    expect(readConceptEdges()).toEqual([{ from: "base", to: "shared", kind: "prerequisite", weight: 1 }]);

    adapter.setDocumentText("changed-shared.md", "# Other\nChanged source moved to another concept.");
    adapter.setDocumentFingerprintVersion("changed-shared.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-preserved-edge-moved" });

    expect(summary).toMatchObject({
      sourcesSeen: 3,
      sourcesProcessed: 1,
      sourcesSkipped: 2,
      chunksCreated: 1,
      conceptsCreated: 1,
      pagesCreated: 2
    });
    expect(readConceptSlugs()).toEqual(["base", "other", "shared"]);
    expect(readConceptEdges()).toEqual([]);
    expect(readPageForSlug("shared").markdown).toContain("Unchanged shared body.");
    expect(readPageForSlug("shared").markdown).not.toContain("Original changed shared body.");
    expect(readPageForSlug("other").markdown).toContain("Changed source moved to another concept.");
  });

  test("preserves prerequisite edges owned by an unchanged same-slug contribution", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "base.md",
        title: "Base",
        text: "# Base\nBase body."
      },
      {
        id: "changed-shared.md",
        title: "Changed Shared",
        text: "# Shared\nOriginal changed shared body."
      },
      {
        id: "unchanged-shared.md",
        title: "Unchanged Shared",
        text: "# Shared\nPrerequisites: Base. Unchanged shared body."
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-preserved-prereq-original" });
    expect(readConceptEdges()).toEqual([{ from: "base", to: "shared", kind: "prerequisite", weight: 1 }]);

    adapter.setDocumentText("changed-shared.md", "# Other\nChanged source moved to another concept.");
    adapter.setDocumentFingerprintVersion("changed-shared.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-preserved-prereq-moved" });

    expect(summary).toMatchObject({
      sourcesSeen: 3,
      sourcesProcessed: 1,
      sourcesSkipped: 2,
      chunksCreated: 1,
      conceptsCreated: 1,
      pagesCreated: 2
    });
    expect(readConceptEdges()).toEqual([{ from: "base", to: "shared", kind: "prerequisite", weight: 1 }]);
    expect(readConceptSummary("shared")).toBe("Shared: Prerequisites: Base.");
    expect(readConceptSummary("shared")).not.toContain("Original changed shared body.");
    expect(readPageForSlug("shared").markdown).toContain("Unchanged shared body.");
    expect(readPageForSlug("shared").markdown).not.toContain("Original changed shared body.");
  });

  test("preserves metadata prerequisite edges owned by an unchanged same-slug contribution", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "base.md",
        title: "Base",
        text: "# Base\nBase body."
      },
      {
        id: "changed-shared.md",
        title: "Changed Shared",
        text: "# Shared\nOriginal changed shared body."
      },
      {
        id: "unchanged-shared.md",
        title: "Unchanged Shared",
        text: "# Shared\nUnchanged shared body.",
        metadata: { prerequisites: ["Base"] }
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-preserved-metadata-prereq-original" });
    expect(readConceptEdges()).toEqual([{ from: "base", to: "shared", kind: "prerequisite", weight: 1 }]);

    adapter.setDocumentText("changed-shared.md", "# Other\nChanged source moved to another concept.");
    adapter.setDocumentFingerprintVersion("changed-shared.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-preserved-metadata-prereq-moved" });

    expect(summary).toMatchObject({
      sourcesSeen: 3,
      sourcesProcessed: 1,
      sourcesSkipped: 2,
      chunksCreated: 1,
      conceptsCreated: 1,
      pagesCreated: 2
    });
    expect(readConceptEdges()).toEqual([{ from: "base", to: "shared", kind: "prerequisite", weight: 1 }]);
    expect(readConceptSummary("shared")).toBe("Shared: Unchanged shared body.");
    expect(readPageForSlug("shared").markdown).toContain("Unchanged shared body.");
    expect(readPageForSlug("shared").markdown).not.toContain("Original changed shared body.");
  });

  test("preserves related edges owned by an unchanged same-slug contribution", async () => {
    const adapter = new FixtureSourceAdapter([
      {
        id: "target.md",
        title: "Target",
        text: "# Target\nTarget body."
      },
      {
        id: "changed-shared.md",
        title: "Changed Shared",
        text: "# Shared\nOriginal changed shared body."
      },
      {
        id: "unchanged-shared.md",
        title: "Unchanged Shared",
        text: "# Shared\nUnchanged shared body.",
        links: ["Target"]
      }
    ]);
    await runPersistentMockIngest(db, adapter, { runId: "persistent-preserved-related-original" });
    expect(readConceptEdges()).toEqual([{ from: "shared", to: "target", kind: "related", weight: 0.5 }]);

    adapter.setDocumentText("changed-shared.md", "# Other\nChanged source moved to another concept.");
    adapter.setDocumentFingerprintVersion("changed-shared.md", "v2");
    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-preserved-related-moved" });

    expect(summary).toMatchObject({
      sourcesSeen: 3,
      sourcesProcessed: 1,
      sourcesSkipped: 2,
      chunksCreated: 1,
      conceptsCreated: 1,
      pagesCreated: 2
    });
    expect(readConceptEdges()).toEqual([{ from: "shared", to: "target", kind: "related", weight: 0.5 }]);
    expect(readPageForSlug("shared").markdown).toContain("Unchanged shared body.");
    expect(readPageForSlug("shared").markdown).not.toContain("Original changed shared body.");
  });

  test("merges changed and new same-slug sources while rebuilding edges to skipped concepts", async () => {
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
      sourcesProcessed: 2,
      sourcesSkipped: 1,
      chunksCreated: 2,
      conceptsCreated: 0,
      pagesCreated: 1
    });
    expect(readPageForSlug("shared").markdown).toContain("Changed shared body.");
    expect(readPageForSlug("shared").markdown).toContain("New shared body.");
    expect(readConceptEdges()).toEqual([
      { from: "existing-prereq", to: "shared", kind: "prerequisite", weight: 1 }
    ]);
  });

  test("skips an identical third run after a changed-source reprocess", async () => {
    const adapter = createFixtureAdapter();
    await runPersistentMockIngest(db, adapter, { runId: "persistent-first" });
    adapter.setDocumentText("advanced.md", "# Advanced\nChanged advanced idea.");
    adapter.setDocumentFingerprintVersion("advanced.md", "v2");
    await runPersistentMockIngest(db, adapter, { runId: "persistent-changed" });
    const before = readTableCounts();

    const summary = await runPersistentMockIngest(db, adapter, { runId: "persistent-third" });

    expect(summary).toMatchObject({
      sourcesSeen: 2,
      sourcesProcessed: 0,
      sourcesSkipped: 2,
      chunksCreated: 0,
      conceptsCreated: 0,
      pagesCreated: 0
    });
    expect(readTableCounts()).toEqual(before);
    expect(summary.traceEvents.filter((event) => event.stage === "extract")).toEqual([]);
    expect(summary.traceEvents.filter((event) => event.stage === "page-gen")).toEqual([]);
    expect(
      summary.traceEvents.filter(
        (event) => event.stage === "chunk" && traceDataOutcome(event.data) === "skipped_unchanged"
      )
    ).toHaveLength(2);
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

  function readChunksForSource(docRef: string): Array<{ id: number; seq: number; text: string }> {
    return db
      .prepare(
        `SELECT chunks.id, chunks.seq, chunks.text
         FROM chunks
         INNER JOIN sources ON sources.id = chunks.source_id
         WHERE sources.doc_ref = ?
         ORDER BY chunks.seq`
      )
      .all(docRef) as Array<{ id: number; seq: number; text: string }>;
  }

  function readPageForSlug(slug: string): { markdown: string; citations: number[] } {
    const row = db
      .prepare(
        `SELECT pages.markdown, pages.citations
         FROM pages
         INNER JOIN concepts ON concepts.id = pages.concept_id
         WHERE concepts.slug = ? AND pages.version = 1`
      )
      .get(slug) as { markdown: string; citations: string } | undefined;

    if (row === undefined) {
      throw new Error(`Missing page for slug: ${slug}`);
    }

    return {
      markdown: row.markdown,
      citations: JSON.parse(row.citations) as number[]
    };
  }

  function pageExistsForSlug(slug: string): boolean {
    return db
      .prepare(
        `SELECT 1
         FROM pages
         INNER JOIN concepts ON concepts.id = pages.concept_id
         WHERE concepts.slug = ? AND pages.version = 1`
      )
      .get(slug) !== undefined;
  }

  function readConceptSlugs(): string[] {
    const rows = db
      .prepare(
        `SELECT slug
         FROM concepts
         ORDER BY slug`
      )
      .all() as Array<{ slug: string }>;

    return rows.map((row) => row.slug);
  }

  function readConceptSummary(slug: string): string {
    const row = db
      .prepare(
        `SELECT summary
         FROM concepts
         WHERE slug = ?`
      )
      .get(slug) as { summary: string } | undefined;

    if (row === undefined) {
      throw new Error(`Missing concept for slug: ${slug}`);
    }

    return row.summary;
  }

  function readConceptEdges(): Array<{ from: string; to: string; kind: string; weight: number }> {
    return db
      .prepare(
        `SELECT
           from_concept.slug AS "from",
           to_concept.slug AS "to",
           concept_edges.kind,
           concept_edges.weight
         FROM concept_edges
         INNER JOIN concepts AS from_concept ON from_concept.id = concept_edges.from_concept_id
         INNER JOIN concepts AS to_concept ON to_concept.id = concept_edges.to_concept_id
         ORDER BY from_concept.slug, to_concept.slug, concept_edges.kind`
      )
      .all() as Array<{ from: string; to: string; kind: string; weight: number }>;
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

function traceDataSlug(data: unknown): string | undefined {
  return typeof data === "object" && data !== null && "slug" in data
    ? String((data as { slug: unknown }).slug)
    : undefined;
}
