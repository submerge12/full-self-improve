import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { validateBoardDayEvidence } from "./board-day-evidence.js";

const projectRoot = process.cwd();

describe("M2 board-day evidence", () => {
  test("checked-in example records offline observations for two expected board days", async () => {
    const manifest = await readJson("config/multica/live-smoke.example.json");
    const evidence = await readJson("config/multica/board-day-evidence.example.json");

    const result = validateBoardDayEvidence(evidence, manifest);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "board-day evidence is offline observed evidence only; it does not prove hands-free execution or close M2."
    ]);
    expect(result.summary).toEqual({
      contractStatus: "observed_live_smoke_pending_verification",
      evidenceMode: "offline-observation-only",
      requiredDays: 2,
      observedItems: [
        "2026-06-14 librarian:nightly-ingest:add_comment",
        "2026-06-14 scholar:morning-plan:create_task",
        "2026-06-14 nutritionist:daily-meals:create_task",
        "2026-06-14 coach:daily-health:add_comment",
        "2026-06-14 scholar:evening-mastery:add_comment",
        "2026-06-15 librarian:nightly-ingest:add_comment",
        "2026-06-15 scholar:morning-plan:create_task",
        "2026-06-15 nutritionist:daily-meals:create_task",
        "2026-06-15 coach:daily-health:add_comment",
        "2026-06-15 scholar:evening-mastery:add_comment"
      ]
    });
  });

  test("rejects missing expected items", async () => {
    const manifest = await readJson("config/multica/live-smoke.example.json");
    const evidence = await readEvidence();
    evidence.days[0]?.items.pop();

    expect(validateBoardDayEvidence(evidence, manifest).errors).toContain(
      "board-day evidence 2026-06-14 is missing scholar:evening-mastery:add_comment."
    );
  });

  test("rejects duplicate expected items", async () => {
    const manifest = await readJson("config/multica/live-smoke.example.json");
    const evidence = await readEvidence();
    const duplicate = structuredClone(evidence.days[0]?.items[0]);
    evidence.days[0]?.items.push(duplicate);

    expect(validateBoardDayEvidence(evidence, manifest).errors).toContain(
      "board-day evidence 2026-06-14 has duplicate item librarian:nightly-ingest:add_comment."
    );
  });

  test("rejects secret-like values and filesystem-like paths", async () => {
    const manifest = await readJson("config/multica/live-smoke.example.json");
    const evidence = await readEvidence();
    const item = evidence.days[0]?.items[0];
    if (item !== undefined) {
      item.sourceEndpoints = ["POST http://127.0.0.1:3000/api/ingest/run?token=real-token"];
      item.boardEvidence = {
        ...item.boardEvidence,
        commentUrl: "https://user:secret@example.invalid/issues/1#comment-2",
        sourceLinks: [
          "G:/knowledge-loop/private-note.md",
          "https://multica.example.invalid/workspaces/../private",
          "FILE:///tmp/private"
        ],
        token: "Bearer real-token"
      };
    }

    expect(validateBoardDayEvidence(evidence, manifest).errors).toEqual(
      expect.arrayContaining([
        "board-day evidence must not contain secret-like key at days.0.items.0.boardEvidence.token.",
        "board-day evidence must not contain secret-like value at days.0.items.0.sourceEndpoints.0.",
        "board-day evidence must not contain secret-like value at days.0.items.0.boardEvidence.commentUrl.",
        "board-day evidence must not contain filesystem-like value at days.0.items.0.boardEvidence.sourceLinks.0.",
        "board-day evidence must not contain filesystem-like value at days.0.items.0.boardEvidence.sourceLinks.1.",
        "board-day evidence must not contain filesystem-like value at days.0.items.0.boardEvidence.sourceLinks.2.",
        "board-day evidence days.0.items.0.boardEvidence.commentUrl must not include URL credentials."
      ])
    );
  });

  test("rejects credentials in method-prefixed source endpoint URLs", async () => {
    const manifest = (await readJson("config/multica/live-smoke.example.json")) as {
      evidence: { days: Array<{ items: Array<{ requiredSourceEndpoints: string[] }> }> };
    };
    const evidence = await readEvidence();
    const endpoint = "GET https://user:secret@example.invalid/api/plan";
    const manifestItem = manifest.evidence.days[0]?.items[1];
    const evidenceItem = evidence.days[0]?.items[1];
    if (manifestItem !== undefined && evidenceItem !== undefined) {
      manifestItem.requiredSourceEndpoints = [endpoint];
      evidenceItem.sourceEndpoints = [endpoint];
    }

    expect(validateBoardDayEvidence(evidence, manifest).errors).toEqual(
      expect.arrayContaining([
        "board-day evidence must not contain secret-like value at days.0.items.1.sourceEndpoints.0.",
        "board-day evidence must not contain secret-like value at referenceManifest.evidence.days.0.items.1.requiredSourceEndpoints.0."
      ])
    );
  });

  test("rejects fake closure fields and completed contract status", async () => {
    const manifest = await readJson("config/multica/live-smoke.example.json");
    const evidence = await readEvidence();
    const closedEvidence = {
      ...evidence,
      contractStatus: "verified",
      status: "completed",
      m2Closed: true,
      m2Complete: true,
      handsFreeComplete: true,
      handsFreeVerified: true,
      closureStatus: "passed"
    };

    expect(validateBoardDayEvidence(closedEvidence, manifest).errors).toEqual(
      expect.arrayContaining([
        "board-day evidence contractStatus must remain observed_live_smoke_pending_verification.",
        "board-day evidence must not contain fake closure status at status.",
        "board-day evidence must not contain fake closure field m2Closed.",
        "board-day evidence must not contain fake closure field m2Complete.",
        "board-day evidence must not contain fake closure field handsFreeComplete.",
        "board-day evidence must not contain fake closure field handsFreeVerified.",
        "board-day evidence must not contain fake closure status at closureStatus."
      ])
    );
  });

  test("rejects required board evidence fields with placeholder shapes", async () => {
    const manifest = await readJson("config/multica/live-smoke.example.json");
    const evidence = await readEvidence();
    const commentItem = evidence.days[0]?.items[0];
    const taskItem = evidence.days[0]?.items[1];
    if (commentItem !== undefined) {
      commentItem.boardEvidence = {
        ...commentItem.boardEvidence,
        commentUrl: true,
        sourceLinks: [],
        conceptCounts: "ok"
      };
    }
    if (taskItem !== undefined) {
      taskItem.boardEvidence = {
        ...taskItem.boardEvidence,
        taskUrl: "not a url",
        checklist: []
      };
    }

    expect(validateBoardDayEvidence(evidence, manifest).errors).toEqual(
      expect.arrayContaining([
        "board-day evidence 2026-06-14 librarian:nightly-ingest:add_comment boardEvidence.commentUrl must be an http or https URL string.",
        "board-day evidence 2026-06-14 librarian:nightly-ingest:add_comment boardEvidence.sourceLinks must be a non-empty array of http or https URL strings.",
        "board-day evidence 2026-06-14 librarian:nightly-ingest:add_comment boardEvidence.conceptCounts must be a non-empty object with finite numeric values.",
        "board-day evidence 2026-06-14 scholar:morning-plan:create_task boardEvidence.taskUrl must be an http or https URL string.",
        "board-day evidence 2026-06-14 scholar:morning-plan:create_task boardEvidence.checklist must be a non-empty array of non-empty strings."
      ])
    );
  });

  test("rejects items missing required board evidence from the manifest", async () => {
    const manifest = await readJson("config/multica/live-smoke.example.json");
    const evidence = await readEvidence();
    const item = evidence.days[1]?.items[2];
    if (item !== undefined) {
      delete item.boardEvidence.mealChecklist;
    }

    expect(validateBoardDayEvidence(evidence, manifest).errors).toContain(
      "board-day evidence 2026-06-15 nutritionist:daily-meals:create_task missing boardEvidence.mealChecklist."
    );
  });

  test("rejects non-array source endpoint evidence without throwing", async () => {
    const manifest = await readJson("config/multica/live-smoke.example.json");
    const evidence = await readEvidence();
    const item = evidence.days[0]?.items[0] as { sourceEndpoints?: unknown } | undefined;
    if (item !== undefined) {
      item.sourceEndpoints = "POST http://127.0.0.1:3000/api/ingest/run?adapter=holly-vault";
    }

    expect(validateBoardDayEvidence(evidence, manifest).errors).toContain(
      "board-day evidence 2026-06-14 librarian:nightly-ingest:add_comment sourceEndpoints must be an array."
    );
  });

  test("rejects malformed manifest days and items without throwing", async () => {
    const evidence = await readEvidence();
    const manifest = {
      requiredConsecutiveDays: 2,
      evidence: {
        days: [
          null,
          {
            date: "2026-06-15",
            items: [null]
          }
        ]
      }
    };

    expect(validateBoardDayEvidence(evidence, manifest).errors).toEqual(
      expect.arrayContaining([
        "board-day evidence reference manifest days must be consecutive.",
        "board-day evidence reference manifest day 0 must include date and items.",
        "board-day evidence reference manifest 2026-06-15 has malformed item."
      ])
    );
  });

  test("rejects evidence that drifts from manifest titles, actions, dates, and endpoints", async () => {
    const manifest = await readJson("config/multica/live-smoke.example.json");
    const evidence = await readEvidence();
    const day = evidence.days[1];
    const item = evidence.days[0]?.items[1];
    if (day !== undefined) {
      day.date = "2026-06-16";
    }
    if (item !== undefined) {
      item.title = "Scholar study plan drift";
      item.actionType = "add_comment";
      item.sourceEndpoints = ["GET http://127.0.0.1:3000/api/plan/different"];
    }

    expect(validateBoardDayEvidence(evidence, manifest).errors).toEqual(
      expect.arrayContaining([
        "board-day evidence day 1 date must match manifest date 2026-06-15.",
        "board-day evidence 2026-06-14 has unexpected item scholar:morning-plan:add_comment.",
        "board-day evidence 2026-06-14 is missing scholar:morning-plan:create_task."
      ])
    );
  });
});

async function readEvidence(): Promise<{
  days: Array<{
    date: string;
    items: Array<{
      role: string;
      phase: string;
      actionType: string;
      title: string;
      sourceEndpoints: string[];
      boardEvidence: Record<string, unknown>;
    }>;
  }>;
}> {
  return structuredClone(await readJson("config/multica/board-day-evidence.example.json")) as {
    days: Array<{
      date: string;
      items: Array<{
        role: string;
        phase: string;
        actionType: string;
        title: string;
        sourceEndpoints: string[];
        boardEvidence: Record<string, unknown>;
      }>;
    }>;
  };
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readProjectFile(relativePath)) as unknown;
}

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}
