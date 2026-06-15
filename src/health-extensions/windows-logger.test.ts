import { describe, expect, test, vi } from "vitest";

import {
  createWindowsHealthLogger,
  loadWindowsLoggerConfig,
  renderWindowsLoggerStartupCommand,
  type IdleStateProvider,
  type WindowsLoggerConfig,
  type WindowsLoggerHeartbeatPostInput,
  type WindowsLoggerSpanPostInput
} from "./windows-logger.js";

const BASE_CONFIG: WindowsLoggerConfig = {
  loggerId: "knowledge-loop-windows",
  pollIntervalMs: 30_000,
  idleThresholdMs: 60_000,
  sleepWakeGapMs: 300_000,
  heartbeatIntervalMs: 300_000,
  healthApiBaseUrl: "https://health.example.test",
  bearerToken: "test-token",
  visibleAlert: {
    channel: "stdout",
    title: "Break reminder"
  }
};

describe("Windows health logger", () => {
  test("polls idle state through the injected provider on each tick", async () => {
    const read = vi
      .fn<IdleStateProvider["read"]>()
      .mockReturnValueOnce({ idleMs: 0, now: "2026-06-15T00:00:00.000Z" })
      .mockReturnValueOnce({ idleMs: 1_000, now: "2026-06-15T00:00:30.000Z" });
    const logger = createWindowsHealthLogger({
      config: BASE_CONFIG,
      idleStateProvider: { read },
      spanPoster: async () => ({ reminderEligible: false }),
      heartbeatPoster: async () => undefined
    });

    await logger.tick();
    await logger.tick();

    expect(read).toHaveBeenCalledTimes(2);
  });

  test("posts idle span and visible alert when reminder eligible", async () => {
    const sequence = scriptedIdleProvider([
      { idleMs: 0, now: "2026-06-15T00:00:00.000Z" },
      { idleMs: 61_000, now: "2026-06-15T00:01:01.000Z" },
      { idleMs: 0, now: "2026-06-15T00:01:30.000Z" }
    ]);
    const spans: WindowsLoggerSpanPostInput[] = [];
    const alerts: string[] = [];
    const logger = createWindowsHealthLogger({
      config: BASE_CONFIG,
      idleStateProvider: sequence,
      spanPoster: async (span) => {
        spans.push(span);
        return { reminderEligible: true, reminderText: "Stand up" };
      },
      heartbeatPoster: async () => undefined,
      visibleAlertClient: {
        show: async ({ body }) => {
          alerts.push(body);
        }
      }
    });

    await logger.tick();
    await logger.tick();
    expect(spans).toEqual([]);

    await logger.tick();

    expect(spans).toEqual([
      {
        sourceId: "knowledge-loop-windows:idle:2026-06-15T00:00:00.000Z",
        spanStart: "2026-06-15T00:00:00.000Z",
        spanEnd: "2026-06-15T00:01:30.000Z",
        state: "idle",
        confidence: 1,
        receivedAt: "2026-06-15T00:01:30.000Z"
      }
    ]);
    expect(alerts).toEqual(["Stand up"]);
  });

  test("closes an open idle span at the previous observation after a sleep wake gap", async () => {
    const sequence = scriptedIdleProvider([
      { idleMs: 0, now: "2026-06-15T00:00:00.000Z" },
      { idleMs: 61_000, now: "2026-06-15T00:01:01.000Z" },
      { idleMs: 0, now: "2026-06-15T00:07:00.000Z" }
    ]);
    const spans: WindowsLoggerSpanPostInput[] = [];
    const heartbeats: WindowsLoggerHeartbeatPostInput[] = [];
    const logger = createWindowsHealthLogger({
      config: BASE_CONFIG,
      idleStateProvider: sequence,
      spanPoster: async (span) => {
        spans.push(span);
        return { reminderEligible: false };
      },
      heartbeatPoster: async (heartbeat) => {
        heartbeats.push(heartbeat);
      }
    });

    await logger.tick();
    await logger.tick();
    await logger.tick();

    expect(spans).toEqual([
      {
        sourceId: "knowledge-loop-windows:idle:2026-06-15T00:00:00.000Z",
        spanStart: "2026-06-15T00:00:00.000Z",
        spanEnd: "2026-06-15T00:01:01.000Z",
        state: "idle",
        confidence: 1,
        receivedAt: "2026-06-15T00:01:01.000Z"
      }
    ]);
    expect(heartbeats).toEqual([
      {
        sourceId: "knowledge-loop-windows",
        heartbeatAt: "2026-06-15T00:00:00.000Z",
        kind: "logger_heartbeat"
      },
      {
        sourceId: "knowledge-loop-windows",
        heartbeatAt: "2026-06-15T00:07:00.000Z",
        kind: "logger_recovered_after_gap"
      }
    ]);
  });

  test("posts heartbeat at the configured interval", async () => {
    const sequence = scriptedIdleProvider([
      { idleMs: 0, now: "2026-06-15T00:00:00.000Z" },
      { idleMs: 0, now: "2026-06-15T00:04:59.000Z" },
      { idleMs: 0, now: "2026-06-15T00:05:00.000Z" }
    ]);
    const heartbeats: WindowsLoggerHeartbeatPostInput[] = [];
    const logger = createWindowsHealthLogger({
      config: BASE_CONFIG,
      idleStateProvider: sequence,
      spanPoster: async () => ({ reminderEligible: false }),
      heartbeatPoster: async (heartbeat) => {
        heartbeats.push(heartbeat);
      }
    });

    await logger.tick();
    await logger.tick();
    await logger.tick();

    expect(heartbeats).toEqual([
      {
        sourceId: "knowledge-loop-windows",
        heartbeatAt: "2026-06-15T00:00:00.000Z",
        kind: "logger_heartbeat"
      },
      {
        sourceId: "knowledge-loop-windows",
        heartbeatAt: "2026-06-15T00:05:00.000Z",
        kind: "logger_heartbeat"
      }
    ]);
  });

  test("posts spans to the health API with bearer auth through the default HTTP poster", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/api/health/sedentary/spans")) {
        return jsonResponse({ ok: true, data: { span: { id: 12 } } });
      }
      if (String(url).endsWith("/api/health/break-reminders/evaluate")) {
        return jsonResponse({
          ok: true,
          data: {
            result: {
              status: "eligible",
              reminder: { reason: "Stand up" }
            }
          }
        });
      }
      return jsonResponse({ ok: false }, 404);
    };
    const alerts: string[] = [];
    const logger = createWindowsHealthLogger({
      config: {
        ...BASE_CONFIG,
        healthApiBaseUrl: "https://health.example.test/root/"
      },
      idleStateProvider: scriptedIdleProvider([
        { idleMs: 0, now: "2026-06-15T00:00:00.000Z" },
        { idleMs: 61_000, now: "2026-06-15T00:01:01.000Z" },
        { idleMs: 0, now: "2026-06-15T00:01:30.000Z" }
      ]),
      heartbeatPoster: async () => undefined,
      visibleAlertClient: {
        show: async ({ body }) => {
          alerts.push(body);
        }
      },
      fetch
    });

    await logger.tick();
    await logger.tick();
    await logger.tick();

    expect(requests.map((request) => request.url)).toEqual([
      "https://health.example.test/root/api/health/sedentary/spans",
      "https://health.example.test/root/api/health/break-reminders/evaluate"
    ]);
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token"
      }
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      sourceId: "knowledge-loop-windows:idle:2026-06-15T00:00:00.000Z",
      spanStart: "2026-06-15T00:00:00.000Z",
      spanEnd: "2026-06-15T00:01:30.000Z",
      state: "idle",
      confidence: 1,
      receivedAt: "2026-06-15T00:01:30.000Z"
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      from: "2026-06-15T00:00:00.000Z",
      to: "2026-06-15T00:01:30.000Z",
      thresholdMinutes: 1,
      evaluatedAt: "2026-06-15T00:01:30.000Z",
      deliveryChannel: "stdout"
    });
    expect(alerts).toEqual(["Stand up"]);
  });

  test("posts default heartbeat records to the existing health metrics endpoint", async () => {
    const requests: CapturedRequest[] = [];
    const logger = createWindowsHealthLogger({
      config: BASE_CONFIG,
      idleStateProvider: scriptedIdleProvider([{ idleMs: 0, now: "2026-06-15T00:00:00.000Z" }]),
      spanPoster: async () => ({ reminderEligible: false }),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ ok: true, data: { result: { id: 1 } } });
      }
    });

    await logger.tick();

    expect(requests.map((request) => request.url)).toEqual(["https://health.example.test/api/health/metrics"]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      metricKey: "windows-logger-heartbeat",
      metricLabel: "Windows logger heartbeat",
      value: 1,
      unit: "event",
      observedAt: "2026-06-15T00:00:00.000Z",
      note: "sourceId=knowledge-loop-windows; kind=logger_heartbeat"
    });
  });

  test("start and stop manage one polling interval", async () => {
    const intervals: Array<{ callback: () => void; intervalMs: number }> = [];
    const cleared: unknown[] = [];
    const logger = createWindowsHealthLogger({
      config: BASE_CONFIG,
      idleStateProvider: scriptedIdleProvider([{ idleMs: 0, now: "2026-06-15T00:00:00.000Z" }]),
      spanPoster: async () => ({ reminderEligible: false }),
      heartbeatPoster: async () => undefined,
      setInterval: (callback, intervalMs) => {
        intervals.push({ callback, intervalMs });
        return "timer-1";
      },
      clearInterval: (timer) => {
        cleared.push(timer);
      }
    });

    await logger.start();
    await logger.start();
    await logger.stop();

    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.intervalMs).toBe(30_000);
    expect(cleared).toEqual(["timer-1"]);
  });
});

describe("Windows logger config and startup command", () => {
  test("loads and validates a config object", () => {
    expect(loadWindowsLoggerConfig({ ...BASE_CONFIG, bearerToken: " token " })).toEqual({
      ...BASE_CONFIG,
      healthApiBaseUrl: "https://health.example.test",
      bearerToken: "token"
    });
  });

  test("rejects invalid config objects", () => {
    expect(() => loadWindowsLoggerConfig({ ...BASE_CONFIG, pollIntervalMs: 0 })).toThrow(
      "pollIntervalMs must be a positive integer"
    );
    expect(() => loadWindowsLoggerConfig({ ...BASE_CONFIG, healthApiBaseUrl: "https://user:pass@example.test" })).toThrow(
      "healthApiBaseUrl must be an HTTP(S) base URL without credentials"
    );
    expect(() => loadWindowsLoggerConfig({ ...BASE_CONFIG, bearerToken: " " })).toThrow("bearerToken must be non-empty");
    expect(() =>
      loadWindowsLoggerConfig({
        ...BASE_CONFIG,
        visibleAlert: { channel: "toast", title: "Break reminder" }
      })
    ).toThrow("visibleAlert.channel must be stdout or powershell");
  });

  test("requires an explicit visible alert client for powershell alerts", () => {
    expect(() =>
      createWindowsHealthLogger({
        config: {
          ...BASE_CONFIG,
          visibleAlert: {
            channel: "powershell",
            title: "Break reminder"
          }
        },
        idleStateProvider: scriptedIdleProvider([{ idleMs: 0, now: "2026-06-15T00:00:00.000Z" }]),
        spanPoster: async () => ({ reminderEligible: false }),
        heartbeatPoster: async () => undefined
      })
    ).toThrow("visibleAlertClient is required for powershell visible alerts");
  });

  test("renders Windows startup registration command without executing it", () => {
    expect(
      renderWindowsLoggerStartupCommand({
        scriptPath: "G:\\knowledge-loop\\scripts\\health-windows-logger.ts",
        configPath: "G:\\knowledge-loop\\config\\health\\windows-logger.json"
      })
    ).toBe(
      'schtasks /Create /TN knowledge-loop-health-windows-logger /SC ONLOGON /TR "npm exec tsx G:\\knowledge-loop\\scripts\\health-windows-logger.ts -- --config G:\\knowledge-loop\\config\\health\\windows-logger.json" /F'
    );
  });
});

interface CapturedRequest {
  readonly url: string;
  readonly init?: RequestInit;
}

function scriptedIdleProvider(states: Array<{ readonly idleMs: number; readonly now: string }>): IdleStateProvider {
  let index = 0;
  return {
    read: () => {
      const state = states[index];
      if (state === undefined) {
        throw new Error("idle script exhausted");
      }
      index += 1;
      return state;
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}
