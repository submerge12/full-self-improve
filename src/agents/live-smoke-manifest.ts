import type { AgentActionType, AgentDayDryRunPlan, AgentPhase, AgentRole } from "./dry-run.js";

export interface LiveSmokeManifestSummary {
  readonly contractStatus: "inferred_live_smoke_pending";
  readonly requiredDays: number;
  readonly expectedItems: readonly string[];
}

export interface LiveSmokeManifestValidationResult {
  readonly errors: readonly string[];
  readonly summary?: LiveSmokeManifestSummary;
}

interface ManifestItem {
  readonly role: AgentRole;
  readonly phase: AgentPhase;
  readonly actionType: AgentActionType;
  readonly title: string;
  readonly requiredSourceEndpoints: readonly string[];
  readonly requiredBoardEvidence: readonly string[];
}

interface ManifestDay {
  readonly date: string;
  readonly items: readonly ManifestItem[];
}

interface LiveSmokeManifest {
  readonly contractStatus: "inferred_live_smoke_pending";
  readonly requiredConsecutiveDays: number;
  readonly boardPublishConfig: string;
  readonly smokeMode: "offline-contract-only";
  readonly evidence: {
    readonly days: readonly ManifestDay[];
  };
  readonly nonCompletionNotice: string;
}

const REQUIRED_BOARD_EVIDENCE = new Set([
  "checklist",
  "commentUrl",
  "conceptCounts",
  "masteryDelta",
  "mealChecklist",
  "sourceLinks",
  "taskUrl"
]);

export function validateLiveSmokeManifest(value: unknown, referencePlan: AgentDayDryRunPlan): LiveSmokeManifestValidationResult {
  const errors: string[] = [];
  collectUnsafeValues(value, [], errors);
  const manifest = parseManifest(value, errors);
  if (manifest === undefined) {
    return { errors };
  }

  validateManifestContract(manifest, errors);
  validateManifestDays(manifest, referencePlan, errors);

  return errors.length === 0
    ? {
        errors,
        summary: {
          contractStatus: manifest.contractStatus,
          requiredDays: manifest.requiredConsecutiveDays,
          expectedItems: expectedKeys(referencePlan)
        }
      }
    : { errors };
}

function parseManifest(value: unknown, errors: string[]): LiveSmokeManifest | undefined {
  if (!isRecord(value)) {
    errors.push("live smoke manifest must be a JSON object.");
    return undefined;
  }

  const days = isRecord(value.evidence) && Array.isArray(value.evidence.days) ? value.evidence.days : undefined;
  if (days === undefined) {
    errors.push("live smoke manifest evidence.days must be an array.");
    return undefined;
  }

  return value as unknown as LiveSmokeManifest;
}

function validateManifestContract(manifest: LiveSmokeManifest, errors: string[]): void {
  if (manifest.contractStatus !== "inferred_live_smoke_pending") {
    errors.push("live smoke manifest contractStatus must stay inferred_live_smoke_pending until a real smoke passes.");
  }
  if (manifest.requiredConsecutiveDays !== 2) {
    errors.push("live smoke manifest requiredConsecutiveDays must be 2 for M2.");
  }
  if (manifest.boardPublishConfig !== "config/multica/board-publish.example.json") {
    errors.push("live smoke manifest must reference config/multica/board-publish.example.json.");
  }
  if (manifest.smokeMode !== "offline-contract-only") {
    errors.push("live smoke manifest smokeMode must be offline-contract-only.");
  }
  if (typeof manifest.nonCompletionNotice !== "string" || !manifest.nonCompletionNotice.includes("does not")) {
    errors.push("live smoke manifest must include a non-completion notice.");
  }
}

function validateManifestDays(
  manifest: LiveSmokeManifest,
  referencePlan: AgentDayDryRunPlan,
  errors: string[]
): void {
  if (manifest.evidence.days.length !== manifest.requiredConsecutiveDays) {
    errors.push("live smoke manifest evidence.days must match requiredConsecutiveDays.");
  }
  if (!hasConsecutiveDailyDates(manifest.evidence.days)) {
    errors.push("live smoke manifest evidence.days must be consecutive daily dates.");
  }

  for (const [dayIndex, day] of manifest.evidence.days.entries()) {
    if (!isRecord(day)) {
      errors.push(`live smoke manifest day ${dayIndex} must be a JSON object.`);
      continue;
    }
    if (!Array.isArray(day.items)) {
      errors.push(`live smoke manifest day ${String(day.date)} items must be an array.`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day.date)) {
      errors.push(`live smoke manifest day ${String(day.date)} must use YYYY-MM-DD.`);
      continue;
    }

    const expectedForDay = expectedItemsForDate(referencePlan, day.date);
    const expectedKeysForDay = new Set(expectedForDay.map((item) => item.key));
    const actualByKey = new Map<string, ManifestItem>();
    for (const [itemIndex, item] of day.items.entries()) {
      if (!isRecord(item)) {
        errors.push(`live smoke manifest day ${day.date} item ${itemIndex} must be a JSON object.`);
        continue;
      }
      const manifestItem = item as unknown as ManifestItem;
      const key = itemKey(manifestItem);
      if (actualByKey.has(key)) {
        errors.push(`live smoke manifest day ${day.date} has unexpected duplicate item ${key}.`);
      }
      if (!expectedKeysForDay.has(key)) {
        errors.push(`live smoke manifest day ${day.date} has unexpected item ${key}.`);
      }
      actualByKey.set(key, manifestItem);
    }
    for (const expected of expectedForDay) {
      const actual = actualByKey.get(expected.key);
      if (actual === undefined) {
        errors.push(`live smoke manifest day ${day.date} is missing ${expected.key}.`);
        continue;
      }

      validateManifestItem(actual, expected, day.date, errors);
    }
  }
}

function hasConsecutiveDailyDates(days: readonly ManifestDay[]): boolean {
  if (
    days.length < 2 ||
    days.some((day) => !isRecord(day) || !/^\d{4}-\d{2}-\d{2}$/u.test(String(day.date)))
  ) {
    return false;
  }

  for (let index = 1; index < days.length; index += 1) {
    if (addDays(days[index - 1]?.date ?? "", 1) !== days[index]?.date) {
      return false;
    }
  }

  return true;
}

function validateManifestItem(
  actual: ManifestItem,
  expected: ManifestItem & { readonly key: string },
  date: string,
  errors: string[]
): void {
  if (actual.title !== expected.title) {
    errors.push(`live smoke manifest ${date} ${expected.key} title must match the dry-run action.`);
  }
  if (!Array.isArray(actual.requiredSourceEndpoints)) {
    errors.push(`live smoke manifest ${date} ${expected.key} requiredSourceEndpoints must be an array.`);
    return;
  }
  if (!sameStringSet(actual.requiredSourceEndpoints, expected.requiredSourceEndpoints)) {
    errors.push(`live smoke manifest ${date} ${expected.key} source endpoints must match the dry-run action.`);
  }
  if (!Array.isArray(actual.requiredBoardEvidence)) {
    errors.push(`live smoke manifest ${date} ${expected.key} requiredBoardEvidence must be an array.`);
    return;
  }
  if (actual.requiredBoardEvidence.length === 0) {
    errors.push(`live smoke manifest ${date} ${expected.key} must require board evidence.`);
  }
  for (const evidence of actual.requiredBoardEvidence) {
    if (!REQUIRED_BOARD_EVIDENCE.has(evidence)) {
      errors.push(`live smoke manifest ${date} ${expected.key} has unknown board evidence ${evidence}.`);
    }
  }
  for (const endpoint of actual.requiredSourceEndpoints) {
    validateEndpoint(endpoint, `live smoke manifest ${date} ${expected.key}`, errors);
  }
}

function expectedItemsForDate(referencePlan: AgentDayDryRunPlan, date: string): Array<ManifestItem & { key: string }> {
  return referencePlan.sequence.map((plan) => {
    const action = plan.intendedActions[0];
    if (action === undefined) {
      throw new Error(`Agent plan ${plan.role}:${plan.phase} has no intended action.`);
    }

    return {
      role: plan.role,
      phase: plan.phase,
      actionType: action.type,
      title: action.title.replace(referencePlan.date, date),
      requiredSourceEndpoints: action.sourceEndpoints.map((endpoint) => endpoint.replace(referencePlan.date, date)),
      requiredBoardEvidence: [],
      key: `${plan.role}:${plan.phase}:${action.type}`
    };
  });
}

function expectedKeys(referencePlan: AgentDayDryRunPlan): readonly string[] {
  return expectedItemsForDate(referencePlan, referencePlan.date).map((item) => item.key);
}

function itemKey(item: Pick<ManifestItem, "role" | "phase" | "actionType">): string {
  return `${item.role}:${item.phase}:${item.actionType}`;
}

function validateEndpoint(value: string, context: string, errors: string[]): void {
  const match = /^(GET|POST)\s+(.+)$/u.exec(value);
  const urlValue = match?.[2] ?? value;
  try {
    const url = new URL(urlValue);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return;
    }
  } catch {
    // Fall through to the uniform error below.
  }

  errors.push(`${context} requiredSourceEndpoints entry must be an http or https URL.`);
}

function collectUnsafeValues(value: unknown, pathParts: readonly string[], errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectUnsafeValues(entry, [...pathParts, String(index)], errors));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (/api[_-]?key|bearer|token|secret|cookie|password|authorization|auth/iu.test(key)) {
        errors.push(`live smoke manifest must not contain secret-like key at ${[...pathParts, key].join(".")}.`);
      }
      collectUnsafeValues(nested, [...pathParts, key], errors);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }

  const location = pathParts.join(".");
  if (isSecretLikeValue(value)) {
    errors.push(`live smoke manifest must not contain secret-like value at ${location}.`);
  }
  if (isFilesystemLikeValue(value)) {
    errors.push(`live smoke manifest must not contain filesystem-like value at ${location}.`);
  }
}

function isSecretLikeValue(value: string): boolean {
  return (
    /\bauthorization\s*[:=]/iu.test(value) ||
    /\bbearer\s+\S+/iu.test(value) ||
    /\bcookie\s*[:=]/iu.test(value) ||
    /[?&][^=\s&]*(?:token|key|secret|authorization|auth|cookie|session|sid|password)[^=\s&]*=[^\s&]+/iu.test(value) ||
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|auth|session|sid|password|private[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s;,)&]+/iu.test(
      value
    )
  );
}

function isFilesystemLikeValue(value: string): boolean {
  return /^[A-Z]:[\\/]/iu.test(value) || value.includes("G:/") || value.includes("G:\\") || value.startsWith("file://");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);

  return parsed.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
