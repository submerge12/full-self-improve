import { describe, expect, test } from "vitest";

import { createAgentDryRunPlan, type AgentEndpointPlan, type AgentIntendedAction } from "./dry-run.js";
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
      publishedActions: [],
      publishFailures: []
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

  test("live execution records a redacted publish failure for planned actions", async () => {
    const sourceSecret = "source-secret";
    const publishSecret = "publish-secret";
    const plan = {
      ...createAgentDryRunPlan({
        role: "scholar",
        phase: "morning-plan",
        date: "2026-06-13"
      }),
      intendedActions: [
        {
          target: "multica",
          type: "create_task",
          title: "Scholar study plan for 2026-06-13",
          body: "Study queue",
          checklist: ["Review learn activities"],
          sourceEndpoints: [`GET http://127.0.0.1:3000/api/plan/today?token=${sourceSecret}`]
        }
      ]
    } as const;

    const result = await executeAgentPlan(plan, "live", {
      readClient: {
        async read(endpoint) {
          return { endpoint, status: 200, body: { ok: true } };
        }
      },
      boardClient: {
        async publish() {
          throw new Error(`Authorization: Bearer ${publishSecret} at /home/holly/multica/comment.log`);
        }
      }
    });

    expect(result.status).toBe("blocked");
    expect(result.reads).toHaveLength(1);
    expect(result.publishedActions).toEqual([]);
    expect(result.publishFailures).toHaveLength(1);
    expect(result.publishFailures[0]?.message).toContain("Authorization: Bearer REDACTED");
    expect(result.publishFailures[0]?.message).not.toContain(publishSecret);
    expect(result.publishFailures[0]?.message).not.toContain("/home/holly");
    expect(result.publishFailures[0]?.action.sourceEndpoints).toEqual([
      "GET http://127.0.0.1:3000/api/plan/today?token=REDACTED"
    ]);
    expect(JSON.stringify(result.publishFailures[0]?.action)).not.toContain(sourceSecret);
  });

  test("live execution stops on read failure and publishes a blocker comment", async () => {
    const plan = createAgentDryRunPlan({
      role: "scholar",
      phase: "morning-plan",
      date: "2026-06-13"
    });
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
    expect(result.reads).toHaveLength(0);
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

  test("live evening Scholar report renders mastery summary data into the board comment", async () => {
    const plan = createAgentDryRunPlan({
      role: "scholar",
      phase: "evening-mastery",
      date: "2026-06-13"
    });
    const publishedActions: AgentIntendedAction[] = [];

    const result = await executeAgentPlan(plan, "live", {
      readClient: {
        async read(endpoint) {
          return {
            endpoint,
            status: 200,
            body: {
              ok: true,
              routeId: "mastery.summary",
              data: {
                masteryRows: [
                  {
                    conceptSlug: "retrieval-practice",
                    conceptName: "Retrieval Practice",
                    score: 0.72,
                    confidence: 0.8,
                    attemptsN: 3,
                    lastSeenAt: "2026-06-13T08:00:00.000Z"
                  }
                ],
                diagnosis: {
                  runId: "diagnose-20260613",
                  weakSpots: [
                    {
                      conceptSlug: "retrieval-practice",
                      conceptName: "Retrieval Practice",
                      score: 0.72,
                      confidence: 0.8,
                      attemptsN: 3,
                      lastSeenAt: "2026-06-13T08:00:00.000Z"
                    }
                  ]
                }
              }
            }
          };
        }
      },
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          return { action, id: "mastery-comment" };
        }
      }
    });

    expect(result.status).toBe("completed");
    expect(publishedActions).toHaveLength(1);
    expect(publishedActions[0]?.title).toBe("Scholar mastery report for 2026-06-13");
    expect(publishedActions[0]?.body).toContain("Mastery rows: 1");
    expect(publishedActions[0]?.body).toContain("Weak spots: 1");
    expect(publishedActions[0]?.body).toContain("Top weak spot: retrieval-practice (score 0.72)");
    expect(publishedActions[0]?.body).toContain("Diagnosis run: diagnose-20260613");
    expect(publishedActions[0]?.body).toContain("Source: GET http://127.0.0.1:3000/api/mastery/summary");
    expect(result.publishedActions[0]?.action.body).toBe(publishedActions[0]?.body);
  });

  test("live evening Scholar report publishes a blocker when the mastery summary body is malformed", async () => {
    const plan = createAgentDryRunPlan({
      role: "scholar",
      phase: "evening-mastery",
      date: "2026-06-13"
    });
    const publishedActions: AgentIntendedAction[] = [];

    const result = await executeAgentPlan(plan, "live", {
      readClient: {
        async read(endpoint) {
          return { endpoint, status: 200, body: { ok: true, routeId: "plan.today", data: {} } };
        }
      },
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          return { action, id: "blocker-comment" };
        }
      }
    });

    expect(result.status).toBe("blocked");
    expect(result.reads).toHaveLength(1);
    expect(result.publishedActions).toHaveLength(1);
    expect(result.blocker?.title).toBe("Agent blocked for 2026-06-13");
    expect(result.blocker?.body).toContain("summaryBody must be a mastery.summary success body");
    expect(result.blocker?.sourceEndpoints).toEqual(["GET http://127.0.0.1:3000/api/mastery/summary"]);
    expect(publishedActions.map((action) => action.title)).toEqual(["Agent blocked for 2026-06-13"]);
  });

  test("live evening Scholar report blocks unwrapped mastery summary data", async () => {
    const plan = createAgentDryRunPlan({
      role: "scholar",
      phase: "evening-mastery",
      date: "2026-06-13"
    });
    const publishedActions: AgentIntendedAction[] = [];

    const result = await executeAgentPlan(plan, "live", {
      readClient: {
        async read(endpoint) {
          return { endpoint, status: 200, body: { masteryRows: [], diagnosis: { weakSpots: [] } } };
        }
      },
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          return { action, id: "blocker-comment" };
        }
      }
    });

    expect(result.status).toBe("blocked");
    expect(result.blocker?.body).toContain("summaryBody must be a mastery.summary success body");
    expect(publishedActions.map((action) => action.title)).toEqual(["Agent blocked for 2026-06-13"]);
  });

  test("live evening Scholar report ignores similar non-summary read endpoints", async () => {
    const plan = {
      ...createAgentDryRunPlan({
        role: "scholar",
        phase: "evening-mastery",
        date: "2026-06-13"
      }),
      externalReads: [
        {
          method: "GET",
          url: "http://127.0.0.1:3000/api/mastery/summary-preview",
          purpose: "A similar endpoint that must not be treated as the mastery summary."
        },
        {
          method: "GET",
          url: "http://127.0.0.1:3000/api/mastery/summary",
          purpose: "Fetch mastery rows and weak spots for the evening Scholar report."
        }
      ]
    } as const;
    const publishedActions: AgentIntendedAction[] = [];

    const result = await executeAgentPlan(plan, "live", {
      readClient: {
        async read(endpoint) {
          if (endpoint.url.endsWith("/api/mastery/summary-preview")) {
            return { endpoint, status: 200, body: { ok: true, routeId: "plan.today", data: {} } };
          }

          return {
            endpoint,
            status: 200,
            body: {
              ok: true,
              routeId: "mastery.summary",
              data: {
                masteryRows: [
                  {
                    conceptSlug: "exact-summary",
                    conceptName: "Exact Summary",
                    score: 0.5,
                    confidence: 0.6,
                    attemptsN: 1,
                    lastSeenAt: null
                  }
                ],
                diagnosis: { weakSpots: [] }
              }
            }
          };
        }
      },
      boardClient: {
        async publish(action) {
          publishedActions.push(action);
          return { action, id: "mastery-comment" };
        }
      }
    });

    expect(result.status).toBe("completed");
    expect(publishedActions).toHaveLength(1);
    expect(publishedActions[0]?.body).toContain("Rows: exact-summary / Exact Summary");
    expect(publishedActions[0]?.body).toContain("Source: GET http://127.0.0.1:3000/api/mastery/summary");
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
