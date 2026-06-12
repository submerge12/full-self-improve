import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createTraceRecorder } from "../engine/trace.js";
import { addConceptEdge, ConceptEdgeRejectedError, createConcept, listConceptEdges } from "./graph-store.js";
import { applyMigrations } from "./migrations.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

describe("graph-store", () => {
  it("creates concepts, inserts an edge, and lists edges", () => {
    const db = createTestDb();

    try {
      const algebra = createConcept(db, {
        slug: "algebra",
        name: "Algebra",
        summary: "Symbolic math",
        domain: "math",
        status: "reviewed"
      });
      const functions = createConcept(db, {
        slug: "functions",
        name: "Functions"
      });

      const edge = addConceptEdge(db, {
        fromConceptId: algebra.id,
        toConceptId: functions.id,
        kind: "prerequisite",
        weight: 0.75
      });

      expect(algebra).toMatchObject({
        id: expect.any(Number),
        slug: "algebra",
        name: "Algebra",
        summary: "Symbolic math",
        domain: "math",
        status: "reviewed"
      });
      expect(functions).toMatchObject({
        id: expect.any(Number),
        slug: "functions",
        name: "Functions",
        summary: null,
        domain: null,
        status: "stub"
      });
      expect(edge).toMatchObject({
        id: expect.any(Number),
        fromConceptId: algebra.id,
        toConceptId: functions.id,
        kind: "prerequisite",
        weight: 0.75
      });
      expect(listConceptEdges(db)).toEqual([edge]);
    } finally {
      db.close();
    }
  });

  it("surfaces a predictable duplicate edge error from the unique constraint", () => {
    const db = createTestDb();

    try {
      const from = createConcept(db, { slug: "from", name: "From" });
      const to = createConcept(db, { slug: "to", name: "To" });

      addConceptEdge(db, {
        fromConceptId: from.id,
        toConceptId: to.id,
        kind: "related"
      });

      expect(() =>
        addConceptEdge(db, {
          fromConceptId: from.id,
          toConceptId: to.id,
          kind: "related"
        })
      ).toThrow(/UNIQUE constraint failed: concept_edges/);
      expect(listConceptEdges(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("rejects self edges before inserting", () => {
    const db = createTestDb();

    try {
      const concept = createConcept(db, { slug: "self", name: "Self" });

      expect(() =>
        addConceptEdge(db, {
          fromConceptId: concept.id,
          toConceptId: concept.id,
          kind: "part_of"
        })
      ).toThrow(ConceptEdgeRejectedError);
      expect(listConceptEdges(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a directed cycle before inserting", () => {
    const db = createTestDb();

    try {
      const a = createConcept(db, { slug: "a", name: "A" });
      const b = createConcept(db, { slug: "b", name: "B" });

      addConceptEdge(db, {
        fromConceptId: a.id,
        toConceptId: b.id,
        kind: "prerequisite"
      });

      expect(() =>
        addConceptEdge(db, {
          fromConceptId: b.id,
          toConceptId: a.id,
          kind: "related"
        })
      ).toThrow(ConceptEdgeRejectedError);
      expect(listConceptEdges(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("rejects a transitive directed cycle before inserting", () => {
    const db = createTestDb();

    try {
      const a = createConcept(db, { slug: "transitive-a", name: "A" });
      const b = createConcept(db, { slug: "transitive-b", name: "B" });
      const c = createConcept(db, { slug: "transitive-c", name: "C" });

      addConceptEdge(db, {
        fromConceptId: a.id,
        toConceptId: b.id,
        kind: "prerequisite"
      });
      addConceptEdge(db, {
        fromConceptId: b.id,
        toConceptId: c.id,
        kind: "prerequisite"
      });

      expect(() =>
        addConceptEdge(db, {
          fromConceptId: c.id,
          toConceptId: a.id,
          kind: "related"
        })
      ).toThrow(ConceptEdgeRejectedError);
      expect(listConceptEdges(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("records link trace events for accepted and rejected edge attempts", () => {
    const db = createTestDb();

    try {
      const traceRecorder = createTraceRecorder();
      const runId = "run-graph-store-test";
      const a = createConcept(db, { slug: "trace-a", name: "Trace A" });
      const b = createConcept(db, { slug: "trace-b", name: "Trace B" });

      const edge = addConceptEdge(
        db,
        {
          fromConceptId: a.id,
          toConceptId: b.id,
          kind: "prerequisite"
        },
        { traceRecorder, runId }
      );

      expect(() =>
        addConceptEdge(
          db,
          {
            fromConceptId: b.id,
            toConceptId: a.id,
            kind: "related"
          },
          { traceRecorder, runId }
        )
      ).toThrow(ConceptEdgeRejectedError);

      const events = traceRecorder.getEvents({ runId, stage: "link" });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        stage: "link",
        level: "info",
        message: "Concept edge inserted",
        data: {
          outcome: "accepted",
          edgeId: edge.id,
          fromConceptId: a.id,
          toConceptId: b.id,
          kind: "prerequisite"
        }
      });
      expect(events[1]).toMatchObject({
        stage: "link",
        level: "error",
        message: "Concept edge rejected",
        data: {
          outcome: "rejected",
          reason: "cycle",
          fromConceptId: b.id,
          toConceptId: a.id,
          kind: "related"
        }
      });
    } finally {
      db.close();
    }
  });
});
