import { randomUUID } from "node:crypto";

export const TRACE_STAGES = [
  "chunk",
  "extract",
  "merge",
  "link",
  "page-gen",
  "plan",
  "grade",
  "diagnose"
] as const;

export type TraceStage = (typeof TRACE_STAGES)[number];
export type TraceLevel = "info" | "warn" | "error";

export interface TraceEvent {
  runId: string;
  stage: TraceStage;
  level: TraceLevel;
  message: string;
  timestamp: string;
  data?: unknown;
}

export type TraceEventInput = Omit<TraceEvent, "timestamp">;

export interface TraceClock {
  now(): Date;
}

export interface TraceQuery {
  runId: string;
  stage?: TraceStage;
}

export interface TraceRecorder {
  record(event: TraceEventInput): TraceEvent;
  getEvents(query: TraceQuery): TraceEvent[];
}

export function createRunId(prefix = "run"): string {
  return `${sanitizePrefix(prefix)}-${randomUUID().replaceAll("-", "")}`;
}

export function recordTraceEvent(event: TraceEventInput, clock: TraceClock = systemClock): TraceEvent {
  return cloneEvent({
    ...event,
    timestamp: clock.now().toISOString()
  });
}

export function createTraceRecorder(clock: TraceClock = systemClock): TraceRecorder {
  const events: TraceEvent[] = [];

  return {
    record(event) {
      const recorded = recordTraceEvent(event, clock);
      events.push(recorded);
      return cloneEvent(recorded);
    },
    getEvents(query) {
      return events
        .filter((event) => event.runId === query.runId)
        .filter((event) => query.stage === undefined || event.stage === query.stage)
        .map((event) => cloneEvent(event));
    }
  };
}

const systemClock: TraceClock = {
  now: () => new Date()
};

function sanitizePrefix(prefix: string): string {
  const sanitized = prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized : "run";
}

function cloneEvent(event: TraceEvent): TraceEvent {
  return {
    ...event,
    data: cloneData(event.data)
  };
}

function cloneData(data: unknown): unknown {
  if (data === undefined) {
    return undefined;
  }

  return globalThis.structuredClone(data);
}
