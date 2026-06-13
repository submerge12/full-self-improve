import { describe, expect, test } from "vitest";

import { createAgentDayDryRunPlan, type AgentEndpointPlan, type AgentIntendedAction } from "./dry-run.js";
import { executeAgentDay } from "./day-runner.js";

describe("agent day runner", () => {
  test("dry-run day execution reports every planned agent without calling clients", async () => {
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });

    const report = await executeAgentDay(plan, "dry-run", {
      readClient: {
        async read() {
          throw new Error("read should not be called");
        }
      },
      boardClient: {
        async publish() {
          throw new Error("publish should not be called");
        }
      }
    });

    expect(report).toMatchObject({
      mode: "dry-run",
      date: "2026-06-13",
      multicaBoard: "daily-plan",
      status: "planned",
      reads: [],
      publishedActions: [],
      blockers: [],
      publishFailures: [],
      skipped: [],
      totals: {
        reads: 0,
        publishedActions: 0,
        blockers: 0,
        publishFailures: 0
      },
      llmCost: {
        estimatedUsd: 0,
        source: "dry-run-no-llm"
      }
    });
    expect(report.entries.map((entry) => `${entry.role}:${entry.phase}:${entry.status}`)).toEqual([
      "librarian:nightly-ingest:planned",
      "scholar:morning-plan:planned",
      "nutritionist:daily-meals:planned",
      "scholar:evening-mastery:planned"
    ]);
    expect(report.llmCost.perAgent.map((entry) => `${entry.role}:${entry.phase}:${entry.estimatedUsd}`)).toEqual([
      "librarian:nightly-ingest:0",
      "scholar:morning-plan:0",
      "nutritionist:daily-meals:0",
      "scholar:evening-mastery:0"
    ]);
  });

  test("live day execution runs each agent sequence with injected clients", async () => {
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });
    const reads: AgentEndpointPlan[] = [];
    const publishedActions: AgentIntendedAction[] = [];
    const events: string[] = [];

    const report = await executeAgentDay(plan, "live", {
      readClient: {
        async read(endpoint) {
          reads.push(endpoint);
          events.push(`read:${endpoint.method} ${endpoint.url}`);
          return { endpoint, status: 200, body: successfulReadBodyFor(endpoint) };
        }
      },
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          events.push(`publish:${action.title}`);
          return { action, id: `item-${publishedActions.length}` };
        }
      }
    });

    expect(report.status).toBe("completed");
    expect(report.entries.map((entry) => entry.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(reads.map((read) => `${read.method} ${read.url}`)).toEqual([
      "POST http://127.0.0.1:3000/api/ingest/run?adapter=holly-vault",
      "GET http://127.0.0.1:3000/api/plan/today",
      "GET http://127.0.0.1:8000/api/meal-plan/today?date=2026-06-13",
      "GET http://127.0.0.1:3000/api/mastery/summary"
    ]);
    expect(report.publishedActions.map((publish) => publish.action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Scholar study plan for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
    expect(report.blockers).toEqual([]);
    expect(report.publishFailures).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.totals).toEqual({
      reads: 4,
      publishedActions: 4,
      blockers: 0,
      publishFailures: 0
    });
    expect(events).toEqual([
      "read:POST http://127.0.0.1:3000/api/ingest/run?adapter=holly-vault",
      "publish:Librarian ingest report for 2026-06-13",
      "read:GET http://127.0.0.1:3000/api/plan/today",
      "publish:Scholar study plan for 2026-06-13",
      "read:GET http://127.0.0.1:8000/api/meal-plan/today?date=2026-06-13",
      "publish:Nutrition plan for 2026-06-13",
      "read:GET http://127.0.0.1:3000/api/mastery/summary",
      "publish:Scholar mastery report for 2026-06-13"
    ]);
  });

  test("live day execution surfaces injected per-agent llm cost snapshots", async () => {
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });
    const costEvents: string[] = [];

    const report = await executeAgentDay(plan, "live", {
      readClient: {
        async read(endpoint) {
          return { endpoint, status: 200, body: successfulReadBodyFor(endpoint) };
        }
      },
      boardClient: {
        async publish(action) {
          return { action, id: action.title };
        }
      },
      costClient: {
        async readCost(planForCost) {
          costEvents.push(`${planForCost.role}:${planForCost.phase}`);
          return {
            estimatedUsd: planForCost.phase === "daily-meals" ? 0 : 0.0125,
            source: "pi-harness-live",
            currency: "USD",
            detail: `pi-harness session ${planForCost.role}:${planForCost.phase}`
          };
        }
      }
    });

    expect(costEvents).toEqual([
      "librarian:nightly-ingest",
      "scholar:morning-plan",
      "nutritionist:daily-meals",
      "scholar:evening-mastery"
    ]);
    expect(report.entries.map((entry) => `${entry.role}:${entry.phase}:${entry.llmCost.estimatedUsd}`)).toEqual([
      "librarian:nightly-ingest:0.0125",
      "scholar:morning-plan:0.0125",
      "nutritionist:daily-meals:0",
      "scholar:evening-mastery:0.0125"
    ]);
    expect(report.llmCost).toMatchObject({
      estimatedUsd: 0.0375,
      source: "pi-harness-live"
    });
    expect(report.llmCost.perAgent[0]).toMatchObject({
      role: "librarian",
      phase: "nightly-ingest",
      source: "pi-harness-live",
      currency: "USD",
      detail: "pi-harness session librarian:nightly-ingest"
    });
  });

  test("live day execution redacts injected llm cost detail", async () => {
    const secret = "real-token";
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });

    const report = await executeAgentDay(plan, "live", {
      readClient: {
        async read(endpoint) {
          return { endpoint, status: 200, body: successfulReadBodyFor(endpoint) };
        }
      },
      boardClient: {
        async publish(action) {
          return { action, id: action.title };
        }
      },
      costClient: {
        async readCost() {
          return {
            estimatedUsd: 0.01,
            source: "pi-harness-live",
            currency: "USD",
            detail: `Authorization: Bearer ${secret} at G:\\pi-harness\\private\\cost.json`
          };
        }
      }
    });

    const serialized = JSON.stringify(report.llmCost);
    expect(serialized).toContain("Authorization: Bearer REDACTED");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("G:\\pi-harness");
  });

  test("live day execution keeps the report when an injected llm cost snapshot fails", async () => {
    const secret = "real-token";
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });

    const report = await executeAgentDay(plan, "live", {
      readClient: {
        async read(endpoint) {
          return { endpoint, status: 200, body: successfulReadBodyFor(endpoint) };
        }
      },
      boardClient: {
        async publish(action) {
          return { action, id: action.title };
        }
      },
      costClient: {
        async readCost() {
          throw new Error(`Cost snapshot failed with token=${secret} at /home/holly/pi-harness/cost.json`);
        }
      }
    });

    const serialized = JSON.stringify(report.llmCost);
    expect(report.status).toBe("completed");
    expect(report.llmCost.source).toBe("cost_unavailable");
    expect(report.llmCost.perAgent.map((entry) => entry.source)).toEqual([
      "cost_unavailable",
      "cost_unavailable",
      "cost_unavailable",
      "cost_unavailable"
    ]);
    expect(serialized).toContain("token=REDACTED");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/home/holly");
  });

  test("live day execution publishes a blocker for one failed agent and continues independent later agents", async () => {
    const secret = "secret-token";
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });
    const publishedActions: AgentIntendedAction[] = [];

    const report = await executeAgentDay(plan, "live", {
      readClient: {
        async read(endpoint) {
          if (endpoint.url.endsWith("/api/plan/today")) {
            throw new Error(`Authorization: Bearer ${secret} at G:\\pi-harness\\secret.log`);
          }

          return { endpoint, status: 200, body: successfulReadBodyFor(endpoint) };
        }
      },
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          return { action, id: `item-${publishedActions.length}` };
        }
      }
    });

    expect(report.status).toBe("blocked");
    expect(report.entries.map((entry) => `${entry.role}:${entry.phase}:${entry.status}`)).toEqual([
      "librarian:nightly-ingest:completed",
      "scholar:morning-plan:blocked",
      "nutritionist:daily-meals:completed",
      "scholar:evening-mastery:completed"
    ]);
    expect(report.skipped).toEqual([]);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]?.body).toContain("Authorization: Bearer REDACTED");
    expect(report.blockers[0]?.body).not.toContain(secret);
    expect(report.blockers[0]?.body).not.toContain("G:\\pi-harness");
    expect(report.totals).toEqual({
      reads: 3,
      publishedActions: 4,
      blockers: 1,
      publishFailures: 0
    });
    expect(publishedActions.map((action) => action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Agent blocked for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
  });

  test("live day execution preserves a blocker report when publishing the blocker fails", async () => {
    const readSecret = "read-secret-token";
    const publishSecret = "publish-secret-token";
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });
    const publishedActions: AgentIntendedAction[] = [];

    const report = await executeAgentDay(plan, "live", {
      readClient: {
        async read(endpoint) {
          if (endpoint.url.endsWith("/api/plan/today")) {
            throw new Error(`Authorization: Bearer ${readSecret} at /home/holly/pi-harness/secret.log`);
          }

          return { endpoint, status: 200, body: successfulReadBodyFor(endpoint) };
        }
      },
      boardClient: {
        async publish(action) {
          if (action.title === "Agent blocked for 2026-06-13") {
            throw new Error(`Cookie: sid=${publishSecret}; path G:\\pi-harness\\comment.log`);
          }

          publishedActions.push(action);
          return { action, id: `item-${publishedActions.length}` };
        }
      }
    });

    expect(report.status).toBe("blocked");
    expect(report.entries.map((entry) => `${entry.role}:${entry.phase}:${entry.status}`)).toEqual([
      "librarian:nightly-ingest:completed",
      "scholar:morning-plan:blocked",
      "nutritionist:daily-meals:completed",
      "scholar:evening-mastery:completed"
    ]);
    expect(report.blockers).toHaveLength(1);
    expect(report.publishFailures).toHaveLength(1);
    expect(report.blockers[0]?.body).toContain("Authorization: Bearer REDACTED");
    expect(report.blockers[0]?.body).not.toContain(readSecret);
    expect(report.blockers[0]?.body).not.toContain("/home/holly");
    expect(report.publishFailures[0]?.message).toContain("Cookie: REDACTED");
    expect(report.publishFailures[0]?.message).not.toContain(publishSecret);
    expect(report.publishFailures[0]?.message).not.toContain("G:\\pi-harness");
    expect(report.entries[1]?.publishFailures).toHaveLength(1);
    expect(report.totals).toEqual({
      reads: 3,
      publishedActions: 3,
      blockers: 1,
      publishFailures: 1
    });
    expect(publishedActions.map((action) => action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
  });

  test("live day execution records a normal publish failure and continues independent later agents", async () => {
    const publishSecret = "publish-secret-token";
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });
    const publishedActions: AgentIntendedAction[] = [];

    const report = await executeAgentDay(plan, "live", {
      readClient: {
        async read(endpoint) {
          return { endpoint, status: 200, body: successfulReadBodyFor(endpoint) };
        }
      },
      boardClient: {
        async publish(action) {
          if (action.title === "Scholar study plan for 2026-06-13") {
            throw new Error(`Authorization: Bearer ${publishSecret} at G:\\multica\\tasks.log`);
          }

          publishedActions.push(action);
          return { action, id: `item-${publishedActions.length}` };
        }
      }
    });

    expect(report.status).toBe("blocked");
    expect(report.entries.map((entry) => `${entry.role}:${entry.phase}:${entry.status}`)).toEqual([
      "librarian:nightly-ingest:completed",
      "scholar:morning-plan:blocked",
      "nutritionist:daily-meals:completed",
      "scholar:evening-mastery:completed"
    ]);
    expect(report.blockers).toEqual([]);
    expect(report.publishFailures).toHaveLength(1);
    expect(report.publishFailures[0]?.message).toContain("Authorization: Bearer REDACTED");
    expect(report.publishFailures[0]?.message).not.toContain(publishSecret);
    expect(report.publishFailures[0]?.message).not.toContain("G:\\multica");
    expect(report.entries[1]?.publishFailures).toHaveLength(1);
    expect(report.totals).toEqual({
      reads: 4,
      publishedActions: 3,
      blockers: 0,
      publishFailures: 1
    });
    expect(publishedActions.map((action) => action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
  });
});

function successfulReadBodyFor(endpoint: AgentEndpointPlan): Record<string, unknown> {
  if (new URL(endpoint.url).pathname === "/api/mastery/summary") {
    return {
      ok: true,
      routeId: "mastery.summary",
      data: {
        masteryRows: [],
        diagnosis: {
          weakSpots: []
        }
      }
    };
  }

  return { ok: true, url: endpoint.url };
}
