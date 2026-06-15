import { describe, expect, test } from "vitest";

import { parseWindowsLoggerHeartbeat, parseWindowsLoggerSpanPost } from "./windows-logger-contract.js";

describe("Windows logger contract", () => {
  test("parses a valid sedentary span payload with trimmed source metadata", () => {
    expect(
      parseWindowsLoggerSpanPost({
        sourceId: " windows-logger:span-1 ",
        spanStart: "2026-06-15T01:00:00.000Z",
        spanEnd: "2026-06-15T02:00:00.000Z",
        state: "idle",
        confidence: 0.95,
        receivedAt: "2026-06-15T02:00:02.000Z"
      })
    ).toEqual({
      sourceId: "windows-logger:span-1",
      spanStart: "2026-06-15T01:00:00.000Z",
      spanEnd: "2026-06-15T02:00:00.000Z",
      state: "idle",
      confidence: 0.95,
      receivedAt: "2026-06-15T02:00:02.000Z"
    });
  });

  test("rejects malformed sedentary span payloads before ingestion", () => {
    expect(() =>
      parseWindowsLoggerSpanPost({
        sourceId: "windows-logger:bad-interval",
        spanStart: "2026-06-15T02:00:00.000Z",
        spanEnd: "2026-06-15T02:00:00.000Z",
        state: "idle",
        confidence: 0.9
      })
    ).toThrow("spanEnd must be after spanStart");
    expect(() =>
      parseWindowsLoggerSpanPost({
        sourceId: "windows-logger:bad-state",
        spanStart: "2026-06-15T01:00:00.000Z",
        spanEnd: "2026-06-15T02:00:00.000Z",
        state: "paused",
        confidence: 0.9
      })
    ).toThrow("state must be active, idle, or unknown");
    expect(() =>
      parseWindowsLoggerSpanPost({
        sourceId: "windows-logger:bad-confidence",
        spanStart: "2026-06-15T01:00:00.000Z",
        spanEnd: "2026-06-15T02:00:00.000Z",
        state: "idle",
        confidence: 1.1
      })
    ).toThrow("confidence must be between 0 and 1");
    expect(() =>
      parseWindowsLoggerSpanPost({
        sourceId: " ",
        spanStart: "2026-06-15T01:00:00.000Z",
        spanEnd: "2026-06-15T02:00:00.000Z",
        state: "idle",
        confidence: 0.9
      })
    ).toThrow("sourceId is required");
  });

  test("parses valid heartbeat payloads and trims optional logger metadata", () => {
    expect(
      parseWindowsLoggerHeartbeat({
        sourceId: " windows-logger:host-1 ",
        heartbeatAt: "2026-06-15T02:00:00.000Z",
        loggerVersion: " 0.4.0 "
      })
    ).toEqual({
      sourceId: "windows-logger:host-1",
      heartbeatAt: "2026-06-15T02:00:00.000Z",
      loggerVersion: "0.4.0"
    });
  });

  test("rejects malformed heartbeat payloads", () => {
    expect(() => parseWindowsLoggerHeartbeat(null)).toThrow("heartbeat payload must be an object");
    expect(() =>
      parseWindowsLoggerHeartbeat({
        sourceId: " ",
        heartbeatAt: "2026-06-15T02:00:00.000Z"
      })
    ).toThrow("sourceId is required");
    expect(() =>
      parseWindowsLoggerHeartbeat({
        sourceId: "windows-logger:host-1",
        heartbeatAt: "2026-06-15"
      })
    ).toThrow("heartbeatAt must be an ISO instant");
    expect(() =>
      parseWindowsLoggerHeartbeat({
        sourceId: "windows-logger:host-1",
        heartbeatAt: "2026-06-15T02:00:00.000Z",
        loggerVersion: ""
      })
    ).toThrow("loggerVersion is required");
  });
});
