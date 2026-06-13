export interface BoardDayEvidenceSummary {
  readonly contractStatus: "observed_live_smoke_pending_verification";
  readonly evidenceMode: "offline-observation-only";
  readonly requiredDays: number;
  readonly observedItems: readonly string[];
}

export interface BoardDayEvidenceValidationResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly summary?: BoardDayEvidenceSummary;
}

interface ManifestItem {
  readonly role: string;
  readonly phase: string;
  readonly actionType: string;
  readonly title: string;
  readonly requiredSourceEndpoints: readonly string[];
  readonly requiredBoardEvidence: readonly string[];
}

interface ManifestDay {
  readonly date: string;
  readonly items: readonly ManifestItem[];
}

interface ManifestLike {
  readonly requiredConsecutiveDays: number;
  readonly evidence: {
    readonly days: readonly ManifestDay[];
  };
}

interface BoardDayEvidenceItem {
  readonly role: string;
  readonly phase: string;
  readonly actionType: string;
  readonly title: string;
  readonly sourceEndpoints: readonly string[];
  readonly boardEvidence: Record<string, unknown>;
}

interface BoardDayEvidenceDay {
  readonly date: string;
  readonly items: readonly BoardDayEvidenceItem[];
}

interface BoardDayEvidence {
  readonly contractStatus: "observed_live_smoke_pending_verification";
  readonly evidenceMode: "offline-observation-only";
  readonly days: readonly BoardDayEvidenceDay[];
}

export const BOARD_DAY_EVIDENCE_OFFLINE_WARNING =
  "board-day evidence is offline observed evidence only; it does not prove hands-free execution or close M2.";

const PENDING_CONTRACT_STATUS = "observed_live_smoke_pending_verification";
const OFFLINE_EVIDENCE_MODE = "offline-observation-only";

export function validateBoardDayEvidence(value: unknown, manifestLike: unknown): BoardDayEvidenceValidationResult {
  const errors: string[] = [];
  const warnings = [BOARD_DAY_EVIDENCE_OFFLINE_WARNING];
  collectUnsafeValues(value, [], errors);
  collectUnsafeValues(manifestLike, ["referenceManifest"], errors);
  collectFakeClosureFields(value, [], errors);
  collectFakeClosureFields(manifestLike, ["referenceManifest"], errors);
  const evidence = parseEvidence(value, errors);
  const manifest = parseManifest(manifestLike, errors);
  if (evidence === undefined || manifest === undefined) {
    return { errors, warnings };
  }

  validateContract(evidence, errors);
  validateDays(evidence, manifest, errors);

  return errors.length === 0
    ? {
        errors,
        warnings,
        summary: {
          contractStatus: evidence.contractStatus,
          evidenceMode: evidence.evidenceMode,
          requiredDays: manifest.requiredConsecutiveDays,
          observedItems: observedKeys(evidence.days)
        }
      }
    : { errors, warnings };
}

function parseEvidence(value: unknown, errors: string[]): BoardDayEvidence | undefined {
  if (!isRecord(value)) {
    errors.push("board-day evidence must be a JSON object.");
    return undefined;
  }
  if (!Array.isArray(value.days)) {
    errors.push("board-day evidence days must be an array.");
    return undefined;
  }

  return value as unknown as BoardDayEvidence;
}

function parseManifest(value: unknown, errors: string[]): ManifestLike | undefined {
  if (!isRecord(value) || !isRecord(value.evidence) || !Array.isArray(value.evidence.days)) {
    errors.push("board-day evidence reference manifest must include evidence.days.");
    return undefined;
  }
  if (typeof value.requiredConsecutiveDays !== "number") {
    errors.push("board-day evidence reference manifest must include requiredConsecutiveDays.");
    return undefined;
  }

  return value as unknown as ManifestLike;
}

function validateContract(evidence: BoardDayEvidence, errors: string[]): void {
  if (evidence.contractStatus !== PENDING_CONTRACT_STATUS) {
    errors.push("board-day evidence contractStatus must remain observed_live_smoke_pending_verification.");
  }
  if (evidence.evidenceMode !== OFFLINE_EVIDENCE_MODE) {
    errors.push("board-day evidence evidenceMode must remain offline-observation-only.");
  }
}

function validateDays(evidence: BoardDayEvidence, manifest: ManifestLike, errors: string[]): void {
  if (manifest.requiredConsecutiveDays !== 2) {
    errors.push("board-day evidence reference manifest requiredConsecutiveDays must be 2.");
  }
  if (evidence.days.length !== manifest.requiredConsecutiveDays) {
    errors.push("board-day evidence days length must match manifest requiredConsecutiveDays.");
  }
  if (manifest.evidence.days.length !== manifest.requiredConsecutiveDays) {
    errors.push("board-day evidence reference manifest days length must match requiredConsecutiveDays.");
  }
  if (!hasConsecutiveDailyDates(manifest.evidence.days)) {
    errors.push("board-day evidence reference manifest days must be consecutive.");
  }
  for (const [dayIndex, expectedDay] of manifest.evidence.days.entries()) {
    if (!isManifestDay(expectedDay)) {
      errors.push(`board-day evidence reference manifest day ${dayIndex} must include date and items.`);
      continue;
    }
    validateDay(evidence.days[dayIndex], expectedDay, dayIndex, errors);
  }
}

function validateDay(
  actualDay: BoardDayEvidenceDay | undefined,
  expectedDay: ManifestDay,
  dayIndex: number,
  errors: string[]
): void {
  if (!isRecord(actualDay)) {
    errors.push(`board-day evidence day ${dayIndex} must be a JSON object.`);
    return;
  }
  if (actualDay.date !== expectedDay.date) {
    errors.push(`board-day evidence day ${dayIndex} date must match manifest date ${expectedDay.date}.`);
  }
  if (!Array.isArray(actualDay.items)) {
    errors.push(`board-day evidence ${String(actualDay.date)} items must be an array.`);
    return;
  }
  validateItems(actualDay, expectedDay, dayIndex, errors);
}

interface IndexedEvidenceItem {
  readonly item: BoardDayEvidenceItem;
  readonly index: number;
}

function validateItems(
  actualDay: BoardDayEvidenceDay,
  expectedDay: ManifestDay,
  dayIndex: number,
  errors: string[]
): void {
  const validExpectedItems: ManifestItem[] = [];
  for (const expected of expectedDay.items) {
    if (!isManifestItem(expected)) {
      errors.push(`board-day evidence reference manifest ${expectedDay.date} has malformed item.`);
      continue;
    }
    validExpectedItems.push(expected);
  }

  const actualByKey = new Map<string, IndexedEvidenceItem>();
  const expectedKeys = new Set(validExpectedItems.map(itemKey));
  for (const [itemIndex, item] of actualDay.items.entries()) {
    if (!isRecord(item)) {
      errors.push(`board-day evidence ${actualDay.date} item ${itemIndex} must be a JSON object.`);
      continue;
    }
    recordActualItem(item as unknown as BoardDayEvidenceItem, itemIndex, actualDay.date, expectedKeys, actualByKey, errors);
  }
  for (const expected of validExpectedItems) {
    const actual = actualByKey.get(itemKey(expected));
    if (actual === undefined) {
      errors.push(`board-day evidence ${actualDay.date} is missing ${itemKey(expected)}.`);
      continue;
    }
    validateItem(actual.item, expected, actualDay.date, dayIndex, actual.index, errors);
  }
}

function recordActualItem(
  item: BoardDayEvidenceItem,
  itemIndex: number,
  date: string,
  expectedKeys: ReadonlySet<string>,
  actualByKey: Map<string, IndexedEvidenceItem>,
  errors: string[]
): void {
  const key = itemKey(item);
  if (actualByKey.has(key)) {
    errors.push(`board-day evidence ${date} has duplicate item ${key}.`);
  }
  if (!expectedKeys.has(key)) {
    errors.push(`board-day evidence ${date} has unexpected item ${key}.`);
  }
  actualByKey.set(key, { item, index: itemIndex });
}

function validateItem(
  actual: BoardDayEvidenceItem,
  expected: ManifestItem,
  date: string,
  dayIndex: number,
  itemIndex: number,
  errors: string[]
): void {
  const context = `board-day evidence ${date} ${itemKey(expected)}`;
  if (actual.title !== expected.title) {
    errors.push(`${context} title must match manifest.`);
  }
  if (!Array.isArray(actual.sourceEndpoints)) {
    errors.push(`${context} sourceEndpoints must be an array.`);
    return;
  }
  if (!sameStringSet(actual.sourceEndpoints, expected.requiredSourceEndpoints)) {
    errors.push(`${context} sourceEndpoints must match manifest requiredSourceEndpoints.`);
  }
  if (!isRecord(actual.boardEvidence)) {
    errors.push(`${context} boardEvidence must be a JSON object.`);
    return;
  }
  validateRequiredBoardEvidence(actual.boardEvidence, expected, date, errors);
  validateBoardEvidenceUrls(actual.boardEvidence, dayIndex, itemIndex, errors);
}

function validateRequiredBoardEvidence(
  boardEvidence: Record<string, unknown>,
  expected: ManifestItem,
  date: string,
  errors: string[]
): void {
  for (const required of expected.requiredBoardEvidence) {
    if (!(required in boardEvidence)) {
      errors.push(`board-day evidence ${date} ${itemKey(expected)} missing boardEvidence.${required}.`);
      continue;
    }
    validateBoardEvidenceField(required, boardEvidence[required], `board-day evidence ${date} ${itemKey(expected)}`, errors);
  }
}

function validateBoardEvidenceField(field: string, value: unknown, context: string, errors: string[]): void {
  if (field === "taskUrl" || field === "commentUrl") {
    validateHttpUrlField(value, `${context} boardEvidence.${field}`, errors);
    return;
  }
  if (field === "sourceLinks") {
    validateNonEmptyHttpUrlArray(value, `${context} boardEvidence.${field}`, errors);
    return;
  }
  if (field === "checklist" || field === "mealChecklist") {
    validateNonEmptyStringArray(value, `${context} boardEvidence.${field}`, errors);
    return;
  }
  if (field === "conceptCounts" || field === "masteryDelta") {
    validateNumericRecord(value, `${context} boardEvidence.${field}`, errors);
  }
}

function validateHttpUrlField(value: unknown, context: string, errors: string[]): void {
  if (typeof value !== "string") {
    errors.push(`${context} must be an http or https URL string.`);
    return;
  }
  if (!isSafeHttpUrl(value)) {
    errors.push(`${context} must be an http or https URL string.`);
  }
}

function validateNonEmptyHttpUrlArray(value: unknown, context: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${context} must be a non-empty array of http or https URL strings.`);
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !isSafeHttpUrl(entry)) {
      errors.push(`${context}.${index} must be an http or https URL string.`);
    }
  });
}

function validateNonEmptyStringArray(value: unknown, context: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    errors.push(`${context} must be a non-empty array of non-empty strings.`);
  }
}

function validateNumericRecord(value: unknown, context: string, errors: string[]): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    errors.push(`${context} must be a non-empty object with finite numeric values.`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      errors.push(`${context}.${key} must be a finite number.`);
    }
  }
}

function validateBoardEvidenceUrls(
  boardEvidence: Record<string, unknown>,
  dayIndex: number,
  itemIndex: number,
  errors: string[]
): void {
  for (const [field, nested] of Object.entries(boardEvidence)) {
    for (const urlValue of collectUrlLikeStrings(nested)) {
      validateSafeUrl(urlValue, `board-day evidence days.${dayIndex}.items.${itemIndex}.boardEvidence.${field}`, errors);
    }
  }
}

function collectUrlLikeStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return /^https?:\/\//iu.test(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectUrlLikeStrings);
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(collectUrlLikeStrings);
  }

  return [];
}

function collectUnsafeValues(value: unknown, pathParts: readonly string[], errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectUnsafeValues(entry, [...pathParts, String(index)], errors));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (isSecretLikeKey(key)) {
        errors.push(`board-day evidence must not contain secret-like key at ${[...pathParts, key].join(".")}.`);
      }
      collectUnsafeValues(nested, [...pathParts, key], errors);
    }
    return;
  }
  collectUnsafeString(value, pathParts, errors);
}

function collectUnsafeString(value: unknown, pathParts: readonly string[], errors: string[]): void {
  if (typeof value !== "string") {
    return;
  }
  const location = pathParts.join(".");
  if (isSecretLikeValue(value)) {
    errors.push(`board-day evidence must not contain secret-like value at ${location}.`);
  }
  if (isFilesystemLikeValue(value)) {
    errors.push(`board-day evidence must not contain filesystem-like value at ${location}.`);
  }
}

function collectFakeClosureFields(value: unknown, pathParts: readonly string[], errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectFakeClosureFields(entry, [...pathParts, String(index)], errors));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isFakeClosureKey(key) && (nested === true || isFakeClosureValue(nested))) {
      errors.push(`board-day evidence must not contain fake closure field ${[...pathParts, key].join(".")}.`);
    }
    if (typeof nested === "string" && isFakeClosureStatus(key, nested)) {
      errors.push(`board-day evidence must not contain fake closure status at ${[...pathParts, key].join(".")}.`);
    }
    collectFakeClosureFields(nested, [...pathParts, key], errors);
  }
}

function validateSafeUrl(value: string, context: string, errors: string[]): void {
  const url = parseUrl(value);
  if (url === undefined) {
    return;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    errors.push(`${context} must not include URL credentials.`);
  }
}

function isSecretLikeKey(value: string): boolean {
  return /api[_-]?key|bearer|token|secret|cookie|password|authorization|auth/iu.test(value);
}

function isSecretLikeValue(value: string): boolean {
  const urlValue = endpointUrlPart(value) ?? value;
  return (
    hasUrlCredentials(urlValue) ||
    /\bauthorization\s*[:=]/iu.test(value) ||
    /\bbearer\s+\S+/iu.test(value) ||
    /\bcookie\s*[:=]/iu.test(value) ||
    /[?&][^=\s&]*(?:token|key|secret|authorization|auth|cookie|session|sid|password)[^=\s&]*=[^\s&]+/iu.test(urlValue) ||
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|auth|session|sid|password|private[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s;,)&]+/iu.test(
      value
    )
  );
}

function isFilesystemLikeValue(value: string): boolean {
  const pathValue = endpointUrlPart(value) ?? value;
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(pathValue)) {
    const lowerValue = pathValue.toLowerCase();
    return (
      lowerValue.startsWith("file://") ||
      pathValue.includes("G:/") ||
      pathValue.includes("G:\\") ||
      /(^|[\\/])\.\.([\\/]|$)/u.test(pathValue)
    );
  }

  return (
    /^[A-Z]:[\\/]/iu.test(pathValue) ||
    /^\\\\/u.test(pathValue) ||
    pathValue.startsWith("/") ||
    pathValue.includes("G:/") ||
    pathValue.includes("G:\\") ||
    /(^|[\\/])\.\.([\\/]|$)/u.test(pathValue)
  );
}

function isFakeClosureKey(value: string): boolean {
  return /(?:m2|handsFree|closure).*(?:closed|close|complete|completed|verified)|(?:closed|complete|completed|verified).*(?:m2|handsFree|closure)/iu.test(
    value
  );
}

function isFakeClosureStatus(key: string, value: string): boolean {
  return /(?:status|state|result)$/iu.test(key) && /^(verified|complete|completed|closed|passed)$/iu.test(value);
}

function isFakeClosureValue(value: unknown): boolean {
  return typeof value === "string" && /^(verified|complete|completed|closed|passed)$/iu.test(value);
}

function hasUrlCredentials(value: string): boolean {
  const url = parseUrl(value);
  return url !== undefined && (url.username.length > 0 || url.password.length > 0);
}

function isSafeHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return url !== undefined && (url.protocol === "http:" || url.protocol === "https:") && !hasUrlCredentials(value);
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function endpointUrlPart(value: string): string | undefined {
  return /^(GET|POST)\s+(.+)$/u.exec(value)?.[2];
}

function hasConsecutiveDailyDates(days: readonly ManifestDay[]): boolean {
  if (days.length < 2 || days.some((day) => !isManifestDay(day) || !/^\d{4}-\d{2}-\d{2}$/u.test(day.date))) {
    return false;
  }
  for (let index = 1; index < days.length; index += 1) {
    if (addDays(days[index - 1]?.date ?? "", 1) !== days[index]?.date) {
      return false;
    }
  }

  return true;
}

function observedKeys(days: readonly BoardDayEvidenceDay[]): readonly string[] {
  return days.flatMap((day) => day.items.map((item) => `${day.date} ${itemKey(item)}`));
}

function itemKey(item: Pick<ManifestItem, "role" | "phase" | "actionType">): string {
  return `${item.role}:${item.phase}:${item.actionType}`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((value) => right.includes(value));
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);

  return parsed.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManifestDay(value: unknown): value is ManifestDay {
  return isRecord(value) && typeof value.date === "string" && Array.isArray(value.items);
}

function isManifestItem(value: unknown): value is ManifestItem {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    typeof value.phase === "string" &&
    typeof value.actionType === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.requiredSourceEndpoints) &&
    Array.isArray(value.requiredBoardEvidence)
  );
}
