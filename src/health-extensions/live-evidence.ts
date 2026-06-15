import { assertIsoDate, assertIsoInstant, assertSafeText } from "./schema.js";

export interface HealthLiveEvidenceValidationResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly summary?: {
    readonly longestSedentaryMinutes: number;
    readonly reminderDelayMinutes: number;
    readonly liveGate: "windows_logger_alert_observed";
  };
}

const EXPECTED_ROOT_KEYS = ["contractStatus", "evidenceMode", "date", "logger", "sedentaryStreak", "breakReminder"];
const EXPECTED_LOGGER_KEYS = ["loggerId", "startupObserved", "startupCommand", "sleepWakeSurvived", "version"];
const EXPECTED_STREAK_KEYS = ["windowStart", "windowEnd", "durationMinutes", "source"];
const EXPECTED_REMINDER_KEYS = ["eligibleAt", "recordedAt", "deliveryChannel", "visibleAlertObserved"];
const FAKE_CLOSURE_FIELDS = new Set(["m4complete", "closed", "done"]);

export function validateWindowsLoggerLiveEvidence(value: unknown): HealthLiveEvidenceValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  scanEvidence(value, "", errors, new WeakSet<object>());

  const evidence = readObject(value, "evidence", errors);
  if (evidence === undefined) {
    return { errors, warnings };
  }

  rejectUnexpectedKeys(evidence, EXPECTED_ROOT_KEYS, "", errors);
  expectLiteral(evidence.contractStatus, "contractStatus", "observed_live_alert_pending_review", errors);
  expectLiteral(evidence.evidenceMode, "evidenceMode", "live-observation", errors);
  readIsoDate(evidence.date, "date", errors);
  const loggerId = validateLogger(evidence.logger, errors);
  const streak = validateSedentaryStreak(evidence.sedentaryStreak, loggerId, errors);
  const reminder = validateBreakReminder(evidence.breakReminder, errors);

  if (errors.length > 0 || streak.durationMinutes === undefined || reminder.delayMinutes === undefined) {
    return { errors, warnings };
  }
  return {
    errors,
    warnings,
    summary: {
      longestSedentaryMinutes: streak.durationMinutes,
      reminderDelayMinutes: reminder.delayMinutes,
      liveGate: "windows_logger_alert_observed"
    }
  };
}

function validateLogger(value: unknown, errors: string[]): string | undefined {
  const logger = readObject(value, "logger", errors);
  if (logger === undefined) {
    return undefined;
  }
  rejectUnexpectedKeys(logger, EXPECTED_LOGGER_KEYS, "logger", errors);
  const loggerId = readText(logger.loggerId, "logger.loggerId", errors);
  expectTrue(logger.startupObserved, "logger.startupObserved", errors);
  validateStartupCommand(readText(logger.startupCommand, "logger.startupCommand", errors), errors);
  expectTrue(logger.sleepWakeSurvived, "logger.sleepWakeSurvived", errors);
  expectLiteral(logger.version, "logger.version", "health-windows-logger/0.1.0", errors);
  return loggerId;
}

function validateSedentaryStreak(
  value: unknown,
  loggerId: string | undefined,
  errors: string[]
): { readonly durationMinutes?: number } {
  const streak = readObject(value, "sedentaryStreak", errors);
  if (streak === undefined) {
    return {};
  }
  rejectUnexpectedKeys(streak, EXPECTED_STREAK_KEYS, "sedentaryStreak", errors);
  const windowStart = readIsoInstant(streak.windowStart, "sedentaryStreak.windowStart", errors);
  const windowEnd = readIsoInstant(streak.windowEnd, "sedentaryStreak.windowEnd", errors);
  validateWindowOrder(windowStart, windowEnd, errors);
  const durationMinutes = readDuration(streak.durationMinutes, errors);
  validateStreakSource(readText(streak.source, "sedentaryStreak.source", errors), loggerId, errors);
  return { durationMinutes };
}

function validateBreakReminder(value: unknown, errors: string[]): { readonly delayMinutes?: number } {
  const reminder = readObject(value, "breakReminder", errors);
  if (reminder === undefined) {
    return {};
  }
  rejectUnexpectedKeys(reminder, EXPECTED_REMINDER_KEYS, "breakReminder", errors);
  const eligibleAt = readIsoInstant(reminder.eligibleAt, "breakReminder.eligibleAt", errors);
  const recordedAt = readIsoInstant(reminder.recordedAt, "breakReminder.recordedAt", errors);
  readText(reminder.deliveryChannel, "breakReminder.deliveryChannel", errors);
  expectTrue(reminder.visibleAlertObserved, "breakReminder.visibleAlertObserved", errors);
  return { delayMinutes: validateReminderDelay(eligibleAt, recordedAt, errors) };
}

function validateStartupCommand(command: string | undefined, errors: string[]): void {
  if (command === undefined) {
    return;
  }
  if (!/\bschtasks(?:\.exe)?\s+\/create\b/i.test(command)) {
    errors.push("logger.startupCommand must contain schtasks /Create");
  }
  if (!/\bknowledge-loop-health-windows-logger\b/i.test(command)) {
    errors.push("logger.startupCommand must contain knowledge-loop-health-windows-logger");
  }
  if (!/scripts[\\/]+health-windows-logger\.ts/i.test(command)) {
    errors.push("logger.startupCommand must contain scripts/health-windows-logger.ts");
  }
  if (!/config[\\/]+health[\\/]+windows-logger\.example\.json/i.test(command)) {
    errors.push("logger.startupCommand must contain config/health/windows-logger.example.json");
  }
}

function validateWindowOrder(windowStart: string | undefined, windowEnd: string | undefined, errors: string[]): void {
  if (windowStart === undefined || windowEnd === undefined) {
    return;
  }
  if (new Date(windowEnd).getTime() <= new Date(windowStart).getTime()) {
    errors.push("sedentaryStreak.windowEnd must be after windowStart");
  }
}

function readDuration(value: unknown, errors: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push("sedentaryStreak.durationMinutes must be a finite number");
    return undefined;
  }
  if (value < 60) {
    errors.push("sedentaryStreak.durationMinutes must be at least 60");
  }
  return value;
}

function validateStreakSource(source: string | undefined, loggerId: string | undefined, errors: string[]): void {
  if (source === undefined) {
    return;
  }
  if (!source.toLowerCase().includes("windows-logger")) {
    errors.push("sedentaryStreak.source must reference windows-logger");
  }
  if (loggerId !== undefined && !source.includes(loggerId)) {
    errors.push("sedentaryStreak.source must reference logger.loggerId");
  }
}

function validateReminderDelay(
  eligibleAt: string | undefined,
  recordedAt: string | undefined,
  errors: string[]
): number | undefined {
  if (eligibleAt === undefined || recordedAt === undefined) {
    return undefined;
  }
  const delayMinutes = (new Date(recordedAt).getTime() - new Date(eligibleAt).getTime()) / 60_000;
  if (delayMinutes < 0 || delayMinutes > 5) {
    errors.push("breakReminder.recordedAt must be within 5 minutes of eligibleAt");
  }
  return delayMinutes;
}

function readObject(value: unknown, path: string, errors: string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown, path: string, errors: string[]): string | undefined {
  if (typeof value !== "string") {
    errors.push(`${path} must be text`);
    return undefined;
  }
  try {
    return assertSafeText(value, path);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : `${path} is invalid`);
    return undefined;
  }
}

function readIsoDate(value: unknown, path: string, errors: string[]): string | undefined {
  const text = readText(value, path, errors);
  if (text === undefined) {
    return undefined;
  }
  try {
    return assertIsoDate(text, path);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : `${path} must be an ISO date`);
    return undefined;
  }
}

function readIsoInstant(value: unknown, path: string, errors: string[]): string | undefined {
  const text = readText(value, path, errors);
  if (text === undefined) {
    return undefined;
  }
  try {
    return assertIsoInstant(text, path);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : `${path} must be an ISO instant`);
    return undefined;
  }
}

function expectLiteral(value: unknown, path: string, expected: string, errors: string[]): void {
  if (value !== expected) {
    errors.push(`${path} must be ${expected}`);
  }
}

function expectTrue(value: unknown, path: string, errors: string[]): void {
  if (value !== true) {
    errors.push(`${path} must be true for the live gate`);
  }
}

function rejectUnexpectedKeys(
  object: Record<string, unknown>,
  expectedKeys: readonly string[],
  parentPath: string,
  errors: string[]
): void {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) {
      const path = joinPath(parentPath, key);
      errors.push(`unexpected field ${path}`);
    }
  }
}

function scanEvidence(value: unknown, path: string, errors: string[], seen: WeakSet<object>): void {
  if (typeof value === "string") {
    scanStringValue(value, path, errors);
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  scanObjectEntries(value, path, errors, seen);
}

function scanObjectEntries(value: object, path: string, errors: string[], seen: WeakSet<object>): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanEvidence(entry, `${path}[${index}]`, errors, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = joinPath(path, key);
    if (FAKE_CLOSURE_FIELDS.has(key.toLowerCase())) {
      errors.push(`fake closure field ${entryPath} is not accepted`);
    }
    scanEvidence(entry, entryPath, errors, seen);
  }
}

function scanStringValue(value: string, path: string, errors: string[]): void {
  if (hasSecretLikeValue(value)) {
    errors.push(`secret-like value detected at ${path}`);
  }
  if (hasFrozenRepositoryPath(value)) {
    errors.push(`frozen repository filesystem path detected at ${path}`);
  }
}

function hasSecretLikeValue(value: string): boolean {
  return (
    /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value) ||
    /\b(?:api[_-]?key|token|secret|authorization|password)\b\s*[:=]\s*\S{8,}/i.test(value) ||
    /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,})\b/.test(value)
  );
}

function hasFrozenRepositoryPath(value: string): boolean {
  return (
    /[A-Za-z]:[\\/][^"'`]*compass-health(?:[\\/]|$)/i.test(value) ||
    /[A-Za-z]:[\\/][^"'`]*knowledge-showcase(?:[\\/]|$)/i.test(value) ||
    /[A-Za-z]:[\\/][^"'`]*multica-ai-multica-https-github-com(?:[\\/]|$)/i.test(value) ||
    /[A-Za-z]:[\\/][^"'`]*pi-harness(?:[\\/]|$)/i.test(value) ||
    /[A-Za-z]:[\\/][^"'`]*knowledge-loop[^"'`]*(?:frozen|snapshot)/i.test(value)
  );
}

function joinPath(parentPath: string, key: string): string {
  return parentPath.length === 0 ? key : `${parentPath}.${key}`;
}
