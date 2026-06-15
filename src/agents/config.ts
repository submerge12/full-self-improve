import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type { AgentDayDryRunInput, AgentDryRunInput, AgentPhase, AgentRole } from "./dry-run.js";

export interface AgentRuntimeConfig {
  readonly knowledgeLoopBaseUrl?: string;
  readonly compassHealthBaseUrl?: string;
  readonly nutritionistMealReadUrlTemplate?: string;
  readonly adapterId?: string;
  readonly multicaBoard?: string;
  readonly roles: Partial<Record<AgentRole, AgentRoleConfig>>;
}

export interface AgentRoleConfig {
  readonly dryRun?: boolean;
  readonly phases?: readonly AgentPhase[];
}

export type AgentDryRunDefaults = Pick<
  AgentDryRunInput,
  "knowledgeLoopBaseUrl" | "compassHealthBaseUrl" | "nutritionistMealReadUrlTemplate" | "adapterId" | "multicaBoard"
>;

const URL_FIELDS = new Set(["knowledgeLoopBaseUrl", "compassHealthBaseUrl"]);
const FREE_TEXT_FIELDS = new Set(["adapterId", "multicaBoard"]);
const URL_TEMPLATE_FIELDS = new Set(["nutritionistMealReadUrlTemplate"]);
const TOP_LEVEL_FIELDS = new Set([
  "knowledgeLoopBaseUrl",
  "compassHealthBaseUrl",
  "nutritionistMealReadUrlTemplate",
  "adapterId",
  "multicaBoard",
  "roles"
]);
const ROLE_FIELDS = new Set(["dryRun", "phases"]);
const AGENT_CONFIG_ROLE_PHASES = {
  librarian: ["nightly-ingest"],
  scholar: ["morning-plan", "evening-mastery"],
  nutritionist: ["daily-meals"],
  coach: ["daily-health"]
} as const satisfies Record<AgentRole, readonly AgentPhase[]>;

export function loadAgentRuntimeConfig(configPath: string, projectRoot = process.cwd()): AgentRuntimeConfig {
  const resolvedPath = resolveConfigPath(configPath, projectRoot);
  const sourceText = readFileSync(resolvedPath, "utf8");
  assertNoDuplicateJsonKeys(sourceText);
  const parsed = JSON.parse(sourceText) as unknown;

  return validateAgentRuntimeConfig(parsed);
}

export function validateAgentRuntimeConfig(value: unknown): AgentRuntimeConfig {
  if (!isRecord(value)) {
    throw new Error("Agent config must be a JSON object.");
  }

  rejectSecretLikeKeys(value);
  rejectSecretLikeValues(value);
  const config = value as Record<string, unknown>;
  rejectUnknownFields(config, TOP_LEVEL_FIELDS, "agent config");

  for (const field of URL_FIELDS) {
    const fieldValue = config[field];
    if (fieldValue !== undefined) {
      assertString(fieldValue, field);
      assertHttpUrl(fieldValue, field);
    }
  }

  for (const field of URL_TEMPLATE_FIELDS) {
    const fieldValue = config[field];
    if (fieldValue !== undefined) {
      assertString(fieldValue, field);
      assertUrlTemplate(fieldValue, field);
    }
  }

  for (const field of FREE_TEXT_FIELDS) {
    const fieldValue = config[field];
    if (fieldValue !== undefined) {
      assertString(fieldValue, field);
      assertNotFilesystemLike(fieldValue, field);
    }
  }

  const roles = parseRoles(config.roles);
  return {
    ...(config.knowledgeLoopBaseUrl === undefined ? {} : { knowledgeLoopBaseUrl: config.knowledgeLoopBaseUrl }),
    ...(config.compassHealthBaseUrl === undefined ? {} : { compassHealthBaseUrl: config.compassHealthBaseUrl }),
    ...(config.nutritionistMealReadUrlTemplate === undefined
      ? {}
      : { nutritionistMealReadUrlTemplate: config.nutritionistMealReadUrlTemplate }),
    ...(config.adapterId === undefined ? {} : { adapterId: config.adapterId }),
    ...(config.multicaBoard === undefined ? {} : { multicaBoard: config.multicaBoard }),
    roles
  } as AgentRuntimeConfig;
}

export function resolveAgentDryRunDefaults(config: AgentRuntimeConfig | undefined): AgentDryRunDefaults {
  if (config === undefined) {
    return {};
  }

  return validateAgentDryRunDefaults({
    ...(config.knowledgeLoopBaseUrl === undefined ? {} : { knowledgeLoopBaseUrl: config.knowledgeLoopBaseUrl }),
    ...(config.compassHealthBaseUrl === undefined ? {} : { compassHealthBaseUrl: config.compassHealthBaseUrl }),
    ...(config.nutritionistMealReadUrlTemplate === undefined
      ? {}
      : { nutritionistMealReadUrlTemplate: config.nutritionistMealReadUrlTemplate }),
    ...(config.adapterId === undefined ? {} : { adapterId: config.adapterId }),
    ...(config.multicaBoard === undefined ? {} : { multicaBoard: config.multicaBoard })
  });
}

export function validateAgentDryRunDefaults(defaults: AgentDryRunDefaults): AgentDryRunDefaults {
  for (const field of URL_FIELDS) {
    const fieldValue = defaults[field as keyof AgentDryRunDefaults];
    if (fieldValue !== undefined) {
      assertString(fieldValue, field);
      assertNoSecretLikeValue(fieldValue, field);
      assertHttpUrl(fieldValue, field);
    }
  }

  for (const field of URL_TEMPLATE_FIELDS) {
    const fieldValue = defaults[field as keyof AgentDryRunDefaults];
    if (fieldValue !== undefined) {
      assertString(fieldValue, field);
      assertNoSecretLikeValue(fieldValue, field);
      assertUrlTemplate(fieldValue, field);
    }
  }

  for (const field of FREE_TEXT_FIELDS) {
    const fieldValue = defaults[field as keyof AgentDryRunDefaults];
    if (fieldValue !== undefined) {
      assertString(fieldValue, field);
      assertNoSecretLikeValue(fieldValue, field);
      assertNotFilesystemLike(fieldValue, field);
    }
  }

  return defaults;
}

export function agentInputFromConfig(
  input: Pick<AgentDryRunInput, "role" | "phase" | "date"> & {
    readonly config?: AgentRuntimeConfig;
    readonly overrides?: AgentDryRunDefaults;
  }
): AgentDryRunInput {
  const configPhase = input.config?.roles[input.role]?.phases?.[0];
  const sharedDefaults = validateAgentDryRunDefaults({
    ...resolveAgentDryRunDefaults(input.config),
    ...input.overrides
  });

  return {
    ...sharedDefaults,
    role: input.role,
    ...(configPhase === undefined ? {} : { phase: configPhase }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    date: input.date
  };
}

export function agentDayInputFromConfig(input: {
  readonly date: string;
  readonly config?: AgentRuntimeConfig;
  readonly overrides?: AgentDryRunDefaults;
}): AgentDayDryRunInput {
  const sharedDefaults = validateAgentDryRunDefaults({
    ...resolveAgentDryRunDefaults(input.config),
    ...input.overrides
  });

  return {
    ...sharedDefaults,
    date: input.date
  };
}

function resolveConfigPath(configPath: string, projectRoot: string): string {
  const root = realpathSync(path.resolve(projectRoot));
  const resolvedPath = path.resolve(root, configPath);
  const relative = path.relative(root, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Agent config path must stay inside the project checkout.");
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`Agent config path does not exist: ${configPath}.`);
  }

  const realPath = realpathSync(resolvedPath);
  const realRelative = path.relative(root, realPath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("Agent config path must stay inside the project checkout.");
  }

  return realPath;
}

function parseRoles(value: unknown): AgentRuntimeConfig["roles"] {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Agent config roles must be a JSON object.");
  }

  const roles: Partial<Record<AgentRole, AgentRoleConfig>> = {};
  for (const [role, roleValue] of Object.entries(value)) {
    if (!isAgentRole(role)) {
      throw new Error(`Unknown agent config role ${role}.`);
    }
    if (!isRecord(roleValue)) {
      throw new Error(`Agent config role ${role} must be a JSON object.`);
    }
    rejectUnknownFields(roleValue, ROLE_FIELDS, `roles.${role}`);

    const dryRun = roleValue.dryRun;
    if (dryRun !== undefined && dryRun !== true) {
      throw new Error(`Agent config role ${role} must keep dryRun true.`);
    }

    const phases = parsePhases(role, roleValue.phases);
    roles[role] = {
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(phases === undefined ? {} : { phases })
    };
  }

  return roles;
}

function parsePhases(role: AgentRole, value: unknown): readonly AgentPhase[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Agent config role ${role} phases must be a non-empty array.`);
  }

  const allowedPhases: readonly AgentPhase[] = AGENT_CONFIG_ROLE_PHASES[role];
  const phases = value.map((phase) => {
    assertString(phase, `roles.${role}.phases`);
    if (!isAgentPhase(phase)) {
      throw new Error(`Unknown agent config phase ${phase}.`);
    }
    if (!allowedPhases.includes(phase)) {
      throw new Error(
        `Agent config role ${role} cannot run phase ${phase}. Expected one of: ${allowedPhases.join(", ")}.`
      );
    }

    return phase;
  });
  if (new Set(phases).size !== phases.length) {
    throw new Error(`Agent config role ${role} phases must not contain duplicates.`);
  }

  return phases;
}

function rejectSecretLikeKeys(value: unknown, pathParts: readonly string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecretLikeKeys(entry, [...pathParts, String(index)]));
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (/api[_-]?key|bearer|token|secret|cookie|password|authorization|auth/iu.test(key)) {
      throw new Error(`Agent config must not contain secret-like key ${[...pathParts, key].join(".")}.`);
    }

    rejectSecretLikeKeys(nested, [...pathParts, key]);
  }
}

function assertNoDuplicateJsonKeys(sourceText: string): void {
  const objectKeys: Array<Set<string>> = [];

  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '"') {
      const { value, endIndex } = readJsonString(sourceText, index);
      const nextIndex = skipWhitespace(sourceText, endIndex + 1);
      if (sourceText[nextIndex] === ":" && objectKeys.length > 0) {
        const keys = objectKeys[objectKeys.length - 1];
        if (keys?.has(value)) {
          throw new Error(`Duplicate agent config key ${value}.`);
        }
        keys?.add(value);
      }
      index = endIndex;
      continue;
    }

    if (char === "{") {
      objectKeys.push(new Set<string>());
    } else if (char === "}") {
      objectKeys.pop();
    }
  }
}

function readJsonString(sourceText: string, startIndex: number): { value: string; endIndex: number } {
  let escaped = false;
  for (let index = startIndex + 1; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return {
        value: JSON.parse(sourceText.slice(startIndex, index + 1)) as string,
        endIndex: index
      };
    }
  }

  throw new Error("Agent config contains an unterminated JSON string.");
}

function skipWhitespace(sourceText: string, startIndex: number): number {
  let index = startIndex;
  while (/\s/u.test(sourceText[index] ?? "")) {
    index += 1;
  }

  return index;
}

function rejectSecretLikeValues(value: unknown, pathParts: readonly string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecretLikeValues(entry, [...pathParts, String(index)]));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      rejectSecretLikeValues(nested, [...pathParts, key]);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  if (isSecretLikeValue(value)) {
    throw new Error(`Agent config field ${pathParts.join(".")} must not contain secret-like value.`);
  }
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown agent config field ${context === "agent config" ? key : `${context}.${key}`}.`);
    }
  }
}

function assertHttpUrl(value: string, field: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return;
    }
  } catch {
    // Fall through to the uniform error below.
  }

  throw new Error(`${field} must be an http or https URL.`);
}

function assertUrlTemplate(value: string, field: string): void {
  if (!value.includes("{date}")) {
    throw new Error(`${field} must include {date}.`);
  }
  if (value.includes("\\")) {
    throw new Error(`${field} must be an http(s) URL or a root-relative URL path.`);
  }

  const probeValue = value.replaceAll("{date}", "2026-06-14");
  if (probeValue.startsWith("/")) {
    if (!probeValue.startsWith("//")) {
      try {
        new URL(probeValue, "http://example.invalid");
        return;
      } catch {
        // Fall through to the uniform error below.
      }
    }

    throw new Error(`${field} must be an http(s) URL or a root-relative URL path.`);
  }

  try {
    const url = new URL(probeValue);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.username.length === 0 && url.password.length === 0) {
      return;
    }
  } catch {
    // Fall through to the uniform error below.
  }

  throw new Error(`${field} must be an http(s) URL or a root-relative URL path.`);
}

function assertNotFilesystemLike(value: string, field: string): void {
  if (
    /^[A-Z]:[\\/]/iu.test(value) ||
    /^\\\\/u.test(value) ||
    value.startsWith("/") ||
    value.startsWith("file://") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    /(^|[\\/])\.\.([\\/]|$)/u.test(value)
  ) {
    throw new Error(`${field} must not look like a filesystem path.`);
  }
}

function assertNoSecretLikeValue(value: string, field: string): void {
  if (isSecretLikeValue(value)) {
    throw new Error(`${field} must not contain secret-like value.`);
  }
}

function isSecretLikeValue(value: string): boolean {
  return (
    /\bauthorization\s*[:=]/iu.test(value) ||
    /\bbearer\s+\S+/iu.test(value) ||
    /\bcookie\s*[:=]/iu.test(value) ||
    /[?&][^=\s&]*(?:token|key|secret|authorization|auth|cookie)[^=\s&]*=[^\s&]+/iu.test(value) ||
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|auth|session|sid|password|private[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s;,)&]+/iu.test(
      value
    )
  );
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentRole(value: string): value is AgentRole {
  return value === "librarian" || value === "scholar" || value === "nutritionist" || value === "coach";
}

function isAgentPhase(value: string): value is AgentPhase {
  return (
    value === "nightly-ingest" ||
    value === "morning-plan" ||
    value === "evening-mastery" ||
    value === "daily-meals" ||
    value === "daily-health"
  );
}
