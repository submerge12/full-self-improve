import { describe, expect, it } from "vitest";

import {
  TRACE_STAGES,
  createRunId,
  createTraceRecorder,
  recordTraceEvent,
  type TraceEvent
} from "./trace.js";

describe("trace primitives", () => {
  it("defines the pipeline stages required by PLAN 2.4", () => {
    expect(TRACE_STAGES).toEqual([
      "chunk",
      "extract",
      "merge",
      "link",
      "page-gen",
      "plan",
      "grade",
      "diagnose"
    ]);
  });

  it("creates distinct run ids with an optional readable prefix", () => {
    const first = createRunId("ingest");
    const second = createRunId("ingest");

    expect(first).toMatch(/^ingest-[a-z0-9]+$/);
    expect(second).toMatch(/^ingest-[a-z0-9]+$/);
    expect(second).not.toBe(first);
  });

  it("records a typed event with an injected timestamp", () => {
    const now = () => new Date("2026-06-12T08:00:00.000Z");

    expect(
      recordTraceEvent(
        {
          runId: "run-1",
          stage: "chunk",
          level: "info",
          message: "chunked source document",
          data: { chunks: 3 }
        },
        { now }
      )
    ).toEqual({
      runId: "run-1",
      stage: "chunk",
      level: "info",
      message: "chunked source document",
      timestamp: "2026-06-12T08:00:00.000Z",
      data: { chunks: 3 }
    });
  });

  it("queries recorded events by run id and optional stage in insertion order", () => {
    const timestamps = [
      new Date("2026-06-12T08:00:00.000Z"),
      new Date("2026-06-12T08:01:00.000Z"),
      new Date("2026-06-12T08:02:00.000Z")
    ];
    const recorder = createTraceRecorder({
      now: () => timestamps.shift() ?? new Date("2026-06-12T08:03:00.000Z")
    });

    recorder.record({
      runId: "run-a",
      stage: "chunk",
      level: "info",
      message: "first"
    });
    recorder.record({
      runId: "run-b",
      stage: "plan",
      level: "warn",
      message: "other run"
    });
    recorder.record({
      runId: "run-a",
      stage: "merge",
      level: "error",
      message: "second"
    });

    expect(recorder.getEvents({ runId: "run-a" }).map((event) => event.message)).toEqual([
      "first",
      "second"
    ]);
    expect(recorder.getEvents({ runId: "run-a", stage: "merge" })).toEqual([
      {
        runId: "run-a",
        stage: "merge",
        level: "error",
        message: "second",
        timestamp: "2026-06-12T08:02:00.000Z"
      }
    ]);
  });

  it("returns event copies so callers cannot mutate recorder state", () => {
    const recorder = createTraceRecorder({
      now: () => new Date("2026-06-12T08:00:00.000Z")
    });

    recorder.record({
      runId: "run-a",
      stage: "extract",
      level: "info",
      message: "extracted candidates",
      data: { candidates: 2, source: { title: "Algebra" } }
    });

    const events = recorder.getEvents({ runId: "run-a" });
    const mutableEvents = events as unknown as Array<
      Omit<TraceEvent, "data"> & {
        data: { candidates: number; source: { title: string } };
      }
    >;
    mutableEvents[0].message = "changed outside";
    mutableEvents[0].data.candidates = 99;
    mutableEvents[0].data.source.title = "Changed";

    expect(recorder.getEvents({ runId: "run-a" })).toEqual([
      {
        runId: "run-a",
        stage: "extract",
        level: "info",
        message: "extracted candidates",
        timestamp: "2026-06-12T08:00:00.000Z",
        data: { candidates: 2, source: { title: "Algebra" } }
      }
    ]);
  });
});
