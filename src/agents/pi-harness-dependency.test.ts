import { describe, expect, test } from "vitest";

import { validatePiHarnessDependency } from "./pi-harness-dependency.js";

describe("pi-harness dependency preflight", () => {
  test("passes when package metadata dist files and git status are clean", () => {
    const result = validatePiHarnessDependency({
      packageJson: packageJson(),
      distFiles: {
        main: true,
        types: true,
        cli: true,
        cliTypes: true,
        newAgentScript: true
      },
      gitStatusShort: ""
    });

    expect(result.status).toBe("ready_for_live_dependency_proof");
    expect(result.package).toMatchObject({
      name: "pi-harness",
      version: "0.1.0",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      bin: { "pi-harness": "./dist/cli/index.js" }
    });
    expect(result.checks).toEqual([
      expect.objectContaining({ id: "package_name", status: "passed" }),
      expect.objectContaining({ id: "package_entrypoints", status: "passed" }),
      expect.objectContaining({ id: "package_exports", status: "passed" }),
      expect.objectContaining({ id: "dist_main_exists", status: "passed" }),
      expect.objectContaining({ id: "dist_types_exists", status: "passed" }),
      expect.objectContaining({ id: "cli_bin_exists", status: "passed" }),
      expect.objectContaining({ id: "dist_cli_types_exists", status: "passed" }),
      expect.objectContaining({ id: "new_agent_script", status: "passed" }),
      expect.objectContaining({ id: "git_status_clean", status: "passed" })
    ]);
    expect(result.nonCompletionNotice).toContain("does not install or link pi-harness");
    expect(result.nonCompletionNotice).toContain("does not close M2");
  });

  test("blocks when the pi-harness checkout has untracked or modified files", () => {
    const result = validatePiHarnessDependency({
      packageJson: packageJson(),
      distFiles: {
        main: true,
        types: true,
        cli: true,
        cliTypes: true,
        newAgentScript: true
      },
      gitStatusShort: "?? .env.local\n?? secrets/private-key.pem\n"
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "git_status_clean",
        status: "blocked",
        detail: "pi-harness checkout has 2 git status entries."
      })
    );
    expect(result.gitStatusEntryCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain(".env.local");
    expect(JSON.stringify(result)).not.toContain("private-key.pem");
  });

  test("blocks malformed package metadata and missing dist files", () => {
    const result = validatePiHarnessDependency({
      packageJson: {
        name: "not-pi-harness",
        version: "",
        main: "./src/index.ts",
        types: "./src/index.ts",
        bin: {},
        exports: {},
        scripts: {}
      },
      distFiles: {
        main: false,
        types: false,
        cli: false,
        cliTypes: false,
        newAgentScript: false
      },
      gitStatusShort: ""
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "package_name", status: "blocked" }),
        expect.objectContaining({ id: "package_entrypoints", status: "blocked" }),
        expect.objectContaining({ id: "package_exports", status: "blocked" }),
        expect.objectContaining({ id: "dist_main_exists", status: "blocked" }),
        expect.objectContaining({ id: "dist_types_exists", status: "blocked" }),
        expect.objectContaining({ id: "cli_bin_exists", status: "blocked" }),
        expect.objectContaining({ id: "dist_cli_types_exists", status: "blocked" }),
        expect.objectContaining({ id: "new_agent_script", status: "blocked" })
      ])
    );
  });

  test("blocks when the CLI export type file is missing", () => {
    const result = validatePiHarnessDependency({
      packageJson: packageJson(),
      distFiles: {
        main: true,
        types: true,
        cli: true,
        cliTypes: false,
        newAgentScript: true
      },
      gitStatusShort: ""
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "dist_cli_types_exists",
        status: "blocked"
      })
    );
  });

  test("blocks when package entrypoints do not point at dist", () => {
    const result = validatePiHarnessDependency({
      packageJson: {
        ...packageJson(),
        main: "./src/index.ts",
        types: "./src/index.ts"
      },
      distFiles: {
        main: true,
        types: true,
        cli: true,
        cliTypes: true,
        newAgentScript: true
      },
      gitStatusShort: ""
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "package_entrypoints",
        status: "blocked"
      })
    );
  });

  test("blocks when the new-agent script file is missing", () => {
    const result = validatePiHarnessDependency({
      packageJson: packageJson(),
      distFiles: {
        main: true,
        types: true,
        cli: true,
        cliTypes: true,
        newAgentScript: false
      },
      gitStatusShort: ""
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "new_agent_script",
        status: "blocked"
      })
    );
  });
});

function packageJson(): Record<string, unknown> {
  return {
    name: "pi-harness",
    version: "0.1.0",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    bin: {
      "pi-harness": "./dist/cli/index.js"
    },
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js"
      },
      "./cli": {
        types: "./dist/cli/index.d.ts",
        import: "./dist/cli/index.js",
        default: "./dist/cli/index.js"
      }
    },
    scripts: {
      build: "tsc -p tsconfig.build.json",
      "new-agent": "node scripts/new-agent.mjs"
    }
  };
}
