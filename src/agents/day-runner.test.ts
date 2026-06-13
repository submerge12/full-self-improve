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
          return { endpoint, status: 200, body: { ok: true, url: endpoint.url } };
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

          return { endpoint, status: 200, body: { ok: true } };
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

          return { endpoint, status: 200, body: { ok: true } };
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
          return { endpoint, status: 200, body: { ok: true } };
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
