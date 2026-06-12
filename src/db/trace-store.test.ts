import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { TraceEvent } from "../engine/trace.js";
import { applyMigrations } from "./migrations.js";
import {
  TraceStoreValidationError,
  listTraceEvents,
  persistTraceEvent,
  persistTraceEvents
} from "./trace-store.js";

describe("trace store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("persists and lists trace events by run id and optional stage in insertion order", () => {
    const first = persistTraceEvent(db, traceEvent({ runId: "run-a", stage: "chunk", message: "first" }));
    persistTraceEvent(db, traceEvent({ runId: "run-b", stage: "extract", level: "warn", message: "other run" }));
    const second = persistTraceEvent(db, traceEvent({ runId: "run-a", stage: "plan", level: "error", message: "second" }));

    expect(listTraceEvents(db, { runId: "run-a" })).toEqual([first, second]);
    expect(listTraceEvents(db, { runId: "run-a", stage: "chunk" })).toEqual([first]);
    expect(first.id).toBeLessThan(second.id);
  });

  test("round-trips object, array, and missing trace data with defensive copies", () => {
    persistTraceEvents(db, [
      traceEvent({ message: "object data", data: { chunks: 2, nested: { title: "Algebra" } } }),
      traceEvent({ message: "array data", data: ["chunk-1", { score: 0.75 }] }),
      traceEvent({ message: "missing data" })
    ]);

    const events = listTraceEvents(db, { runId: "run-a" });

    expect(events.map((event) => event.data)).toEqual([
      { chunks: 2, nested: { title: "Algebra" } },
      ["chunk-1", { score: 0.75 }],
      null
    ]);

    const mutableObject = events[0]?.data as { chunks: number; nested: { title: string } };
    const mutableArray = events[1]?.data as Array<string | { score: number }>;
    mutableObject.chunks = 99;
    mutableObject.nested.title = "Changed";
    mutableArray.push("changed");

    expect(listTraceEvents(db, { runId: "run-a" }).map((event) => event.data)).toEqual([
      { chunks: 2, nested: { title: "Algebra" } },
      ["chunk-1", { score: 0.75 }],
      null
    ]);
  });

  test.each([
    ["blank run id", traceEvent({ runId: "   " }), "blank_run_id"],
    ["blank message", traceEvent({ message: " " }), "blank_message"],
    ["blank timestamp", traceEvent({ timestamp: "" }), "blank_timestamp"],
    ["invalid stage", traceEvent({ stage: "invalid-stage" as TraceEvent["stage"] }), "invalid_stage"],
    ["invalid level", traceEvent({ level: "debug" as TraceEvent["level"] }), "invalid_level"]
  ] as const)("rejects %s before inserting", (_label, event, reason) => {
    const error = captureTraceStoreError(() => {
      persistTraceEvent(db, event);
    });

    expect(error.reason).toBe(reason);
    expect(countTraceEvents()).toBe(0);
  });

  test.each([
    ["null", null],
    ["string", "not-an-event"]
  ] as const)("rejects non-object single trace event input: %s", (_label, event) => {
    const error = captureTraceStoreError(() => {
      persistTraceEvent(db, event as unknown as TraceEvent);
    });

    expect(error.reason).toBe("invalid_event");
    expect(error.data).toMatchObject({ reason: "invalid_event" });
    expect(countTraceEvents()).toBe(0);
  });

  test.each([
    ["null", null],
    ["number", 42]
  ] as const)("rejects non-object batched trace event input without partial inserts: %s", (_label, event) => {
    const error = captureTraceStoreError(() => {
      persistTraceEvents(db, [
        traceEvent({ message: "valid first" }),
        event as unknown as TraceEvent,
        traceEvent({ message: "valid last" })
      ]);
    });

    expect(error.reason).toBe("invalid_event");
    expect(countTraceEvents()).toBe(0);
  });

  test("rejects circular trace data before inserting", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const error = captureTraceStoreError(() => {
      persistTraceEvent(db, traceEvent({ data: circular }));
    });

    expect(error.reason).toBe("invalid_data");
    expect(countTraceEvents()).toBe(0);
  });

  test.each([
    ["nested undefined", { nested: { omitted: undefined } }],
    ["nested function", { nested: { callback: () => "bad" } }],
    ["nested symbol", { nested: { token: Symbol("bad") } }],
    ["nan", { value: Number.NaN }],
    ["infinity", { value: Number.POSITIVE_INFINITY }],
    ["array undefined", ["valid", undefined]],
    ["map", new Map([["key", "value"]])],
    ["set", new Set(["value"])]
  ] as const)("rejects non-JSON trace data before inserting: %s", (_label, data) => {
    const error = captureTraceStoreError(() => {
      persistTraceEvent(db, traceEvent({ data }));
    });

    expect(error.reason).toBe("invalid_data");
    expect(countTraceEvents()).toBe(0);
  });

  test("rejects sparse array trace data before inserting", () => {
    const sparseData: unknown[] = ["first"];
    sparseData.length = 3;
    sparseData[2] = "third";

    expect(1 in sparseData).toBe(false);

    const error = captureTraceStoreError(() => {
      persistTraceEvent(db, traceEvent({ data: sparseData }));
    });

    expect(error.reason).toBe("invalid_data");
    expect(error.data).toMatchObject({
      path: "data[1]",
      valueType: "missing"
    });
    expect(countTraceEvents()).toBe(0);
  });

  test("rolls back batched persist when trace data is not JSON-compatible", () => {
    const error = captureTraceStoreError(() => {
      persistTraceEvents(db, [
        traceEvent({ message: "valid first" }),
        traceEvent({ message: "invalid data", data: { value: Number.NEGATIVE_INFINITY } }),
        traceEvent({ message: "valid last" })
      ]);
    });

    expect(error.reason).toBe("invalid_data");
    expect(countTraceEvents()).toBe(0);
  });

  test("rejects a blank list query run id", () => {
    const error = captureTraceStoreError(() => {
      listTraceEvents(db, { runId: " " });
    });

    expect(error.reason).toBe("blank_run_id");
  });

  test("rolls back a batched persist when any event is invalid", () => {
    const error = captureTraceStoreError(() => {
      persistTraceEvents(db, [
        traceEvent({ message: "valid first" }),
        traceEvent({ message: " " }),
        traceEvent({ message: "valid last" })
      ]);
    });

    expect(error.reason).toBe("blank_message");
    expect(countTraceEvents()).toBe(0);
  });

  test("reports invalid data with row id when stored JSON is corrupt", () => {
    db.pragma("ignore_check_constraints = ON");
    const result = db
      .prepare(
        `INSERT INTO trace_events (run_id, stage, level, message, timestamp, data)
         VALUES ('run-corrupt', 'chunk', 'info', 'corrupt data', '2026-06-12T00:00:00.000Z', 'not-json')`
      )
      .run();
    db.pragma("ignore_check_constraints = OFF");
    const id = toNumberId(result.lastInsertRowid);

    const error = captureTraceStoreError(() => {
      listTraceEvents(db, { runId: "run-corrupt" });
    });

    expect(error.reason).toBe("invalid_data");
    expect(error.data).toMatchObject({ reason: "invalid_data", id });
  });

  function countTraceEvents(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM trace_events").get() as { count: number }).count;
  }
});

function traceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    runId: "run-a",
    stage: "chunk",
    level: "info",
    message: "trace message",
    timestamp: "2026-06-12T00:00:00.000Z",
    ...overrides
  };
}

function captureTraceStoreError(action: () => void): TraceStoreValidationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(TraceStoreValidationError);
    return error as TraceStoreValidationError;
  }

  throw new Error("Expected TraceStoreValidationError");
}

function toNumberId(id: number | bigint): number {
  return typeof id === "bigint" ? Number(id) : id;
}
