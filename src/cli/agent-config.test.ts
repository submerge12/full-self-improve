import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { handleKlCommand, type KlAgentDayDryRunCommandResult, type KlAgentDryRunCommandResult } from "./kl.js";

describe("kl agent config loading", () => {
  test("agent dry-run reads defaults from --config and lets flags override them", async () => {
    const result = (await handleKlCommand([
      "agent",
      "--dry-run",
      "--config",
      "config/agents.example.json",
      "--role",
      "scholar",
      "--phase",
      "morning-plan",
      "--date",
      "2026-06-13",
      "--knowledge-loop-url",
      "http://knowledge-loop.override/",
      "--board",
      "Override Board"
    ])) as KlAgentDryRunCommandResult;

    expect(result.result.multicaBoard).toBe("Override Board");
    expect(result.result.externalReads).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "http://knowledge-loop.override/api/plan/today"
      })
    ]);
  });

  test("agent-day dry-run reads service defaults from --config", async () => {
    const result = (await handleKlCommand([
      "agent-day",
      "--dry-run",
      "--config",
      "config/agents.example.json",
      "--date",
      "2026-06-13"
    ])) as KlAgentDayDryRunCommandResult;

    expect(result.result.multicaBoard).toBe("daily-plan");
    expect(result.result.externalReads.map((read) => `${read.method} ${read.url}`)).toEqual([
      "POST http://127.0.0.1:3000/api/ingest/run?adapter=holly-vault",
      "GET http://127.0.0.1:3000/api/plan/today",
      "GET http://127.0.0.1:8000/api/meal-plan/today?date=2026-06-13",
      "GET http://127.0.0.1:3000/api/mastery/summary"
    ]);
  });

  test("agent-day dry-run reads and overrides the Nutritionist meal read URL template", async () => {
    const previousCwd = process.cwd();
    const root = mkdtempSync(path.join(tmpdir(), "kl-agent-cli-meal-url-root-"));
    mkdirSync(path.join(root, "config"));
    writeFileSync(
      path.join(root, "config", "agents.json"),
      JSON.stringify({
        knowledgeLoopBaseUrl: "http://127.0.0.1:3124",
        compassHealthBaseUrl: "http://127.0.0.1:8000",
        nutritionistMealReadUrlTemplate: "/api/meal-plan/week?date={date}",
        roles: {
          nutritionist: {
            dryRun: true,
            phases: ["daily-meals"]
          }
        }
      }),
      "utf8"
    );

    try {
      process.chdir(root);
      const configDefault = (await handleKlCommand([
        "agent-day",
        "--dry-run",
        "--config",
        "config/agents.json",
        "--date",
        "2026-06-14"
      ])) as KlAgentDayDryRunCommandResult;
      const cliOverride = (await handleKlCommand([
        "agent-day",
        "--dry-run",
        "--config",
        "config/agents.json",
        "--date",
        "2026-06-14",
        "--nutritionist-meal-read-url-template",
        "http://meals.local/read?day={date}"
      ])) as KlAgentDayDryRunCommandResult;

      expect(configDefault.result.externalReads.map((read) => `${read.method} ${read.url}`)).toContain(
        "GET http://127.0.0.1:8000/api/meal-plan/week?date=2026-06-14"
      );
      expect(cliOverride.result.externalReads.map((read) => `${read.method} ${read.url}`)).toContain(
        "GET http://meals.local/read?day=2026-06-14"
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("agent commands reject duplicate or missing config options", async () => {
    await expect(
      handleKlCommand([
        "agent",
        "--dry-run",
        "--config",
        "config/agents.example.json",
        "--config",
        "config/agents.example.json",
        "--role",
        "librarian",
        "--date",
        "2026-06-13"
      ])
    ).rejects.toThrow(/requires exactly one --config/);

    await expect(handleKlCommand(["agent-day", "--dry-run", "--config", "--date", "2026-06-13"])).rejects.toThrow(
      /Option --config for agent-day requires a value/
    );
  });

  test("agent dry-run rejects unsafe CLI overrides even with a safe config", async () => {
    await expect(
      handleKlCommand([
        "agent",
        "--dry-run",
        "--config",
        "config/agents.example.json",
        "--role",
        "scholar",
        "--phase",
        "morning-plan",
        "--date",
        "2026-06-13",
        "--knowledge-loop-url",
        "file:///G:/knowledge-loop"
      ])
    ).rejects.toThrow(/knowledgeLoopBaseUrl must be an http or https URL/);

    await expect(
      handleKlCommand([
        "agent",
        "--dry-run",
        "--config",
        "config/agents.example.json",
        "--role",
        "scholar",
        "--phase",
        "morning-plan",
        "--date",
        "2026-06-13",
        "--knowledge-loop-url",
        "http://127.0.0.1:3000?token=leaked"
      ])
    ).rejects.toThrow(/knowledgeLoopBaseUrl must not contain secret-like value/);

    await expect(
      handleKlCommand([
        "agent",
        "--dry-run",
        "--config",
        "config/agents.example.json",
        "--role",
        "nutritionist",
        "--date",
        "2026-06-13",
        "--adapter",
        "..\\secret-vault"
      ])
    ).rejects.toThrow(/adapterId must not look like a filesystem path/);

    await expect(
      handleKlCommand([
        "agent-day",
        "--dry-run",
        "--config",
        "config/agents.example.json",
        "--date",
        "2026-06-13",
        "--adapter",
        "foo/bar"
      ])
    ).rejects.toThrow(/adapterId must not look like a filesystem path/);

    await expect(
      handleKlCommand([
        "agent-day",
        "--dry-run",
        "--config",
        "config/agents.example.json",
        "--date",
        "2026-06-13",
        "--board",
        "G:\\multica-ai-multica-https-github-com"
      ])
    ).rejects.toThrow(/multicaBoard must not look like a filesystem path/);

    await expect(
      handleKlCommand([
        "agent",
        "--dry-run",
        "--config",
        "config/agents.example.json",
        "--role",
        "librarian",
        "--date",
        "2026-06-13",
        "--adapter",
        "C:secret-vault"
      ])
    ).rejects.toThrow(/adapterId must not look like a filesystem path/);
  });

  test("agent dry-run uses config phase defaults while explicit phase still wins", async () => {
    const previousCwd = process.cwd();
    const root = mkdtempSync(path.join(tmpdir(), "kl-agent-cli-config-root-"));
    mkdirSync(path.join(root, "config"));
    writeFileSync(
      path.join(root, "config", "agents.json"),
      JSON.stringify({
        knowledgeLoopBaseUrl: "http://127.0.0.1:3000",
        roles: {
          scholar: {
            dryRun: true,
            phases: ["evening-mastery", "morning-plan"]
          }
        }
      }),
      "utf8"
    );

    try {
      process.chdir(root);
      const configDefault = (await handleKlCommand([
        "agent",
        "--dry-run",
        "--config",
        "config/agents.json",
        "--role",
        "scholar",
        "--date",
        "2026-06-13"
      ])) as KlAgentDryRunCommandResult;
      const cliOverride = (await handleKlCommand([
        "agent",
        "--dry-run",
        "--config",
        "config/agents.json",
        "--role",
        "scholar",
        "--phase",
        "morning-plan",
        "--date",
        "2026-06-13"
      ])) as KlAgentDryRunCommandResult;

      expect(configDefault.result.phase).toBe("evening-mastery");
      expect(configDefault.result.externalReads[0]?.url).toBe("http://127.0.0.1:3000/api/mastery/summary");
      expect(cliOverride.result.phase).toBe("morning-plan");
      expect(cliOverride.result.externalReads[0]?.url).toBe("http://127.0.0.1:3000/api/plan/today");
    } finally {
      process.chdir(previousCwd);
    }
  });
});
