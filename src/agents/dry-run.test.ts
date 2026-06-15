import { describe, expect, test } from "vitest";

import {
  AGENT_PHASES,
  AGENT_ROLES,
  createAgentDayDryRunPlan,
  createAgentDryRunPlan,
  parseAgentPhase,
  parseAgentRole
} from "./dry-run.js";

describe("agent dry-run profiles", () => {
  test("defines Task7 roles and phases including Coach daily health", () => {
    expect(AGENT_ROLES).toEqual(["librarian", "scholar", "nutritionist", "coach"]);
    expect(AGENT_PHASES).toContain("daily-health");
    expect(parseAgentRole("coach")).toBe("coach");
    expect(parseAgentPhase("daily-health")).toBe("daily-health");
    expect(createAgentDryRunPlan({ role: "coach", date: "2026-06-14" }).phase).toBe("daily-health");
  });

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

  test("Nutritionist dry-run plans compass-health meal and procurement reads", () => {
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
      }),
      expect.objectContaining({
        method: "POST",
        url: "http://compass.local/api/meal-engine/procurement",
        jsonBody: { start_date: "2026-06-13" },
        purpose: expect.stringMatching(/shopping|procurement/i)
      })
    ]);
    expect(plan.intendedActions[0]).toMatchObject({
      type: "create_task",
      title: "Nutrition plan for 2026-06-13",
      checklist: ["Fetch meals", "Post meal checklist", "Post shopping list"]
    });
    expect(plan.intendedActions[0]?.sourceEndpoints).toEqual([
      "GET http://compass.local/api/meal-plan/today?date=2026-06-13",
      "POST http://compass.local/api/meal-engine/procurement"
    ]);
  });

  test("Nutritionist dry-run supports a configurable meal read URL template", () => {
    const plan = createAgentDryRunPlan({
      role: "nutritionist",
      date: "2026-06-13",
      compassHealthBaseUrl: "http://compass.local/",
      nutritionistMealReadUrlTemplate: "/api/meal-plan/week?date={date}"
    });

    expect(plan.externalReads).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "http://compass.local/api/meal-plan/week?date=2026-06-13"
      }),
      expect.objectContaining({
        method: "POST",
        url: "http://compass.local/api/meal-engine/procurement",
        jsonBody: { start_date: "2026-06-13" }
      })
    ]);
    expect(plan.intendedActions[0]?.sourceEndpoints).toEqual([
      "GET http://compass.local/api/meal-plan/week?date=2026-06-13",
      "POST http://compass.local/api/meal-engine/procurement"
    ]);
  });

  test("Nutritionist dry-run rejects URL templates with backslash host escapes", () => {
    expect(() =>
      createAgentDryRunPlan({
        role: "nutritionist",
        date: "2026-06-13",
        compassHealthBaseUrl: "http://compass.local/",
        nutritionistMealReadUrlTemplate: "/\\evil.example/api/meal-plan/week?date={date}"
      })
    ).toThrow(/nutritionistMealReadUrlTemplate must be an http\(s\) URL or a root-relative URL path/);
  });

  test("Coach daily-health dry-run plans the deterministic health digest comment without external writes", () => {
    const plan = createAgentDryRunPlan({
      role: "coach",
      phase: "daily-health",
      date: "2026-06-14"
    });

    expect(plan).toMatchObject({
      mode: "dry-run",
      role: "coach",
      phase: "daily-health",
      date: "2026-06-14",
      multicaBoard: "daily-plan",
      externalWrites: [],
      llmCost: { estimatedUsd: 0, source: "dry-run-no-llm" }
    });
    expect(plan.externalReads).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:3000/api/health/coach-digest/generate",
        purpose: "Generate the deterministic daily health digest for Coach.",
        jsonBody: { date: "2026-06-14", offline: true }
      }
    ]);
    expect(plan.intendedActions).toEqual([
      expect.objectContaining({
        target: "multica",
        type: "add_comment",
        title: "Coach health digest for 2026-06-14",
        checklist: ["Generate health digest", "Post digest", "Record source hash"],
        sourceEndpoints: ["POST http://127.0.0.1:3000/api/health/coach-digest/generate"]
      })
    ]);
    expect(plan.intendedActions[0]?.body).toContain("Dry-run target board: daily-plan.");
    expect(plan.intendedActions[0]?.body).toContain(
      "When live, Coach posts metrics, exercise, sedentary, and compass HTTP context."
    );
  });

  test("agent dry-run rejects invalid roles, phases, combinations, and dates", () => {
    expect(() => parseAgentRole("mentor")).toThrow(/Invalid agent role/);
    expect(() => parseAgentPhase("nightly")).toThrow(/Invalid agent phase/);
    expect(() =>
      createAgentDryRunPlan({ role: "librarian", phase: "morning-plan", date: "2026-06-13" })
    ).toThrow(/cannot run phase/);
    expect(() => createAgentDryRunPlan({ role: "scholar", phase: "morning-plan", date: "2026-02-31" })).toThrow(
      /Invalid agent date/
    );
  });

  test("day dry-run sequences the M2 board-day roles without external writes", () => {
    const plan = createAgentDayDryRunPlan({
      date: "2026-06-13",
      knowledgeLoopBaseUrl: "http://127.0.0.1:3124",
      compassHealthBaseUrl: "http://compass.local",
      multicaBoard: "Holly Daily"
    });

    expect(plan).toMatchObject({
      mode: "dry-run",
      date: "2026-06-13",
      multicaBoard: "Holly Daily",
      externalWrites: [],
      llmCost: { estimatedUsd: 0, source: "dry-run-no-llm" }
    });
    expect(plan.sequence.map((entry) => `${entry.role}:${entry.phase}`)).toEqual([
      "librarian:nightly-ingest",
      "scholar:morning-plan",
      "nutritionist:daily-meals",
      "coach:daily-health",
      "scholar:evening-mastery"
    ]);
    expect(plan.externalReads.map((read) => `${read.method} ${read.url}`)).toEqual([
      "POST http://127.0.0.1:3124/api/ingest/run?adapter=holly-vault",
      "GET http://127.0.0.1:3124/api/plan/today",
      "GET http://compass.local/api/meal-plan/today?date=2026-06-13",
      "POST http://compass.local/api/meal-engine/procurement",
      "POST http://127.0.0.1:3124/api/health/coach-digest/generate",
      "GET http://127.0.0.1:3124/api/mastery/summary"
    ]);
    expect(plan.intendedActions.map((action) => action.title)).toEqual([
      "Librarian ingest report for 2026-06-13",
      "Scholar study plan for 2026-06-13",
      "Nutrition plan for 2026-06-13",
      "Coach health digest for 2026-06-13",
      "Scholar mastery report for 2026-06-13"
    ]);
  });
});
