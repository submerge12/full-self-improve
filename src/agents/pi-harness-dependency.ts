export type PiHarnessDependencyStatus = "ready_for_live_dependency_proof" | "blocked";
export type PiHarnessDependencyCheckStatus = "passed" | "blocked";

export interface PiHarnessDistFiles {
  readonly main: boolean;
  readonly types: boolean;
  readonly cli: boolean;
  readonly cliTypes: boolean;
  readonly newAgentScript: boolean;
}

export interface PiHarnessDependencyInput {
  readonly packageJson: unknown;
  readonly distFiles: PiHarnessDistFiles;
  readonly gitStatusShort: string;
}

export interface PiHarnessDependencyCheck {
  readonly id:
    | "package_name"
    | "package_entrypoints"
    | "package_exports"
    | "dist_main_exists"
    | "dist_types_exists"
    | "cli_bin_exists"
    | "dist_cli_types_exists"
    | "new_agent_script"
    | "git_status_clean";
  readonly status: PiHarnessDependencyCheckStatus;
  readonly detail: string;
}

export interface PiHarnessPackageSummary {
  readonly name?: string;
  readonly version?: string;
  readonly main?: string;
  readonly types?: string;
  readonly bin?: Record<string, string>;
}

export interface PiHarnessDependencyReport {
  readonly status: PiHarnessDependencyStatus;
  readonly package: PiHarnessPackageSummary;
  readonly checks: readonly PiHarnessDependencyCheck[];
  readonly gitStatusEntryCount: number;
  readonly nonCompletionNotice: string;
}

const NON_COMPLETION_NOTICE =
  "This pi-harness dependency preflight is read-only. It does not install or link pi-harness, does not run scaffolding, does not modify the pi-harness checkout, and does not close M2.";

export function validatePiHarnessDependency(input: PiHarnessDependencyInput): PiHarnessDependencyReport {
  const manifest = recordOrEmpty(input.packageJson);
  const summary = packageSummary(manifest);
  const gitStatusShort = parseGitStatus(input.gitStatusShort);
  const checks: PiHarnessDependencyCheck[] = [
    check(summary.name === "pi-harness" && nonEmpty(summary.version), "package_name", `package ${summary.name ?? "missing"}`),
    check(
      summary.main === "./dist/index.js" && summary.types === "./dist/index.d.ts",
      "package_entrypoints",
      "package main/types must point to dist entrypoints"
    ),
    check(hasRequiredExports(manifest), "package_exports", "exports must expose . and ./cli dist entries"),
    check(input.distFiles.main, "dist_main_exists", `${summary.main ?? "./dist/index.js"} must be a file`),
    check(input.distFiles.types, "dist_types_exists", `${summary.types ?? "./dist/index.d.ts"} must be a file`),
    check(summary.bin?.["pi-harness"] === "./dist/cli/index.js" && input.distFiles.cli, "cli_bin_exists", "pi-harness bin must point to dist cli"),
    check(input.distFiles.cliTypes, "dist_cli_types_exists", "./dist/cli/index.d.ts must be a file"),
    check(
      readScript(manifest, "new-agent") === "node scripts/new-agent.mjs" && input.distFiles.newAgentScript,
      "new_agent_script",
      "new-agent script must be available without editing pi-harness"
    ),
    check(gitStatusShort.length === 0, "git_status_clean", gitStatusDetail(gitStatusShort))
  ];

  return {
    status: checks.every((entry) => entry.status === "passed") ? "ready_for_live_dependency_proof" : "blocked",
    package: summary,
    checks,
    gitStatusEntryCount: gitStatusShort.length,
    nonCompletionNotice: NON_COMPLETION_NOTICE
  };
}

function check(
  passed: boolean,
  id: PiHarnessDependencyCheck["id"],
  detail: string
): PiHarnessDependencyCheck {
  return {
    id,
    status: passed ? "passed" : "blocked",
    detail
  };
}

function packageSummary(manifest: Record<string, unknown>): PiHarnessPackageSummary {
  const bin = recordOrUndefined(manifest.bin);

  return {
    ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    ...(typeof manifest.main === "string" ? { main: manifest.main } : {}),
    ...(typeof manifest.types === "string" ? { types: manifest.types } : {}),
    ...(bin === undefined ? {} : { bin: stringRecord(bin) })
  };
}

function hasRequiredExports(manifest: Record<string, unknown>): boolean {
  const exportsRecord = recordOrUndefined(manifest.exports);
  if (exportsRecord === undefined) {
    return false;
  }

  return (
    exportTargetMatches(exportsRecord["."], "./dist/index.js", "./dist/index.d.ts") &&
    exportTargetMatches(exportsRecord["./cli"], "./dist/cli/index.js", "./dist/cli/index.d.ts")
  );
}

function exportTargetMatches(value: unknown, importPath: string, typesPath: string): boolean {
  const target = recordOrUndefined(value);
  return target?.import === importPath && target.default === importPath && target.types === typesPath;
}

function readScript(manifest: Record<string, unknown>, name: string): string | undefined {
  const scripts = recordOrUndefined(manifest.scripts);
  const value = scripts?.[name];
  return typeof value === "string" ? value : undefined;
}

function parseGitStatus(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function gitStatusDetail(entries: readonly string[]): string {
  return entries.length === 0 ? "pi-harness checkout is clean." : `pi-harness checkout has ${entries.length} git status entries.`;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return recordOrUndefined(value) ?? {};
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }

  return result;
}
