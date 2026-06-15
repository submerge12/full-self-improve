import { assertIsoInstant, assertSafeText, type SedentaryState } from "./schema.js";
import type { SedentarySpanIngestionInput } from "./sedentary.js";

export interface WindowsLoggerHeartbeat {
  readonly sourceId: string;
  readonly heartbeatAt: string;
  readonly loggerVersion?: string;
}

const SEDENTARY_STATES: readonly SedentaryState[] = ["active", "idle", "unknown"];

export function parseWindowsLoggerSpanPost(value: unknown): SedentarySpanIngestionInput {
  const payload = assertObjectPayload(value, "span payload");
  const sourceId = assertPayloadText(payload.sourceId, "sourceId");
  const spanStart = assertPayloadInstant(payload.spanStart, "spanStart");
  const spanEnd = assertPayloadInstant(payload.spanEnd, "spanEnd");
  if (spanEnd <= spanStart) {
    throw new Error("spanEnd must be after spanStart");
  }

  return {
    sourceId,
    spanStart,
    spanEnd,
    state: assertSedentaryState(payload.state),
    ...optionalConfidence(payload.confidence),
    ...optionalInstant(payload.receivedAt, "receivedAt")
  };
}

export function parseWindowsLoggerHeartbeat(value: unknown): WindowsLoggerHeartbeat {
  const payload = assertObjectPayload(value, "heartbeat payload");
  return {
    sourceId: assertPayloadText(payload.sourceId, "sourceId"),
    heartbeatAt: assertPayloadInstant(payload.heartbeatAt, "heartbeatAt"),
    ...optionalText(payload.loggerVersion, "loggerVersion")
  };
}

function assertObjectPayload(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertPayloadText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be text`);
  }
  return assertSafeText(value, field);
}

function assertPayloadInstant(value: unknown, field: string): string {
  return assertIsoInstant(assertPayloadText(value, field), field);
}

function assertSedentaryState(value: unknown): SedentaryState {
  if (typeof value !== "string" || !SEDENTARY_STATES.includes(value as SedentaryState)) {
    throw new Error("state must be active, idle, or unknown");
  }
  return value as SedentaryState;
}

function optionalConfidence(value: unknown): { readonly confidence?: number } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("confidence must be between 0 and 1");
  }
  return { confidence: value };
}

function optionalInstant(value: unknown, field: string): { readonly receivedAt?: string } {
  if (value === undefined) {
    return {};
  }
  return { receivedAt: assertPayloadInstant(value, field) };
}

function optionalText(value: unknown, field: string): { readonly loggerVersion?: string } {
  if (value === undefined) {
    return {};
  }
  return { loggerVersion: assertPayloadText(value, field) };
}
