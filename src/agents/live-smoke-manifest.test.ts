import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createAgentDayDryRunPlan } from "./dry-run.js";
import { validateLiveSmokeManifest } from "./live-smoke-manifest.js";

const projectRoot = process.cwd();

describe("M2 live-smoke manifest", () => {
  test("checked-in example defines offline evidence for two board days", async () => {
    const manifest = JSON.parse(await readProjectFile("config/multica/live-smoke.example.json")) as unknown;
    const plan = createAgentDayDryRunPlan({ date: "2026-06-14", multicaBoard: "daily-plan" });

    const result = validateLiveSmokeManifest(manifest, plan);

    expect(result.errors).toEqual([]);
    expect(result.summary).toEqual({
      contractStatus: "inferred_live_smoke_pending",
      requiredDays: 2,
      expectedItems: [
        "librarian:nightly-ingest:add_comment",
        "scholar:morning-plan:create_task",
        "nutritionist:daily-meals:create_task",
        "coach:daily-health:add_comment",
        "scholar:evening-mastery:add_comment"
      ]
    });
  });

  test("rejects secrets, filesystem paths, and non-http evidence URLs", () => {
    const plan = createAgentDayDryRunPlan({ date: "2026-06-14" });
    const unsafeManifest = {
      contractStatus: "inferred_live_smoke_pending",
      requiredConsecutiveDays: 2,
      boardPublishConfig: "config/multica/board-publish.example.json",
      smokeMode: "offline-contract-only",
      evidence: {
        days: [
          {
            date: "2026-06-14",
            items: [
              {
                role: "scholar",
                phase: "morning-plan",
                actionType: "create_task",
                title: "Scholar study plan for 2026-06-14",
                requiredSourceEndpoints: ["GET file:///G:/knowledge-loop/api/plan/today?token=leaked"],
                requiredBoardEvidence: ["taskUrl"]
              }
            ]
          }
        ]
      }
    };

    expect(validateLiveSmokeManifest(unsafeManifest, plan).errors).toEqual(expect.arrayContaining([
      "live smoke manifest 2026-06-14 scholar:morning-plan:create_task requiredSourceEndpoints entry must be an http or https URL.",
      "live smoke manifest must not contain secret-like value at evidence.days.0.items.0.requiredSourceEndpoints.0.",
      "live smoke manifest must not contain filesystem-like value at evidence.days.0.items.0.requiredSourceEndpoints.0."
    ]));
  });

  test("rejects manifests that omit any planned board-day action", async () => {
    const manifest = JSON.parse(await readProjectFile("config/multica/live-smoke.example.json")) as {
      evidence: { days: Array<{ items: unknown[] }> };
    };
    manifest.evidence.days[0]?.items.pop();
    const plan = createAgentDayDryRunPlan({ date: "2026-06-14", multicaBoard: "daily-plan" });

    expect(validateLiveSmokeManifest(manifest, plan).errors).toContain(
      "live smoke manifest day 2026-06-14 is missing scholar:evening-mastery:add_comment."
    );
  });

  test("rejects non-consecutive board days", async () => {
    const manifest = JSON.parse(await readProjectFile("config/multica/live-smoke.example.json")) as {
      evidence: { days: Array<{ date: string }> };
    };
    if (manifest.evidence.days[1] !== undefined) {
      manifest.evidence.days[1].date = "2026-06-16";
    }
    const plan = createAgentDayDryRunPlan({ date: "2026-06-14", multicaBoard: "daily-plan" });

    expect(validateLiveSmokeManifest(manifest, plan).errors).toContain(
      "live smoke manifest evidence.days must be consecutive daily dates."
    );
  });

  test("returns actionable errors for malformed day entries", () => {
    const manifest = {
      contractStatus: "inferred_live_smoke_pending",
      requiredConsecutiveDays: 2,
      boardPublishConfig: "config/multica/board-publish.example.json",
      smokeMode: "offline-contract-only",
      evidence: {
        days: [
          null,
          { date: "2026-06-14" },
          { date: "2026-06-15", items: ["bad-item"] },
          {
            date: "2026-06-16",
            items: [
              {
                role: "scholar",
                phase: "morning-plan",
                actionType: "create_task",
                title: "Scholar study plan for 2026-06-16",
                requiredSourceEndpoints: ["GET http://127.0.0.1:3000/api/plan/today"]
              }
            ]
          },
          {
            date: "2026-06-17",
            items: [
              {
                role: "scholar",
                phase: "morning-plan",
                actionType: "create_task",
                title: "Scholar study plan for 2026-06-17",
                requiredBoardEvidence: ["taskUrl"]
              }
            ]
          }
        ]
      },
      nonCompletionNotice: "This offline contract does not execute Multica."
    };
    const plan = createAgentDayDryRunPlan({ date: "2026-06-14", multicaBoard: "daily-plan" });

    expect(() => validateLiveSmokeManifest(manifest, plan)).not.toThrow();
    expect(validateLiveSmokeManifest(manifest, plan).errors).toEqual(
      expect.arrayContaining([
        "live smoke manifest day 0 must be a JSON object.",
        "live smoke manifest day 2026-06-14 items must be an array.",
        "live smoke manifest day 2026-06-15 item 0 must be a JSON object.",
        "live smoke manifest 2026-06-16 scholar:morning-plan:create_task requiredBoardEvidence must be an array.",
        "live smoke manifest 2026-06-17 scholar:morning-plan:create_task requiredSourceEndpoints must be an array."
      ])
    );
  });

  test("rejects extra board-day actions even when their URLs are http", async () => {
    const manifest = JSON.parse(await readProjectFile("config/multica/live-smoke.example.json")) as {
      evidence: { days: Array<{ items: unknown[] }> };
    };
    manifest.evidence.days[0]?.items.push({
      role: "scholar",
      phase: "morning-plan",
      actionType: "create_task",
      title: "Unexpected external task",
      requiredSourceEndpoints: ["GET https://example.com/external"],
      requiredBoardEvidence: ["taskUrl"]
    });
    const plan = createAgentDayDryRunPlan({ date: "2026-06-14", multicaBoard: "daily-plan" });

    expect(validateLiveSmokeManifest(manifest, plan).errors).toEqual(
      expect.arrayContaining([
        "live smoke manifest day 2026-06-14 has unexpected duplicate item scholar:morning-plan:create_task.",
        "live smoke manifest 2026-06-14 scholar:morning-plan:create_task source endpoints must match the dry-run action."
      ])
    );
  });
});

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}
