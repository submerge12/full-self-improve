import { describe, expect, test } from "vitest";

import { createAgentDayDryRunPlan } from "./dry-run.js";
import { createAgentFailureSmokeReport } from "./failure-smoke.js";

describe("agent failure smoke report", () => {
  test("publishes a blocker for the default scholar morning plan failure and continues later agents", async () => {
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });

    const report = await createAgentFailureSmokeReport({ plan });

    expect(report).toMatchObject({
      mode: "offline-failure-smoke",
      date: "2026-06-13",
      status: "blocked",
      blockerPublished: true,
      failedEndpoint: {
        role: "scholar",
        phase: "morning-plan",
        method: "GET",
        url: "http://127.0.0.1:3000/api/plan/today"
      },
      totals: {
        reads: 4,
        publishedActions: 4,
        blockers: 1,
        publishFailures: 0
      }
    });
    expect(report.dayRunReport.entries.map((entry) => `${entry.role}:${entry.phase}:${entry.status}`)).toEqual([
      "librarian:nightly-ingest:completed",
      "scholar:morning-plan:blocked",
      "nutritionist:daily-meals:completed",
      "scholar:evening-mastery:completed"
    ]);
    expect(report.blocker?.title).toBe("Agent blocked for 2026-06-13");
    expect(report.blocker?.sourceEndpoints).toEqual(["GET http://127.0.0.1:3000/api/plan/today"]);
    expect(report.publishedActions.map((action) => action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Agent blocked for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
    expect(report.nonCompletionNotice).toContain("does not kill real API");
    expect(report.nonCompletionNotice).toContain("does not call Multica");
    expect(report.nonCompletionNotice).toContain("does not prove live blocker");
    expect(report.nonCompletionNotice).toContain("does not close M2");
  });

  test("redacts simulated secret and path from blocker and report output", async () => {
    const plan = createAgentDayDryRunPlan({
      date: "2026-06-13",
      knowledgeLoopBaseUrl: "http://127.0.0.1:3000?token=source-secret"
    });

    const report = await createAgentFailureSmokeReport({
      plan,
      simulatedError: new Error("Authorization: Bearer smoke-secret at G:\\pi-harness\\private\\token.txt")
    });
    const serialized = JSON.stringify(report);

    expect(report.blocker?.body).toContain("Authorization: Bearer REDACTED");
    expect(report.blocker?.body).not.toContain("smoke-secret");
    expect(report.blocker?.body).not.toContain("G:\\pi-harness");
    expect(report.failedEndpoint.url).toContain("token=REDACTED");
    expect(serialized).not.toContain("source-secret");
    expect(serialized).not.toContain("smoke-secret");
    expect(serialized).not.toContain("G:\\pi-harness");
  });

  test("rejects a selector that does not match an endpoint", async () => {
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });

    await expect(
      createAgentFailureSmokeReport({
        plan,
        failedEndpoint: {
          role: "scholar",
          phase: "morning-plan",
          method: "GET",
          urlIncludes: "/api/does-not-exist"
        }
      })
    ).rejects.toThrow(/No endpoint matched failure smoke selector/);
  });

  test("runs entirely with injected fake clients and never needs real clients or network", async () => {
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });

    const report = await createAgentFailureSmokeReport({ plan });

    expect(report.fakeClientEvents).toEqual([
      "read:POST http://127.0.0.1:3000/api/ingest/run?adapter=holly-vault",
      "publish:Librarian ingest report for 2026-06-13",
      "read:GET http://127.0.0.1:3000/api/plan/today",
      "publish:Agent blocked for 2026-06-13",
      "read:GET http://127.0.0.1:8000/api/meal-plan/today?date=2026-06-13",
      "read:POST http://127.0.0.1:8000/api/meal-engine/procurement",
      "publish:Nutrition plan for 2026-06-13",
      "read:GET http://127.0.0.1:3000/api/mastery/summary",
      "publish:Scholar mastery report for 2026-06-13"
    ]);
  });
});
