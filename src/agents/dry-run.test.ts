import { describe, expect, test } from "vitest";

import { createAgentDryRunPlan, parseAgentPhase, parseAgentRole } from "./dry-run.js";

describe("agent dry-run profiles", () => {
  test("Librarian dry-run plans the ingest report without external writes", () => {
    const plan = createAgentDryRunPlan({
      role: "librarian",
      date: "2026-06-13",
      knowledgeLoopBaseUrl: "http://knowledge-loop.local/",
      adapterId: "holly-vault",
      multicaBoard: "Holly Daily"
    });

    expect(plan).toMatchObject({
      mode: "dry-run",
      role: "librarian",
      phase: "nightly-ingest",
      date: "2026-06-13",
      multicaBoard: "Holly Daily",
      externalWrites: [],
      llmCost: { estimatedUsd: 0, source: "dry-run-no-llm" }
    });
    expect(plan.externalReads).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "http://knowledge-loop.local/api/ingest/run?adapter=holly-vault"
      })
    ]);
    expect(plan.intendedActions).toEqual([
      expect.objectContaining({
        target: "multica",
        type: "add_comment",
        title: "Librarian ingest report for 2026-06-13",
        checklist: ["Run ingest", "Post count summary", "Link trace/run id", "Escalate source failures"]
      })
    ]);
  });

  test("Scholar morning dry-run plans a Multica task from the plan endpoint", () => {
    const plan = createAgentDryRunPlan({
      role: "scholar",
      phase: "morning-plan",
      date: "2026-06-13",
      knowledgeLoopBaseUrl: "http://127.0.0.1:3124"
    });

    expect(plan.externalReads).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "http://127.0.0.1:3124/api/plan/today"
      })
    ]);
    expect(plan.intendedActions[0]).toMatchObject({
      type: "create_task",
      title: "Scholar study plan for 2026-06-13",
      checklist: ["Review learn activities", "Complete quiz activities", "Submit teach-back activities"]
    });
  });

  test("Scholar evening dry-run plans a mastery summary comment", () => {
    const plan = createAgentDryRunPlan({
      role: "scholar",
      phase: "evening-mastery",
      date: "2026-06-13"
    });

    expect(plan.externalReads).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "http://127.0.0.1:3000/api/mastery/summary"
      })
    ]);
    expect(plan.intendedActions[0]).toMatchObject({
      type: "add_comment",
      title: "Scholar mastery report for 2026-06-13",
      checklist: ["Fetch mastery summary", "Summarize weak spots", "Post evening delta"]
    });
  });

  test("Nutritionist dry-run plans a read-only compass-health meal fetch", () => {
    const plan = createAgentDryRunPlan({
      role: "nutritionist",
      date: "2026-06-13",
      compassHealthBaseUrl: "http://compass.local/"
    });

    expect(plan.phase).toBe("daily-meals");
    expect(plan.externalReads).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "http://compass.local/api/meal-plan/today?date=2026-06-13"
      })
    ]);
    expect(plan.intendedActions[0]).toMatchObject({
      type: "create_task",
      title: "Nutrition plan for 2026-06-13",
      checklist: ["Fetch meals", "Post meal checklist", "Post shopping list"]
    });
  });

  test("agent dry-run rejects invalid roles, phases, combinations, and dates", () => {
    expect(() => parseAgentRole("coach")).toThrow(/Invalid agent role/);
    expect(() => parseAgentPhase("nightly")).toThrow(/Invalid agent phase/);
    expect(() =>
      createAgentDryRunPlan({ role: "librarian", phase: "morning-plan", date: "2026-06-13" })
    ).toThrow(/cannot run phase/);
    expect(() => createAgentDryRunPlan({ role: "scholar", phase: "morning-plan", date: "2026-02-31" })).toThrow(
      /Invalid agent date/
    );
  });
});
