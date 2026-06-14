import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import {
  normalizeHealthMetricInput,
  type HealthMetricInput,
  type HealthMetricQuery,
  type StoredHealthMetric,
  type StoredHealthTraceEvent,
  type StoredMetricAuditEvent,
  type StoredMetricImport
} from "./schema.js";
import {
  getHealthMetricById,
  insertHealthMetric,
  insertHealthTraceEvent,
  insertMetricAuditEvent,
  listHealthMetrics,
  reserveMetricImportRecord,
  updateHealthMetricRow
} from "./store.js";

export interface CreateHealthMetricResult {
  readonly metric: StoredHealthMetric;
  readonly traceEvents: readonly StoredHealthTraceEvent[];
}

export interface HealthMetricCreateOptions {
  readonly now?: string;
  readonly runId?: string;
}

export interface HealthMetricUpdateInput {
  readonly id: number;
  readonly changes: {
    readonly metricKey?: string;
    readonly metricLabel?: string;
    readonly value?: number;
    readonly unit?: string;
    readonly observedAt?: string;
    readonly note?: string;
  };
  readonly changedBy: "cli" | "api";
  readonly reason: string;
  readonly now?: string;
  readonly runId?: string;
}

export interface HealthMetricUpdateResult {
  readonly metric: StoredHealthMetric;
  readonly audit: StoredMetricAuditEvent & {
    readonly previous: StoredHealthMetric;
    readonly next: StoredHealthMetric;
  };
  readonly traceEvents: readonly StoredHealthTraceEvent[];
}

export interface HealthMetricCsvImportInput {
  readonly sourceFilename: string;
  readonly csvText: string;
  readonly importedAt?: string;
  readonly runId?: string;
}

export type HealthMetricCsvImportRowResult =
  | {
      readonly rowNumber: number;
      readonly status: "accepted";
      readonly metric: StoredHealthMetric;
    }
  | {
      readonly rowNumber: number;
      readonly status: "rejected";
      readonly error: string;
    };

export interface HealthMetricCsvImportResult {
  readonly importRecord: StoredMetricImport;
  readonly duplicate: boolean;
  readonly rows: readonly HealthMetricCsvImportRowResult[];
  readonly traceEvents: readonly StoredHealthTraceEvent[];
}

type PendingCsvRow =
  | {
      readonly rowNumber: number;
      readonly status: "accepted";
      readonly input: HealthMetricInput;
    }
  | {
      readonly rowNumber: number;
      readonly status: "rejected";
      readonly error: string;
    };

const CSV_HEADERS = ["metric_key", "metric_label", "value", "unit", "observed_at", "note"] as const;
const SUPPORTED_CSV_IMPORT_HEADERS = [...CSV_HEADERS, "source"] as const;
const REQUIRED_CSV_HEADERS = ["metric_key", "metric_label", "value", "unit", "observed_at"] as const;

export function createHealthMetric(
  db: Database.Database,
  input: HealthMetricInput,
  options: HealthMetricCreateOptions = {}
): CreateHealthMetricResult {
  const now = options.now ?? new Date().toISOString();
  const transaction = db.transaction((): CreateHealthMetricResult => {
    const metric = insertHealthMetric(db, input, { now });
    const trace = insertHealthTraceEvent(db, {
      runId: options.runId ?? `health-metric-create-${metric.id}`,
      stage: "metric",
      level: "info",
      message: "Health metric created",
      timestamp: now,
      data: { metricId: metric.id, metricKey: metric.metricKey }
    });

    return { metric, traceEvents: [trace] };
  });

  return transaction();
}

export function updateHealthMetric(db: Database.Database, input: HealthMetricUpdateInput): HealthMetricUpdateResult {
  const changedAt = input.now ?? new Date().toISOString();
  const runId = input.runId ?? `health-metric-update-${input.id}`;
  const transaction = db.transaction((): HealthMetricUpdateResult => {
    const previous = getHealthMetricById(db, input.id);
    if (previous === undefined) {
      throw new Error("health metric not found");
    }

    const nextInput = normalizeHealthMetricInput({
      metricKey: input.changes.metricKey ?? previous.metricKey,
      metricLabel: input.changes.metricLabel ?? previous.metricLabel,
      value: input.changes.value ?? previous.value,
      unit: input.changes.unit ?? previous.unit,
      observedAt: input.changes.observedAt ?? previous.observedAt,
      source: previous.source,
      ...(input.changes.note !== undefined
        ? { note: input.changes.note }
        : previous.note === undefined
          ? {}
          : { note: previous.note })
    });

    if (!hasMetricChanged(previous, nextInput)) {
      throw new Error("metric update must change at least one field");
    }

    const metric = updateHealthMetricRow(db, input.id, nextInput, { now: changedAt });
    const audit = insertMetricAuditEvent(db, {
      metricId: metric.id,
      changedAt,
      changedBy: input.changedBy,
      previous,
      next: metric,
      reason: input.reason
    });
    const trace = insertHealthTraceEvent(db, {
      runId,
      stage: "metric",
      level: "info",
      message: "Health metric updated",
      timestamp: changedAt,
      data: { metricId: metric.id, auditId: audit.id }
    });

    return {
      metric,
      audit: { ...audit, previous, next: metric },
      traceEvents: [trace]
    };
  });

  return transaction();
}

export function queryHealthMetrics(db: Database.Database, query: HealthMetricQuery): StoredHealthMetric[] {
  return listHealthMetrics(db, query);
}

export function importHealthMetricsCsv(
  db: Database.Database,
  input: HealthMetricCsvImportInput
): HealthMetricCsvImportResult {
  const normalizedCsvText = normalizeCsvText(input.csvText);
  if (normalizedCsvText.trim().length === 0) {
    throw new Error("csvText is required");
  }

  const contentHash = hashCsvContent(normalizedCsvText);
  const pendingRows = parseHealthMetricCsvRows(normalizedCsvText);
  const importedAt = input.importedAt ?? new Date().toISOString();
  const acceptedCount = pendingRows.filter((row) => row.status === "accepted").length;
  const rejectedCount = pendingRows.length - acceptedCount;
  const transaction = db.transaction((): HealthMetricCsvImportResult => {
    const reservation = reserveMetricImportRecord(db, {
      sourceFilename: input.sourceFilename,
      rowCount: pendingRows.length,
      acceptedCount,
      rejectedCount,
      importedAt,
      contentHash
    });
    if (!reservation.created) {
      return {
        importRecord: reservation.importRecord,
        duplicate: true,
        rows: [],
        traceEvents: []
      };
    }

    const rows: HealthMetricCsvImportRowResult[] = [];

    for (const row of pendingRows) {
      if (row.status === "rejected") {
        rows.push(row);
        continue;
      }

      const metric = insertHealthMetric(db, row.input, { now: importedAt });
      rows.push({ rowNumber: row.rowNumber, status: "accepted", metric });
    }

    const trace = insertHealthTraceEvent(db, {
      runId: input.runId ?? `health-metrics-csv-import-${reservation.importRecord.id}`,
      stage: "metric",
      level: rejectedCount > 0 ? "warn" : "info",
      message: "Health metrics CSV imported",
      timestamp: importedAt,
      data: {
        importId: reservation.importRecord.id,
        sourceFilename: reservation.importRecord.sourceFilename,
        acceptedCount,
        rejectedCount
      }
    });

    return {
      importRecord: reservation.importRecord,
      duplicate: false,
      rows,
      traceEvents: [trace]
    };
  });

  return transaction();
}

export function exportHealthMetricsCsvRows(metrics: readonly StoredHealthMetric[]): string {
  const header = CSV_HEADERS.join(",");
  const rows = metrics.map((metric) =>
    [
      metric.metricKey,
      metric.metricLabel,
      formatMetricValue(metric.value),
      metric.unit,
      metric.observedAt,
      metric.note ?? ""
    ]
      .map(formatCsvCell)
      .join(",")
  );

  return [header, ...rows].join("\n");
}

function hasMetricChanged(previous: StoredHealthMetric, next: HealthMetricInput): boolean {
  return (
    previous.metricKey !== next.metricKey ||
    previous.metricLabel !== next.metricLabel ||
    !Object.is(previous.value, next.value) ||
    previous.unit !== next.unit ||
    previous.observedAt !== next.observedAt ||
    (previous.note ?? undefined) !== (next.note ?? undefined)
  );
}

function parseHealthMetricCsvRows(csvText: string): readonly PendingCsvRow[] {
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    throw new Error("CSV must include a header row");
  }

  const headers = rows[0].map((header) => header.trim());
  const headerIndexes = new Map(headers.map((header, index) => [header, index]));
  for (const header of headers) {
    assertSupportedCsvHeader(header);
  }
  for (const requiredHeader of REQUIRED_CSV_HEADERS) {
    if (!headerIndexes.has(requiredHeader)) {
      throw new Error(`CSV is missing ${requiredHeader} column`);
    }
  }

  const pendingRows: PendingCsvRow[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.every((cell) => cell.trim().length === 0)) {
      continue;
    }

    const rowNumber = rowIndex + 1;
    try {
      assertCsvImportSource(readOptionalCsvCell(row, headerIndexes, "source"));
      const input = normalizeHealthMetricInput({
        metricKey: readRequiredCsvCell(row, headerIndexes, "metric_key"),
        metricLabel: readRequiredCsvCell(row, headerIndexes, "metric_label"),
        value: parseCsvMetricValue(readRequiredCsvCell(row, headerIndexes, "value")),
        unit: readRequiredCsvCell(row, headerIndexes, "unit"),
        observedAt: readRequiredCsvCell(row, headerIndexes, "observed_at"),
        source: "csv",
        ...(headerIndexes.has("note") ? { note: readOptionalCsvCell(row, headerIndexes, "note") } : {})
      });
      pendingRows.push({ rowNumber, status: "accepted", input });
    } catch (error) {
      pendingRows.push({ rowNumber, status: "rejected", error: errorMessage(error) });
    }
  }

  return pendingRows;
}

function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterClosingQuote = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];

    if (inQuotes) {
      if (char === '"') {
        if (csvText[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (afterClosingQuote) {
      if (char === ",") {
        row.push(field);
        field = "";
        afterClosingQuote = false;
        continue;
      }
      if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        afterClosingQuote = false;
        continue;
      }
      throw new Error("CSV quoted field must end before delimiter");
    }

    if (char === '"') {
      if (field.length > 0) {
        throw new Error("CSV quote must start a quoted field");
      }
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error("CSV quoted field is not closed");
  }

  row.push(field);
  rows.push(row);
  return rows;
}

function assertSupportedCsvHeader(header: string): void {
  if ((SUPPORTED_CSV_IMPORT_HEADERS as readonly string[]).includes(header)) {
    return;
  }
  throw new Error(`CSV column is not supported: ${header}`);
}

function assertCsvImportSource(value: string): void {
  const text = value.trim();
  if (text.length === 0 || text === "csv") {
    return;
  }
  throw new Error("source must be csv for import");
}

function readRequiredCsvCell(row: readonly string[], headerIndexes: ReadonlyMap<string, number>, header: string): string {
  return row[requiredHeaderIndex(headerIndexes, header)] ?? "";
}

function readOptionalCsvCell(row: readonly string[], headerIndexes: ReadonlyMap<string, number>, header: string): string {
  const index = headerIndexes.get(header);
  return index === undefined ? "" : row[index] ?? "";
}

function requiredHeaderIndex(headerIndexes: ReadonlyMap<string, number>, header: string): number {
  const index = headerIndexes.get(header);
  if (index === undefined) {
    throw new Error(`CSV is missing ${header} column`);
  }
  return index;
}

function parseCsvMetricValue(value: string): number {
  const text = value.trim();
  return text.length === 0 ? Number.NaN : Number(text);
}

function normalizeCsvText(value: string): string {
  if (typeof value !== "string") {
    throw new Error("csvText must be text");
  }

  let normalized = value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (normalized.endsWith("\n")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function hashCsvContent(csvText: string): string {
  return `sha256:${createHash("sha256").update(csvText).digest("hex")}`;
}

function formatMetricValue(value: number): string {
  return String(value);
}

function formatCsvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
