import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { AGENT_ROLES, createAgentDryRunPlan, type AgentRole } from "./dry-run.js";
import { getM2AgentProfile, listM2AgentProfiles, validateM2AgentProfile } from "./profiles.js";

const projectRoot = process.cwd();

describe("M2 agent profiles", () => {
  test("define one safe profile for every M2 role in this repo", () => {
    const profiles = listM2AgentProfiles();

    expect(profiles.map((profile) => profile.role).sort()).toEqual([...AGENT_ROLES].sort());
    for (const profile of profiles) {
      expect(profile.name).toMatch(/^knowledge-loop-(librarian|scholar|nutritionist)$/u);
      expect(profile.description.length).toBeGreaterThan(20);
      expect(profile.systemPrompt).toContain("knowledge-loop");
      expect(profile.systemPrompt).toContain("Dry-run");
      expect(profile.dryRunCommand).toContain("--dry-run");
      expect(profile.policy.defaults["read-only"]).toBe("allow");
      expect(profile.policy.defaults.write).not.toBe("allow");
      expect(profile.policy.defaults.destructive).toBe("deny");
      expect(profile.policy.defaults.network).toBe("ask");
      expect(validateM2AgentProfile(profile)).toEqual([]);
    }
  });

  test("profile phases align with existing dry-run plan defaults", () => {
    for (const role of AGENT_ROLES) {
      const profile = getM2AgentProfile(role);
      const defaultPlan = createAgentDryRunPlan({ role, date: "2026-06-13" });

      expect(profile.supportedPhases).toContain(defaultPlan.phase);
      expect(profile.dryRunCommand).toEqual([
        "npm",
        "run",
        "kl",
        "--",
        "agent",
        "--dry-run",
        "--role",
        role,
        "--date",
        "<YYYY-MM-DD>"
      ]);
    }
  });

  test("profiles do not embed secrets or frozen repo paths", () => {
    const serialized = JSON.stringify(listM2AgentProfiles());

    expect(serialized).not.toMatch(/api[_-]?key|bearer|token|secret|cookie/iu);
    expect(serialized).not.toMatch(/[A-Z]:[\\/]/u);
    expect(serialized).not.toContain("G:/");
    expect(serialized).not.toContain("G:\\");
  });

  test("rejects unsafe profile policy defaults", () => {
    const unsafeProfile = {
      ...getM2AgentProfile("scholar"),
      policy: {
        defaults: {
          "read-only": "allow",
          write: "allow",
          destructive: "allow",
          network: "allow"
        }
      }
    } as const;

    expect(validateM2AgentProfile(unsafeProfile)).toEqual([
      "knowledge-loop-scholar must not allow write by default.",
      "knowledge-loop-scholar must deny destructive by default.",
      "knowledge-loop-scholar must ask before network access."
    ]);
  });
});

describe("M2 agent and Multica config examples", () => {
  test("agent config example covers every role without secret fields", async () => {
    const config = JSON.parse(await readProjectFile("config/agents.example.json")) as {
      roles: Record<AgentRole, { phases: readonly string[]; dryRun: boolean }>;
    };

    expect(Object.keys(config.roles).sort()).toEqual([...AGENT_ROLES].sort());
    expect(JSON.stringify(config)).not.toMatch(/api[_-]?key|bearer|token|secret|cookie/iu);
    expect(config.roles.librarian.phases).toEqual(["nightly-ingest"]);
    expect(config.roles.scholar.phases).toEqual(["morning-plan", "evening-mastery"]);
    expect(config.roles.nutritionist.phases).toEqual(["daily-meals"]);
    expect(Object.values(config.roles).every((role) => role.dryRun)).toBe(true);
  });

  test("Multica publish config example uses explicit HTTP endpoints and no filesystem paths", async () => {
    const config = JSON.parse(await readProjectFile("config/multica/board-publish.example.json")) as {
      contractStatus: string;
      actions: {
        create_task: { endpointUrl: string };
        add_comment: { endpointTemplate: string };
      };
    };

    expect(config.contractStatus).toBe("inferred_live_smoke_pending");
    expect(config.actions.create_task.endpointUrl).toBe("http://127.0.0.1:8080/api/issues");
    expect(config.actions.add_comment.endpointTemplate).toBe(
      "http://127.0.0.1:8080/api/issues/{issueId}/comments"
    );
    expect(JSON.stringify(config)).not.toMatch(/[A-Z]:[\\/]/u);
    expect(JSON.stringify(config)).not.toMatch(/api[_-]?key|bearer|token|secret|cookie/iu);
  });

  test("Multica self-host env example keeps secrets empty", async () => {
    const envExample = await readProjectFile("config/multica/selfhost.env.example");

    expect(envExample).toContain("MULTICA_API_BASE_URL=http://127.0.0.1:8080");
    expect(envExample).toContain("MULTICA_APP_BASE_URL=http://127.0.0.1:3000");
    expect(envExample).toContain("MULTICA_BEARER_TOKEN=");
    expect(envExample).not.toMatch(/^MULTICA_BEARER_TOKEN=.+$/mu);
    expect(envExample).not.toMatch(/[A-Z]:[\\/]/u);
  });

  test("M2 runbook documents external Multica startup without patch instructions", async () => {
    const runbook = await readProjectFile("docs/runbooks/m2-multica.md");

    expect(runbook).toContain("G:\\multica-ai-multica-https-github-com");
    expect(runbook).toContain("docker compose -f docker-compose.selfhost.yml up -d");
    expect(runbook).toContain("npm run kl -- agent-day --dry-run");
    expect(runbook).toContain("Do not modify the Multica repository");
    expect(runbook).not.toMatch(/git\s+apply|patch\s+-p|new-agent/iu);
    expect(runbook).not.toMatch(/Copy-Item|Move-Item|Set-Content|Out-File|New-Item|Remove-Item|mkdir|copy\s+/iu);
  });
});

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}
