import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  loadAgentRuntimeConfig,
  resolveAgentDryRunDefaults,
  validateAgentRuntimeConfig
} from "./config.js";

describe("agent runtime config", () => {
  test("loads the checked-in example as dry-run defaults", () => {
    const config = loadAgentRuntimeConfig("config/agents.example.json");

    expect(resolveAgentDryRunDefaults(config)).toEqual({
      knowledgeLoopBaseUrl: "http://127.0.0.1:3000",
      compassHealthBaseUrl: "http://127.0.0.1:8000",
      adapterId: "holly-vault",
      multicaBoard: "daily-plan"
    });
    expect(config.roles.scholar?.phases).toEqual(["morning-plan", "evening-mastery"]);
  });

  test("rejects secret-like keys anywhere in agent config", () => {
    expect(() =>
      validateAgentRuntimeConfig({
        knowledgeLoopBaseUrl: "http://127.0.0.1:3000",
        roles: {},
        auth: {
          bearerToken: "not-allowed"
        }
      })
    ).toThrow(/must not contain secret-like key auth/);

    expect(() =>
      validateAgentRuntimeConfig({
        roles: {
          scholar: {
            dryRun: true,
            metadata: [{ clientSecret: "not-allowed" }]
          }
        }
      })
    ).toThrow(/must not contain secret-like key roles\.scholar\.metadata\.0\.clientSecret/);
  });

  test("rejects secret-like values anywhere in agent config", () => {
    expect(() =>
      validateAgentRuntimeConfig({
        knowledgeLoopBaseUrl: "http://127.0.0.1:3000/api?token=not-allowed",
        roles: {}
      })
    ).toThrow(/knowledgeLoopBaseUrl must not contain secret-like value/);

    expect(() =>
      validateAgentRuntimeConfig({
        adapterId: "api_key=not-allowed",
        roles: {}
      })
    ).toThrow(/adapterId must not contain secret-like value/);

    expect(() =>
      validateAgentRuntimeConfig({
        multicaBoard: "Authorization: Bearer not-allowed",
        roles: {}
      })
    ).toThrow(/multicaBoard must not contain secret-like value/);
  });

  test("rejects invalid service URLs and filesystem-shaped integration values", () => {
    expect(() =>
      validateAgentRuntimeConfig({
        knowledgeLoopBaseUrl: "file:///G:/knowledge-loop",
        roles: {}
      })
    ).toThrow(/knowledgeLoopBaseUrl must be an http or https URL/);

    expect(() =>
      validateAgentRuntimeConfig({
        knowledgeLoopBaseUrl: "http://127.0.0.1:3000",
        compassHealthBaseUrl: "G:\\compass-health",
        roles: {}
      })
    ).toThrow(/compassHealthBaseUrl must be an http or https URL/);

    expect(() =>
      validateAgentRuntimeConfig({
        knowledgeLoopBaseUrl: "localhost:3000",
        roles: {}
      })
    ).toThrow(/knowledgeLoopBaseUrl must be an http or https URL/);

    expect(() =>
      validateAgentRuntimeConfig({
        knowledgeLoopBaseUrl: "../api",
        roles: {}
      })
    ).toThrow(/knowledgeLoopBaseUrl must be an http or https URL/);

    expect(() =>
      validateAgentRuntimeConfig({
        adapterId: "G:\\dataset\\Holly dataset",
        roles: {}
      })
    ).toThrow(/adapterId must not look like a filesystem path/);

    expect(() =>
      validateAgentRuntimeConfig({
        multicaBoard: "/var/tmp/daily-plan",
        roles: {}
      })
    ).toThrow(/multicaBoard must not look like a filesystem path/);

    expect(() =>
      validateAgentRuntimeConfig({
        adapterId: "..\\holly-vault",
        roles: {}
      })
    ).toThrow(/adapterId must not look like a filesystem path/);

    expect(() =>
      validateAgentRuntimeConfig({
        adapterId: "foo/bar",
        roles: {}
      })
    ).toThrow(/adapterId must not look like a filesystem path/);

    expect(() =>
      validateAgentRuntimeConfig({
        multicaBoard: "foo\\bar",
        roles: {}
      })
    ).toThrow(/multicaBoard must not look like a filesystem path/);

    expect(() =>
      validateAgentRuntimeConfig({
        adapterId: "C:secret-vault",
        roles: {}
      })
    ).toThrow(/adapterId must not look like a filesystem path/);

    expect(() =>
      validateAgentRuntimeConfig({
        multicaBoard: "C:daily-plan",
        roles: {}
      })
    ).toThrow(/multicaBoard must not look like a filesystem path/);
  });

  test("rejects unknown fields and live-write switches", () => {
    expect(() =>
      validateAgentRuntimeConfig({
        knowledgeLoopBaseUrl: "http://127.0.0.1:3000",
        liveWrites: true,
        roles: {}
      })
    ).toThrow(/Unknown agent config field liveWrites/);

    expect(() =>
      validateAgentRuntimeConfig({
        roles: {
          scholar: {
            dryRun: false,
            phases: ["morning-plan"]
          }
        }
      })
    ).toThrow(/must keep dryRun true/);

    expect(() =>
      validateAgentRuntimeConfig({
        roles: {
          scholar: {
            dryRun: true,
            publish: true
          }
        }
      })
    ).toThrow(/Unknown agent config field roles\.scholar\.publish/);
  });

  test("rejects config paths outside the project checkout", () => {
    expect(() => loadAgentRuntimeConfig("../agents.json")).toThrow(/must stay inside the project checkout/);
  });

  test("rejects config symlinks that resolve outside the project checkout when supported", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kl-agent-config-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "kl-agent-config-outside-"));
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(outside, "agents.json"), '{"roles":{}}', "utf8");

    try {
      symlinkSync(path.join(outside, "agents.json"), path.join(root, "config", "linked.json"));
    } catch {
      return;
    }

    expect(() => loadAgentRuntimeConfig("config/linked.json", root)).toThrow(/must stay inside the project checkout/);
  });

  test("rejects duplicate JSON object keys in explicit config files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kl-agent-config-root-"));
    const configDir = path.join(root, "config");
    mkdirSync(configDir);
    writeFileSync(
      path.join(configDir, "duplicate-top.json"),
      '{"roles":{},"roles":{"scholar":{"dryRun":true}}}',
      "utf8"
    );
    writeFileSync(
      path.join(configDir, "duplicate-nested.json"),
      '{"roles":{"scholar":{"dryRun":true,"dryRun":true}}}',
      "utf8"
    );

    expect(() => loadAgentRuntimeConfig("config/duplicate-top.json", root)).toThrow(/Duplicate agent config key roles/);
    expect(() => loadAgentRuntimeConfig("config/duplicate-nested.json", root)).toThrow(
      /Duplicate agent config key dryRun/
    );
  });
});
