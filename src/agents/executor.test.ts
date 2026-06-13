import { describe, expect, test } from "vitest";

import { createAgentDayDryRunPlan, createAgentDryRunPlan, type AgentEndpointPlan, type AgentIntendedAction } from "./dry-run.js";
import { executeAgentPlan, type AgentBoardClient, type AgentReadClient } from "./executor.js";

describe("agent executor", () => {
  test("dry-run execution does not call read or board clients", async () => {
    const plan = createAgentDryRunPlan({ role: "librarian", date: "2026-06-13" });
    const readClient: AgentReadClient = {
      async read() {
        throw new Error("read should not be called");
      }
    };
    const boardClient: AgentBoardClient = {
      async publish() {
        throw new Error("publish should not be called");
      }
    };

    await expect(executeAgentPlan(plan, "dry-run", { readClient, boardClient })).resolves.toEqual({
      mode: "dry-run",
      status: "planned",
      reads: [],
      publishedActions: []
    });
  });

  test("live execution reads endpoints then publishes planned actions", async () => {
    const plan = createAgentDryRunPlan({
      role: "scholar",
      phase: "morning-plan",
      date: "2026-06-13"
    });
    const readEndpoints: AgentEndpointPlan[] = [];
    const publishedActions: AgentIntendedAction[] = [];

    const result = await executeAgentPlan(plan, "live", {
      readClient: {
        async read(endpoint) {
          readEndpoints.push(endpoint);
          return { endpoint, status: 200, body: { ok: true } };
        }
      },
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          return { action, id: `published-${publishedActions.length}` };
        }
      }
    });

    expect(readEndpoints.map((endpoint) => endpoint.url)).toEqual(["http://127.0.0.1:3000/api/plan/today"]);
    expect(publishedActions.map((action) => action.title)).toEqual(["Scholar study plan for 2026-06-13"]);
    expect(result).toMatchObject({
      mode: "live",
      status: "completed",
      reads: [{ status: 200 }],
      publishedActions: [{ id: "published-1" }]
    });
  });

  test("live day execution stops on read failure and publishes a blocker comment", async () => {
    const plan = createAgentDayDryRunPlan({ date: "2026-06-13" });
    const publishedActions: AgentIntendedAction[] = [];

    const result = await executeAgentPlan(plan, "live", {
      readClient: {
        async read(endpoint) {
          if (endpoint.url.includes("/api/plan/today")) {
            throw new Error("knowledge-loop unavailable");
          }

          return { endpoint, status: 200, body: { ok: true } };
        }
      },
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          return { action, id: `published-${publishedActions.length}` };
        }
      }
    });

    expect(result.status).toBe("blocked");
    expect(result.reads).toHaveLength(1);
    expect(publishedActions).toHaveLength(1);
    expect(publishedActions[0]).toMatchObject({
      target: "multica",
      type: "add_comment",
      title: "Agent blocked for 2026-06-13",
      checklist: ["Inspect source endpoint", "Restore the source system", "Rerun the agent after the blocker is resolved"]
    });
    expect(publishedActions[0]?.body).toContain("knowledge-loop unavailable");
    expect(publishedActions[0]?.sourceEndpoints).toEqual(["GET http://127.0.0.1:3000/api/plan/today"]);
  });

  test("live execution requires injected clients", async () => {
    const plan = createAgentDryRunPlan({ role: "nutritionist", date: "2026-06-13" });

    await expect(executeAgentPlan(plan, "live")).rejects.toThrow(/requires readClient/);
    await expect(
      executeAgentPlan(plan, "live", {
        readClient: {
          async read(endpoint) {
            return { endpoint, status: 200, body: null };
          }
        }
      })
    ).rejects.toThrow(/requires boardClient/);
  });
});
