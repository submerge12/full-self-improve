import type Database from "better-sqlite3";

import {
  TRACE_STAGES,
  type TraceEvent,
  type TraceLevel,
  type TraceQuery,
  type TraceStage
} from "../engine/trace.js";

export const TRACE_LEVELS = ["info", "warn", "error"] as const satisfies readonly TraceLevel[];

export type TraceStoreValidationReason =
  | "invalid_event"
  | "blank_run_id"
  | "blank_message"
  | "blank_timestamp"
  | "invalid_stage"
  | "invalid_level"
  | "invalid_data";

export type StoredTraceEvent = Omit<TraceEvent, "data"> & {
  id: number;
  data: unknown;
};

export class TraceStoreValidationError extends Error {
  readonly reason: TraceStoreValidationReason;
  readonly data: Record<string, unknown>;

  constructor(reason: TraceStoreValidationReason, message: string, data: Record<string, unknown>) {
    super(message);
    this.name = "TraceStoreValidationError";
    this.reason = reason;
    this.data = data;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface TraceEventRow {
  id: number;
  runId: string;
  stage: TraceStage;
  level: TraceLevel;
  message: string;
  timestamp: string;
  data: string;
}

interface PreparedTraceEvent {
  runId: string;
  stage: TraceStage;
  level: TraceLevel;
  message: string;
  timestamp: string;
  data: string;
}

export function persistTraceEvent(db: Database.Database, event: TraceEvent): StoredTraceEvent {
  const prepared = prepareTraceEvent(event);
  const result = insertTraceEvent(db, prepared);
  return getTraceEventById(db, toNumberId(result.lastInsertRowid));
}

export function persistTraceEvents(db: Database.Database, events: readonly TraceEvent[]): StoredTraceEvent[] {
  const preparedEvents = events.map(prepareTraceEvent);
  const insertMany = db.transaction((): StoredTraceEvent[] => {
    const storedEvents: StoredTraceEvent[] = [];

    for (const event of preparedEvents) {
      const result = insertTraceEvent(db, event);
      storedEvents.push(getTraceEventById(db, toNumberId(result.lastInsertRowid)));
    }

    return storedEvents;
  });

  return insertMany();
}

export function listTraceEvents(db: Database.Database, query: TraceQuery): StoredTraceEvent[] {
  const runId = validateText("runId", query.runId);
  const stage = query.stage === undefined ? undefined : validateStage(query.stage);

  if (stage === undefined) {
    return selectTraceEvents(
      db,
      `SELECT
         id,
         run_id AS runId,
         stage,
         level,
         message,
         timestamp,
         data
       FROM trace_events
       WHERE run_id = ?
       ORDER BY id`,
      [runId]
    );
  }

  return selectTraceEvents(
    db,
    `SELECT
       id,
       run_id AS runId,
       stage,
       level,
       message,
       timestamp,
       data
     FROM trace_events
     WHERE run_id = ?
       AND stage = ?
    ORDER BY id`,
    [runId, stage]
  );
}

function prepareTraceEvent(event: unknown): PreparedTraceEvent {
  const traceEvent = validateTraceEventInput(event);

  return {
    runId: validateText("runId", traceEvent.runId),
    stage: validateStage(traceEvent.stage),
    level: validateLevel(traceEvent.level),
    message: validateText("message", traceEvent.message),
    timestamp: validateText("timestamp", traceEvent.timestamp),
    data: serializeTraceData(traceEvent.data)
  };
}

function insertTraceEvent(db: Database.Database, event: PreparedTraceEvent): Database.RunResult {
  return db
    .prepare(
      `INSERT INTO trace_events (run_id, stage, level, message, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(event.runId, event.stage, event.level, event.message, event.timestamp, event.data);
}

function getTraceEventById(db: Database.Database, id: number): StoredTraceEvent {
  const row = db
    .prepare(
      `SELECT
         id,
         run_id AS runId,
         stage,
         level,
         message,
         timestamp,
         data
       FROM trace_events
       WHERE id = ?`
    )
    .get(id) as TraceEventRow | undefined;

  if (row === undefined) {
    throw new Error(`Trace event ${id} was not found after insert`);
  }

  return mapTraceEventRow(row);
}

function selectTraceEvents(db: Database.Database, sql: string, params: readonly string[]): StoredTraceEvent[] {
  const rows = db.prepare(sql).all(...params) as TraceEventRow[];
  return rows.map(mapTraceEventRow);
}

function mapTraceEventRow(row: TraceEventRow): StoredTraceEvent {
  return {
    id: row.id,
    runId: row.runId,
    stage: row.stage,
    level: row.level,
    message: row.message,
    timestamp: row.timestamp,
    data: cloneJsonData(parseTraceData(row))
  };
}

function validateTraceEventInput(event: unknown): Record<string, unknown> {
  if (isPlainObject(event)) {
    return event;
  }

  throw new TraceStoreValidationError("invalid_event", "Trace event must be an object", {
    reason: "invalid_event",
    valueType: describeValueType(event)
  });
}

function validateText(field: "runId" | "message" | "timestamp", value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  const reason = field === "runId" ? "blank_run_id" : field === "message" ? "blank_message" : "blank_timestamp";
  throw new TraceStoreValidationError(reason, `Trace event ${field} must be a non-empty string`, {
    reason,
    field,
    value: value ?? null
  });
}

function validateStage(stage: unknown): TraceStage {
  if (isTraceStage(stage)) {
    return stage;
  }

  throw new TraceStoreValidationError("invalid_stage", "Trace event stage is not supported", {
    reason: "invalid_stage",
    stage: stage ?? null,
    allowedStages: [...TRACE_STAGES]
  });
}

function validateLevel(level: unknown): TraceLevel {
  if (isTraceLevel(level)) {
    return level;
  }

  throw new TraceStoreValidationError("invalid_level", "Trace event level is not supported", {
    reason: "invalid_level",
    level: level ?? null,
    allowedLevels: [...TRACE_LEVELS]
  });
}

function serializeTraceData(data: unknown): string {
  if (data === undefined) {
    return "null";
  }

  validateJsonValue(data, "data", new Set<object>());

  try {
    const serialized = JSON.stringify(data);

    if (serialized !== undefined) {
      return serialized;
    }
  } catch (error) {
    throw invalidDataError(error);
  }

  throw invalidDataError(new TypeError("Trace event data cannot be serialized as JSON"));
}

function validateJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }

    throw invalidJsonData(path, "number");
  }

  if (Array.isArray(value)) {
    validateJsonArray(value, path, ancestors);
    return;
  }

  if (isPlainObject(value)) {
    validateJsonObject(value, path, ancestors);
    return;
  }

  throw invalidJsonData(path, describeValueType(value));
}

function validateJsonArray(values: readonly unknown[], path: string, ancestors: Set<object>): void {
  if (ancestors.has(values)) {
    throw invalidJsonData(path, "circular");
  }

  ancestors.add(values);

  for (let index = 0; index < values.length; index += 1) {
    if (!(index in values)) {
      throw invalidJsonData(`${path}[${index}]`, "missing");
    }

    validateJsonValue(values[index], `${path}[${index}]`, ancestors);
  }

  ancestors.delete(values);
}

function validateJsonObject(value: Record<string, unknown>, path: string, ancestors: Set<object>): void {
  if (ancestors.has(value)) {
    throw invalidJsonData(path, "circular");
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidJsonData(path, "symbol_key");
  }

  ancestors.add(value);

  for (const [key, propertyValue] of Object.entries(value)) {
    validateJsonValue(propertyValue, `${path}.${key}`, ancestors);
  }

  ancestors.delete(value);
}

function invalidJsonData(path: string, valueType: string): TraceStoreValidationError {
  return new TraceStoreValidationError("invalid_data", "Trace event data must be JSON-compatible", {
    reason: "invalid_data",
    path,
    valueType
  });
}

function parseTraceData(row: TraceEventRow): unknown {
  try {
    return JSON.parse(row.data) as unknown;
  } catch (error) {
    throw invalidDataError(error, row.id);
  }
}

function invalidDataError(error: unknown, id?: number): TraceStoreValidationError {
  const message = error instanceof Error ? error.message : "Trace event data cannot be serialized as JSON";

  return new TraceStoreValidationError("invalid_data", "Trace event data must be JSON-serializable", {
    reason: "invalid_data",
    message,
    ...(id === undefined ? {} : { id })
  });
}

function cloneJsonData(data: unknown): unknown {
  return globalThis.structuredClone(data);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function describeValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  if (typeof value === "object") {
    return value.constructor?.name ?? "object";
  }

  return typeof value;
}

function isTraceStage(stage: unknown): stage is TraceStage {
  return typeof stage === "string" && TRACE_STAGES.includes(stage as TraceStage);
}

function isTraceLevel(level: unknown): level is TraceLevel {
  return typeof level === "string" && TRACE_LEVELS.includes(level as TraceLevel);
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
