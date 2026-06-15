import { assertIsoDate, assertIsoInstant, assertSafeText } from "./schema.js";

export interface HealthLiveEvidenceValidationResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly summary?: WindowsLoggerLiveEvidenceSummary | M4LiveReviewEvidenceSummary;
}

interface WindowsLoggerLiveEvidenceSummary {
  readonly longestSedentaryMinutes: number;
  readonly reminderDelayMinutes: number;
  readonly liveGate: "windows_logger_alert_observed";
}

interface M4LiveReviewEvidenceSummary {
  readonly contractStatus: "m4_live_review_pending_verification";
  readonly evidenceMode: "live-review";
  readonly liveGate: "m4_live_review_pending_verification";
}

const EXPECTED_ROOT_KEYS = ["contractStatus", "evidenceMode", "date", "logger", "sedentaryStreak", "breakReminder"];
const EXPECTED_M4_ROOT_KEYS = [
  "contractStatus",
  "evidenceMode",
  "windowsLogger",
  "coachDigest",
  "compassHealthHashProof"
];
const EXPECTED_LOGGER_KEYS = ["loggerId", "startupObserved", "startupCommand", "sleepWakeSurvived", "version"];
const EXPECTED_STREAK_KEYS = ["windowStart", "windowEnd", "durationMinutes", "source"];
const EXPECTED_REMINDER_KEYS = ["eligibleAt", "recordedAt", "deliveryChannel", "visibleAlertObserved"];
const EXPECTED_COACH_DIGEST_KEYS = ["date", "snapshotId", "boardUrl", "boardId", "publishedAt"];
const EXPECTED_COMPASS_HASH_PROOF_KEYS = ["algorithm", "collectedOutsideHealthExtensions", "before", "afterOneWeek"];
const EXPECTED_COMPASS_HASH_POINT_KEYS = ["date", "hash"];
const FAKE_CLOSURE_FIELDS = new Set(["m4complete", "m4closed", "closed", "done"]);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

export function validateM4LiveReviewEvidence(value: unknown): HealthLiveEvidenceValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  scanEvidence(value, "", errors, new WeakSet<object>());

  const evidence = readObject(value, "evidence", errors);
  if (evidence === undefined) {
    return { errors, warnings };
  }

  rejectUnexpectedKeys(evidence, EXPECTED_M4_ROOT_KEYS, "", errors);
  expectLiteral(evidence.contractStatus, "contractStatus", "m4_live_review_pending_verification", errors);
  expectLiteral(evidence.evidenceMode, "evidenceMode", "live-review", errors);
  validateNestedWindowsLogger(evidence.windowsLogger, errors);
  validateCoachDigest(evidence.coachDigest, errors);
  validateCompassHealthHashProof(evidence.compassHealthHashProof, errors);

  if (errors.length > 0) {
    return { errors, warnings };
  }

  return {
    errors,
    warnings,
    summary: {
      contractStatus: "m4_live_review_pending_verification",
      evidenceMode: "live-review",
      liveGate: "m4_live_review_pending_verification"
    }
  };
}

function validateNestedWindowsLogger(value: unknown, errors: string[]): void {
  const nested = validateWindowsLoggerLiveEvidence(value);
  errors.push(...nested.errors.map((error) => prefixNestedError("windowsLogger", error)));
  if (nested.summary === undefined) {
    errors.push("windowsLogger must contain valid Windows logger live alert evidence");
  }
}

function validateCoachDigest(value: unknown, errors: string[]): void {
  const digest = readObject(value, "coachDigest", errors);
  if (digest === undefined) {
    return;
  }
  rejectUnexpectedKeys(digest, EXPECTED_COACH_DIGEST_KEYS, "coachDigest", errors);
  readIsoDate(digest.date, "coachDigest.date", errors);
  readFiniteNumber(digest.snapshotId, "coachDigest.snapshotId", errors);
  readIsoInstant(digest.publishedAt, "coachDigest.publishedAt", errors);

  const hasBoardUrl = digest.boardUrl !== undefined;
  const hasBoardId = digest.boardId !== undefined;
  if (!hasBoardUrl && !hasBoardId) {
    errors.push("coachDigest must include boardUrl or boardId");
  }
  if (hasBoardUrl) {
    validateHttpUrl(readText(digest.boardUrl, "coachDigest.boardUrl", errors), "coachDigest.boardUrl", errors);
  }
  if (hasBoardId) {
    validateBoardId(readText(digest.boardId, "coachDigest.boardId", errors), errors);
  }
}

function validateCompassHealthHashProof(value: unknown, errors: string[]): void {
  const proof = readObject(value, "compassHealthHashProof", errors);
  if (proof === undefined) {
    return;
  }
  rejectUnexpectedKeys(proof, EXPECTED_COMPASS_HASH_PROOF_KEYS, "compassHealthHashProof", errors);
  expectLiteral(proof.algorithm, "compassHealthHashProof.algorithm", "sha256", errors);
  if (proof.collectedOutsideHealthExtensions !== true) {
    errors.push("compassHealthHashProof.collectedOutsideHealthExtensions must be true");
  }

  const before = readHashPoint(proof.before, "compassHealthHashProof.before", errors);
  const afterOneWeek = readHashPoint(proof.afterOneWeek, "compassHealthHashProof.afterOneWeek", errors);
  if (before.hash !== undefined && afterOneWeek.hash !== undefined && before.hash !== afterOneWeek.hash) {
    errors.push("compassHealthHashProof.before.hash must match afterOneWeek.hash");
  }
  validateAtLeastSevenDaysApart(before.date, afterOneWeek.date, errors);
}

function readHashPoint(
  value: unknown,
  path: string,
  errors: string[]
): { readonly date?: string; readonly hash?: string } {
  const point = readObject(value, path, errors);
  if (point === undefined) {
    return {};
  }
  rejectUnexpectedKeys(point, EXPECTED_COMPASS_HASH_POINT_KEYS, path, errors);
  const date = readIsoDate(point.date, `${path}.date`, errors);
  const hash = readText(point.hash, `${path}.hash`, errors);
  if (hash !== undefined && !/^[a-f0-9]{64}$/i.test(hash)) {
    errors.push(`${path}.hash must be a sha256 hex hash`);
  }
  return { date, hash };
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

function readFiniteNumber(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path} must be a finite number`);
    return undefined;
  }
  return value;
}

function validateHttpUrl(value: string | undefined, path: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`${path} must be an HTTP(S) URL`);
    }
    if (url.username.length > 0 || url.password.length > 0) {
      errors.push(`${path} must not include credentials`);
    }
  } catch {
    errors.push(`${path} must be an HTTP(S) URL`);
  }
}

function validateBoardId(value: string | undefined, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    errors.push("coachDigest.boardId must be an ordinary board id");
  }
}

function validateAtLeastSevenDaysApart(
  beforeDate: string | undefined,
  afterDate: string | undefined,
  errors: string[]
): void {
  if (beforeDate === undefined || afterDate === undefined) {
    return;
  }
  const beforeTime = Date.parse(`${beforeDate}T00:00:00.000Z`);
  const afterTime = Date.parse(`${afterDate}T00:00:00.000Z`);
  if (afterTime - beforeTime < SEVEN_DAYS_MS) {
    errors.push("compassHealthHashProof dates must be at least seven days apart");
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

function prefixNestedError(parentPath: string, error: string): string {
  const fakeClosurePrefix = "fake closure field ";
  if (error.startsWith(fakeClosurePrefix)) {
    return `${fakeClosurePrefix}${parentPath}.${error.slice(fakeClosurePrefix.length)}`;
  }

  const secretSuffix = "secret-like value detected at ";
  if (error.startsWith(secretSuffix)) {
    return `${secretSuffix}${parentPath}.${error.slice(secretSuffix.length)}`;
  }

  const pathSuffix = "frozen repository filesystem path detected at ";
  if (error.startsWith(pathSuffix)) {
    return `${pathSuffix}${parentPath}.${error.slice(pathSuffix.length)}`;
  }

  return `${parentPath}.${error}`;
}
