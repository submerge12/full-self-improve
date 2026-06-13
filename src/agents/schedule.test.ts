import { describe, expect, test } from "vitest";

import { createAgentDayDryRunPlan } from "./dry-run.js";
import { createAgentScheduleReport, createAgentScheduleTiming } from "./schedule.js";

describe("agent schedule planning", () => {
  test("marks the daily agent-day command due exactly at the scheduled local time", () => {
    const timing = createAgentScheduleTiming({
      now: "2026-06-14T07:30:00+08:00",
      timezone: "Asia/Shanghai",
      dailyAt: "07:30"
    });
    const plan = createAgentDayDryRunPlan({ date: timing.date, multicaBoard: "Holly Daily" });
    const report = createAgentScheduleReport({
      timing,
      plan,
      argvOptions: {
        configPath: "config/agents.example.json",
        multicaBoard: "Holly Daily"
      }
    });

    expect(report).toMatchObject({
      timezone: "Asia/Shanghai",
      dailyAt: "07:30",
      now: "2026-06-14T07:30:00+08:00",
      due: true,
      date: "2026-06-14",
      window: {
        startsAt: "2026-06-14T07:30:00+08:00",
        endsBefore: "2026-06-15T07:30:00+08:00"
      },
      wouldRun: {
        command: "agent-day",
        mode: "dry-run",
        argv: [
          "agent-day",
          "--dry-run",
          "--date",
          "2026-06-14",
          "--config",
          "config/agents.example.json",
          "--board",
          "Holly Daily"
        ]
      }
    });
    expect(report.plan.externalWrites).toEqual([]);
    expect(report.plan.date).toBe("2026-06-14");
  });

  test("reports not due before the scheduled local time", () => {
    const timing = createAgentScheduleTiming({
      now: "2026-06-14T07:29:59+08:00",
      timezone: "Asia/Shanghai",
      dailyAt: "07:30"
    });

    expect(timing).toMatchObject({
      due: false,
      date: "2026-06-14",
      window: {
        startsAt: "2026-06-14T07:30:00+08:00",
        endsBefore: "2026-06-15T07:30:00+08:00"
      }
    });
  });

  test("derives schedule window offsets from the configured timezone instead of --now", () => {
    const timing = createAgentScheduleTiming({
      now: "2026-06-13T23:30:00Z",
      timezone: "Asia/Shanghai",
      dailyAt: "07:30"
    });

    expect(timing).toMatchObject({
      due: true,
      date: "2026-06-14",
      window: {
        startsAt: "2026-06-14T07:30:00+08:00",
        endsBefore: "2026-06-15T07:30:00+08:00"
      }
    });
  });

  test("keeps daylight-saving offsets attached to each scheduled boundary", () => {
    const timing = createAgentScheduleTiming({
      now: "2026-03-08T12:30:00Z",
      timezone: "America/New_York",
      dailyAt: "07:30"
    });

    expect(timing).toMatchObject({
      due: true,
      date: "2026-03-08",
      window: {
        startsAt: "2026-03-08T07:30:00-04:00",
        endsBefore: "2026-03-09T07:30:00-04:00"
      }
    });
  });

  test("rejects invalid schedule inputs", () => {
    expect(() =>
      createAgentScheduleTiming({
        now: "not-a-date",
        timezone: "Asia/Shanghai",
        dailyAt: "07:30"
      })
    ).toThrow(/valid ISO timestamp/);
    expect(() =>
      createAgentScheduleTiming({
        now: "2026-02-31T07:30:00+08:00",
        timezone: "Asia/Shanghai",
        dailyAt: "07:30"
      })
    ).toThrow(/valid ISO timestamp/);
    expect(() =>
      createAgentScheduleTiming({
        now: "2026-06-14T07:30:00+08:00",
        timezone: "Mars/Base",
        dailyAt: "07:30"
      })
    ).toThrow(/Invalid agent schedule timezone/);
    expect(() =>
      createAgentScheduleTiming({
        now: "2026-06-14T07:30:00+08:00",
        timezone: "Asia/Shanghai",
        dailyAt: "24:00"
      })
    ).toThrow(/Invalid agent schedule --daily-at/);
  });
});
