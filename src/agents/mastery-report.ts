import { redactText } from "./http-clients.js";

export interface ScholarMasteryReportContext {
  readonly date: string;
  readonly sourceEndpointLabel?: string;
}

export interface MasterySummaryRow {
  readonly conceptSlug: string;
  readonly conceptName: string;
  readonly score: number;
  readonly confidence: number;
  readonly attemptsN: number;
  readonly lastSeenAt: string | null;
}

export interface MasterySummaryDiagnosis {
  readonly runId?: string;
  readonly weakSpots: readonly MasterySummaryRow[];
}

export interface MasterySummaryData {
  readonly masteryRows: readonly MasterySummaryRow[];
  readonly diagnosis: MasterySummaryDiagnosis;
}

export class MasteryReportRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasteryReportRenderError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function renderScholarMasteryReportBody(summaryBody: unknown, context: ScholarMasteryReportContext): string {
  const date = requireNonEmptyString(context.date, "context.date");
  const source = formatSourceEndpointLabel(context.sourceEndpointLabel);
  const summary = parseSummaryData(summaryBody);
  const topWeakSpot = summary.diagnosis.weakSpots[0];

  return [
    "Scholar mastery summary",
    `Date: ${redactText(date)}`,
    `Source: ${source}`,
    `Mastery rows: ${summary.masteryRows.length}`,
    `Weak spots: ${summary.diagnosis.weakSpots.length}`,
    `Top weak spot: ${formatTopWeakSpot(topWeakSpot)}`,
    `Diagnosis run: ${formatOptionalString(summary.diagnosis.runId)}`,
    `Rows: ${formatRows(summary.masteryRows)}`,
    "Boundary: renderer only; no API call, no Multica call, no live M2 proof."
  ].join("\n");
}

function parseSummaryData(summaryBody: unknown): MasterySummaryData {
  const body = requireRecord(summaryBody, "summaryBody");
  return parseApiSuccessBody(body);
}

function parseApiSuccessBody(body: Record<string, unknown>): MasterySummaryData {
  if (body.ok !== true || body.routeId !== "mastery.summary") {
    throw new MasteryReportRenderError("summaryBody must be a mastery.summary success body.");
  }

  return parseDirectData(requireRecord(body.data, "summaryBody.data"), "summaryBody.data");
}

function parseDirectData(body: Record<string, unknown>, path: string): MasterySummaryData {
  return {
    masteryRows: requireRows(body.masteryRows, `${path}.masteryRows`),
    diagnosis: parseDiagnosis(body.diagnosis, `${path}.diagnosis`)
  };
}

function parseDiagnosis(value: unknown, path: string): MasterySummaryDiagnosis {
  const body = requireRecord(value, path);
  const runId = optionalString(body.runId, `${path}.runId`);

  return {
    ...(runId === undefined ? {} : { runId }),
    weakSpots: requireRows(body.weakSpots, `${path}.weakSpots`)
  };
}

function requireRows(value: unknown, path: string): MasterySummaryRow[] {
  if (!Array.isArray(value)) {
    throw new MasteryReportRenderError(`${path} must be an array.`);
  }

  return value.map((entry, index) => parseRow(entry, `${path}[${index}]`));
}

function parseRow(value: unknown, path: string): MasterySummaryRow {
  const body = requireRecord(value, path);

  return {
    conceptSlug: requireNonEmptyString(body.conceptSlug, `${path}.conceptSlug`),
    conceptName: requireNonEmptyString(body.conceptName, `${path}.conceptName`),
    score: requireUnitInterval(body.score, `${path}.score`),
    confidence: requireUnitInterval(body.confidence, `${path}.confidence`),
    attemptsN: requireNonnegativeSafeInteger(body.attemptsN, `${path}.attemptsN`),
    lastSeenAt: optionalNullableString(body.lastSeenAt, `${path}.lastSeenAt`)
  };
}

function formatTopWeakSpot(row: MasterySummaryRow | undefined): string {
  if (row === undefined) {
    return "none";
  }

  return `${redactReportText(row.conceptSlug)} (score ${formatNumber(row.score)})`;
}

function formatRows(rows: readonly MasterySummaryRow[]): string {
  if (rows.length === 0) {
    return "none";
  }

  return rows
    .map(
      (row) =>
        `${redactReportText(row.conceptSlug)} / ${redactReportText(row.conceptName)}: score ${formatNumber(
          row.score
        )}, confidence ${formatNumber(row.confidence)}, attempts ${row.attemptsN}, last seen ${formatOptionalString(
          row.lastSeenAt
        )}`
    )
    .join("; ");
}

function formatOptionalString(value: string | null | undefined): string {
  return value === undefined || value === null || value.length === 0 ? "none" : redactReportText(value);
}

function formatSourceEndpointLabel(value: string | undefined): string {
  const label = value ?? "GET /api/mastery/summary";
  if (label === "GET /api/mastery/summary") {
    return label;
  }

  return redactReportText(label);
}

function redactReportText(value: string): string {
  return redactText(redactEmbeddedUrls(value));
}

function redactEmbeddedUrls(value: string): string {
  return value.replace(/\b(?:https?|file):\/\/[^\s;,)]*/giu, (url) => redactReportUrl(url));
}

function redactReportUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username.length > 0) {
      url.username = "REDACTED";
    }
    if (url.password.length > 0) {
      url.password = "REDACTED";
    }
    url.pathname = redactSensitivePathname(url.pathname);
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveToken(key)) {
        url.searchParams.set(key, "REDACTED");
      }
    }

    return url.toString();
  } catch {
    return value;
  }
}

function redactSensitivePathname(pathname: string): string {
  const segments = pathname.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (isSensitiveToken(decodeURIComponent(segments[index] ?? "")) && (segments[index + 1]?.length ?? 0) > 0) {
      segments[index + 1] = "REDACTED";
    }
  }

  return segments.join("/");
}

function isSensitiveToken(value: string): boolean {
  return /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization|auth|cookie|session|sid|password)$/iu.test(
    value
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toString();
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MasteryReportRenderError(`${path} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MasteryReportRenderError(`${path} must be a non-empty string.`);
  }

  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireNonEmptyString(value, path);
}

function optionalNullableString(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }

  return requireNonEmptyString(value, path);
}

function requireUnitInterval(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MasteryReportRenderError(`${path} must be a finite number.`);
  }
  if (value < 0 || value > 1) {
    throw new MasteryReportRenderError(`${path} must be between 0 and 1.`);
  }

  return value;
}

function requireNonnegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MasteryReportRenderError(`${path} must be a nonnegative safe integer.`);
  }

  return value;
}
