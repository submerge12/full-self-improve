import { describe, expect, it } from "vitest";

import type { DocRef, RawDoc, SourceAdapter } from "./source-adapter.js";
import { createTraceRecorder } from "./trace.js";
import { createDailyPlan, gradeQuizAttempt, runMockIngest } from "./mock-commands.js";

interface MemoryDoc {
  id: string;
  title: string;
  text: string;
  links?: string[];
  metadata?: Record<string, unknown>;
}

class MemorySourceAdapter implements SourceAdapter {
  readonly id = "memory";
  readonly kind = "memory";

  constructor(private readonly docs: MemoryDoc[]) {}

  async *listDocuments(): AsyncIterable<DocRef> {
    for (const doc of [...this.docs].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
      yield this.toRef(doc);
    }
  }

  async readDocument(ref: DocRef): Promise<RawDoc> {
    const doc = this.docs.find((candidate) => candidate.id === ref.id);
    if (doc === undefined) {
      throw new Error(`Missing memory doc: ${ref.id}`);
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
    return `memory:${ref.id}:${ref.title}`;
  }

  private toRef(doc: MemoryDoc): DocRef {
    return {
      adapterId: this.id,
      id: doc.id,
      kind: this.kind,
      path: doc.id,
      title: doc.title
    };
  }
}

describe("mock engine commands", () => {
  it("ingests headings from a memory adapter into concepts and cited pages", async () => {
    const result = await runMockIngest(
      new MemorySourceAdapter([
        {
          id: "alpha.md",
          title: "Alpha",
          text: "# Alpha Basics\nAlpha body.\n\n## Beta Details\nBeta body."
        }
      ]),
      { runId: "mock-ingest-test" }
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      id: "alpha.md",
      title: "Alpha",
      fingerprint: "memory:alpha.md:Alpha"
    });
    expect(result.chunks.map((chunk) => chunk.heading)).toEqual(["Alpha Basics", "Beta Details"]);
    expect(result.concepts.map((concept) => concept.slug)).toEqual(["alpha-basics", "beta-details"]);
    expect(result.pages.map((page) => page.slug)).toEqual(["alpha-basics", "beta-details"]);
    expect(result.pages[0]).toMatchObject({
      title: "Alpha Basics",
      citations: [result.chunks[0].id],
      visibility: "private"
    });
  });

  it("returns cloned source metadata from mock ingest", async () => {
    const metadata = { title: "Alpha", nested: { tag: "seed" } };
    const result = await runMockIngest(
      new MemorySourceAdapter([
        {
          id: "alpha.md",
          title: "Alpha",
          text: "# Alpha Basics\nAlpha body.",
          metadata
        }
      ])
    );

    const mutableMetadata = result.sources[0].metadata as { nested: { tag: string } };
    mutableMetadata.nested.tag = "changed";

    expect(metadata.nested.tag).toBe("seed");
  });

  it("emits queryable trace events for each mock ingest stage", async () => {
    const runId = "trace-run";
    const trace = createTraceRecorder({ now: () => new Date("2026-06-12T00:00:00.000Z") });

    await runMockIngest(
      new MemorySourceAdapter([
        {
          id: "trace.md",
          title: "Trace",
          text: "# Trace Concept\nTrace body."
        }
      ]),
      { runId, trace }
    );

    for (const stage of ["chunk", "extract", "merge", "link", "page-gen"] as const) {
      expect(trace.getEvents({ runId, stage }).length, stage).toBeGreaterThan(0);
    }
    expect(trace.getEvents({ runId, stage: "chunk" })[0].data).toMatchObject({
      sourceId: "trace.md",
      heading: "Trace Concept"
    });
  });

  it("creates a deterministic daily plan that keeps prerequisites first", () => {
    const concepts = [
      {
        slug: "advanced",
        name: "Advanced",
        summary: "Prerequisites: fundamentals"
      },
      {
        slug: "fundamentals",
        name: "Fundamentals",
        summary: "Starter concept"
      },
      {
        slug: "practice",
        name: "Practice",
        summary: "Standalone concept"
      }
    ];

    const first = createDailyPlan({
      concepts,
      date: "2026-06-12",
      edges: [{ from: "fundamentals", to: "advanced", kind: "prerequisite" }],
      runId: "plan-test"
    });
    const second = createDailyPlan({
      concepts,
      date: "2026-06-12",
      edges: [{ from: "fundamentals", to: "advanced", kind: "prerequisite" }],
      runId: "plan-test"
    });

    expect(second.queue).toEqual(first.queue);
    expect(first.queue.map((activity) => activity.type)).toEqual([
      "learn",
      "quiz",
      "teachback",
      "learn",
      "quiz",
      "teachback",
      "learn",
      "quiz",
      "teachback"
    ]);

    const firstLearnIndexByConcept = new Map(
      first.queue
        .filter((activity) => activity.type === "learn")
        .map((activity, index) => [activity.conceptSlug, index])
    );

    expect(firstLearnIndexByConcept.get("fundamentals")).toBeLessThan(
      firstLearnIndexByConcept.get("advanced") ?? Number.POSITIVE_INFINITY
    );
  });

  it("rejects invalid calendar dates for daily plans", () => {
    expect(() =>
      createDailyPlan({
        concepts: [{ slug: "alpha", name: "Alpha" }],
        date: "2026-02-31"
      })
    ).toThrow(/Invalid plan date/);
  });

  it("grades exact-match quiz attempts and records grade trace events", () => {
    const runId = "grade-test";
    const trace = createTraceRecorder({ now: () => new Date("2026-06-12T00:00:00.000Z") });
    const item = {
      id: "q1",
      conceptSlug: "alpha-basics",
      prompt: "Which organelle is the powerhouse of the cell?",
      answerSpec: {
        type: "exact" as const,
        answers: ["mitochondria"]
      }
    };

    const correct = gradeQuizAttempt({ item, response: "mitochondria", runId, trace });
    const incorrect = gradeQuizAttempt({ item, response: "chloroplast", runId: "grade-test-2" });

    expect(correct).toMatchObject({
      itemId: "q1",
      conceptSlug: "alpha-basics",
      verdict: "correct",
      masteryDelta: 0.1,
      gradingMethod: "exact"
    });
    expect(incorrect).toMatchObject({
      verdict: "incorrect",
      masteryDelta: -0.05
    });
    expect(trace.getEvents({ runId, stage: "grade" })).toHaveLength(1);
  });

  it("rejects blank exact-match quiz answers", () => {
    expect(() =>
      gradeQuizAttempt({
        item: {
          id: "blank-answer",
          conceptSlug: "quiz-validation",
          answer: ""
        },
        response: ""
      })
    ).toThrow(/non-empty answer/);
    expect(() =>
      gradeQuizAttempt({
        item: {
          id: "blank-answer-spec",
          conceptSlug: "quiz-validation",
          answerSpec: {
            type: "exact",
            answers: ["   "]
          }
        },
        response: ""
      })
    ).toThrow(/non-empty answer/);
  });
});
