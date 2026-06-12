import { describe, expect, test } from "vitest";

import type { DocRef, RawDoc, SourceAdapter } from "./source-adapter.js";

interface SourceAdapterExpectedDocument {
  id: string;
  kind: string;
  textIncludes: string;
  metadata?: Record<string, unknown>;
  link?: string;
  mediaRef?: string;
}

interface SourceAdapterConformanceSetup {
  adapter: SourceAdapter;
  expectedDocumentCount: number;
  expectedDocument: SourceAdapterExpectedDocument;
  mutateDocument: (ref: DocRef, doc: RawDoc) => Promise<void> | void;
}

export function runSourceAdapterConformanceTests(
  adapterName: string,
  setupFixture: () => Promise<SourceAdapterConformanceSetup> | SourceAdapterConformanceSetup
): void {
  describe(`${adapterName} source adapter conformance`, () => {
    test("lists, reads, and fingerprints fixture documents", async () => {
      const setup = await setupFixture();
      const refs = await collectAsync(setup.adapter.listDocuments());
      const ref = refs.find((candidate) => candidate.id === setup.expectedDocument.id);

      expect(refs).toHaveLength(setup.expectedDocumentCount);
      expect(ref).toBeDefined();
      expect(ref?.kind).toBe(setup.expectedDocument.kind);

      const doc = await setup.adapter.readDocument(ref as DocRef);
      expect(doc.ref.id).toBe(setup.expectedDocument.id);
      expect(doc.ref.kind).toBe(setup.expectedDocument.kind);
      expect(doc.text).toContain(setup.expectedDocument.textIncludes);

      for (const [key, value] of Object.entries(setup.expectedDocument.metadata ?? {})) {
        expect(doc.metadata[key]).toEqual(value);
      }

      if (setup.expectedDocument.link) {
        expect(doc.links).toContain(setup.expectedDocument.link);
      }

      if (setup.expectedDocument.mediaRef) {
        expect(doc.mediaRefs).toContain(setup.expectedDocument.mediaRef);
      }

      const firstFingerprint = setup.adapter.fingerprint(ref as DocRef);
      const secondFingerprint = setup.adapter.fingerprint(ref as DocRef);
      expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(secondFingerprint).toBe(firstFingerprint);
    });

    test("changes the fingerprint when fixture content changes", async () => {
      const setup = await setupFixture();
      const refs = await collectAsync(setup.adapter.listDocuments());
      const ref = refs.find((candidate) => candidate.id === setup.expectedDocument.id);

      expect(ref).toBeDefined();

      const doc = await setup.adapter.readDocument(ref as DocRef);
      const before = setup.adapter.fingerprint(ref as DocRef);
      await setup.mutateDocument(ref as DocRef, doc);
      const after = setup.adapter.fingerprint(ref as DocRef);

      expect(after).toMatch(/^[a-f0-9]{64}$/);
      expect(after).not.toBe(before);
    });
  });
}

describe("runSourceAdapterConformanceTests", () => {
  runSourceAdapterConformanceTests("memory adapter", () => {
    const adapter = new MemorySourceAdapter();

    return {
      adapter,
      expectedDocumentCount: 1,
      expectedDocument: {
        id: "memory-note",
        kind: "memory",
        textIncludes: "seed note",
        metadata: { title: "Memory Note" },
        link: "Related",
        mediaRef: "asset.png"
      },
      mutateDocument: () => {
        adapter.updateText("seed note updated");
      }
    };
  });
});

class MemorySourceAdapter implements SourceAdapter {
  readonly id = "memory-fixture";
  readonly kind = "memory";

  private readonly ref: DocRef = {
    adapterId: this.id,
    id: "memory-note",
    kind: this.kind,
    path: "memory-note.md",
    title: "Memory Note"
  };

  private text = "seed note";

  async *listDocuments(): AsyncIterable<DocRef> {
    yield this.ref;
  }

  async readDocument(ref: DocRef): Promise<RawDoc> {
    expect(ref.id).toBe(this.ref.id);

    return {
      ref,
      text: this.text,
      links: ["Related"],
      mediaRefs: ["asset.png"],
      metadata: { title: "Memory Note" }
    };
  }

  fingerprint(ref: DocRef): string {
    expect(ref.id).toBe(this.ref.id);

    return simpleFingerprint(`${ref.path}\0${this.text}`);
  }

  updateText(text: string): void {
    this.text = text;
  }
}

function simpleFingerprint(value: string): string {
  let hash = 0;

  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash.toString(16).padStart(64, "0");
}

async function collectAsync<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const item of items) {
    collected.push(item);
  }

  return collected;
}
