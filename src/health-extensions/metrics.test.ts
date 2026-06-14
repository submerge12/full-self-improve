import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import {
  createHealthMetric,
  exportHealthMetricsCsvRows,
  importHealthMetricsCsv,
  queryHealthMetrics,
  updateHealthMetric
} from "./metrics.js";

describe("health metrics domain", () => {
  test("normalizes metric keys and rejects non-finite values through create/query", () => {
    const db = migratedDb();

    try {
      const created = createHealthMetric(db, {
        metricKey: " Weight Value ",
        metricLabel: "Weight",
        value: 58.2,
        unit: "kg",
        observedAt: "2026-06-14T08:00:00.000Z",
        source: "manual"
      });

      expect(created.metric).toMatchObject({ metricKey: "weight-value", value: 58.2 });
      expect(created.traceEvents).toMatchObject([{ stage: "metric", message: "Health metric created" }]);
      expect(queryHealthMetrics(db, { metricKey: "weight value" })).toMatchObject([{ id: created.metric.id }]);
      expect(() =>
        createHealthMetric(db, {
          metricKey: "weight",
          metricLabel: "Weight",
          value: Number.POSITIVE_INFINITY,
          unit: "kg",
          observedAt: "2026-06-14T08:01:00.000Z",
          source: "manual"
        })
      ).toThrow("value must be finite");
      expect(tableCount(db, "health_metrics")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("uses explicit create timestamp and run id for deterministic outputs", () => {
    const db = migratedDb();

    try {
      const created = createHealthMetric(
        db,
        {
          metricKey: "Weight",
          metricLabel: "Weight",
          value: 58.2,
          unit: "kg",
          observedAt: "2026-06-14T08:00:00.000Z",
          source: "manual"
        },
        { now: "2026-06-14T08:01:00.000Z", runId: "health-metric-create-deterministic" }
      );

      expect(created.metric.createdAt).toBe("2026-06-14T08:01:00.000Z");
      expect(created.metric.updatedAt).toBe("2026-06-14T08:01:00.000Z");
      expect(created.traceEvents).toMatchObject([
        {
          runId: "health-metric-create-deterministic",
          timestamp: "2026-06-14T08:01:00.000Z",
          message: "Health metric created"
        }
      ]);
    } finally {
      db.close();
    }
  });

  test("returns stable inclusive date-window queries ordered by observed time then id", () => {
    const db = migratedDb();

    try {
      const beforeWindow = createHealthMetric(db, {
        metricKey: "sleep",
        metricLabel: "Sleep",
        value: 6,
        unit: "hours",
        observedAt: "2026-06-13T23:59:59.999Z",
        source: "manual"
      });
      const atStart = createHealthMetric(db, {
        metricKey: "sleep",
        metricLabel: "Sleep",
        value: 6.5,
        unit: "hours",
        observedAt: "2026-06-14T00:00:00.000Z",
        source: "manual"
      });
      const sameInstantFirst = createHealthMetric(db, {
        metricKey: "sleep",
        metricLabel: "Sleep",
        value: 7,
        unit: "hours",
        observedAt: "2026-06-14T07:00:00.000Z",
        source: "manual"
      });
      const sameInstantSecond = createHealthMetric(db, {
        metricKey: "sleep",
        metricLabel: "Sleep",
        value: 7.25,
        unit: "hours",
        observedAt: "2026-06-14T07:00:00.000Z",
        source: "manual"
      });
      const atEnd = createHealthMetric(db, {
        metricKey: "sleep",
        metricLabel: "Sleep",
        value: 7.5,
        unit: "hours",
        observedAt: "2026-06-15T00:00:00.000Z",
        source: "manual"
      });

      expect(
        queryHealthMetrics(db, {
          metricKey: "Sleep",
          observedFrom: "2026-06-14T00:00:00.000Z",
          observedTo: "2026-06-15T00:00:00.000Z"
        }).map((metric) => metric.id)
      ).toEqual([atStart.metric.id, sameInstantFirst.metric.id, sameInstantSecond.metric.id, atEnd.metric.id]);
      expect(queryHealthMetrics(db, { observedTo: "2026-06-13T23:59:59.999Z" })).toMatchObject([
        { id: beforeWindow.metric.id }
      ]);
    } finally {
      db.close();
    }
  });

  test("reports accepted and rejected CSV rows while importing valid rows", () => {
    const db = migratedDb();

    try {
      const result = importHealthMetricsCsv(db, {
        sourceFilename: "metrics.csv",
        csvText: [
          "metric_key,metric_label,value,unit,observed_at,note",
          "Weight,Weight,58.2,kg,2026-06-14T08:00:00.000Z,morning",
          "Sleep,Sleep,not-a-number,hours,2026-06-14T07:00:00.000Z,bad value"
        ].join("\n"),
        importedAt: "2026-06-14T09:00:00.000Z",
        runId: "metrics-import-report"
      });

      expect(result.duplicate).toBe(false);
      expect(result.importRecord).toMatchObject({ rowCount: 2, acceptedCount: 1, rejectedCount: 1 });
      expect(result.rows).toMatchObject([
        { rowNumber: 2, status: "accepted", metric: { metricKey: "weight", source: "csv", note: "morning" } },
        { rowNumber: 3, status: "rejected", error: "value must be finite" }
      ]);
      expect(result.rows[0]).toMatchObject({
        status: "accepted",
        metric: {
          createdAt: "2026-06-14T09:00:00.000Z",
          updatedAt: "2026-06-14T09:00:00.000Z"
        }
      });
      expect(result.traceEvents).toMatchObject([{ stage: "metric", message: "Health metrics CSV imported" }]);
      expect(tableCount(db, "health_metrics")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("does not import manual or mock observations from a CSV source column", () => {
    for (const source of ["manual", "mock"] as const) {
      const db = migratedDb();

      try {
        const result = importHealthMetricsCsv(db, {
          sourceFilename: `${source}-metrics.csv`,
          csvText: [
            "metric_key,metric_label,value,unit,observed_at,source,note",
            `Weight,Weight,58.2,kg,2026-06-14T08:00:00.000Z,${source},bad source`
          ].join("\n"),
          importedAt: "2026-06-14T09:00:00.000Z",
          runId: `metrics-import-source-${source}`
        });

        expect(result.importRecord).toMatchObject({ rowCount: 1, acceptedCount: 0, rejectedCount: 1 });
        expect(result.rows).toMatchObject([{ rowNumber: 2, status: "rejected", error: "source must be csv for import" }]);
        expect(tableCount(db, "health_metric_imports")).toBe(1);
        expect(tableCount(db, "health_metrics")).toBe(0);
      } finally {
        db.close();
      }
    }
  });

  test("accepts a legacy CSV source column only when it is csv", () => {
    const db = migratedDb();

    try {
      const result = importHealthMetricsCsv(db, {
        sourceFilename: "metrics.csv",
        csvText: [
          "metric_key,metric_label,value,unit,observed_at,source,note",
          "Weight,Weight,58.2,kg,2026-06-14T08:00:00.000Z,csv,morning"
        ].join("\n"),
        importedAt: "2026-06-14T09:00:00.000Z",
        runId: "metrics-import-source-csv"
      });

      expect(result.importRecord).toMatchObject({ rowCount: 1, acceptedCount: 1, rejectedCount: 0 });
      expect(result.rows).toMatchObject([{ rowNumber: 2, status: "accepted", metric: { source: "csv" } }]);
      expect(tableCount(db, "health_metrics")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("reserves the CSV import hash before inserting metric observations", () => {
    const db = migratedDb();
    const csvText = [
      "metric_key,metric_label,value,unit,observed_at,note",
      "Weight,Weight,58.2,kg,2026-06-14T08:00:00.000Z,morning"
    ].join("\n");
    const contentHash = metricCsvHash(csvText);

    try {
      db.prepare(
        `CREATE TRIGGER health_metrics_require_import_reservation
         BEFORE INSERT ON health_metrics
         WHEN (SELECT COUNT(*) FROM health_metric_imports WHERE content_hash = '${contentHash}') = 0
         BEGIN
           SELECT RAISE(ABORT, 'metric import record must be reserved before observations');
         END`
      ).run();

      const result = importHealthMetricsCsv(db, {
        sourceFilename: "metrics.csv",
        csvText,
        importedAt: "2026-06-14T09:00:00.000Z",
        runId: "metrics-import-reservation"
      });

      expect(result.duplicate).toBe(false);
      expect(result.importRecord.contentHash).toBe(contentHash);
      expect(tableCount(db, "health_metric_imports")).toBe(1);
      expect(tableCount(db, "health_metrics")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("exits duplicate CSV import path before inserting observations when hash already exists", () => {
    const db = migratedDb();
    const csvText = [
      "metric_key,metric_label,value,unit,observed_at,note",
      "Weight,Weight,58.2,kg,2026-06-14T08:00:00.000Z,morning"
    ].join("\n");
    const contentHash = metricCsvHash(csvText);

    try {
      db.prepare(
        `INSERT INTO health_metric_imports
           (source_filename, row_count, accepted_count, rejected_count, imported_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("already-reserved.csv", 1, 1, 0, "2026-06-14T08:59:00.000Z", contentHash);

      const result = importHealthMetricsCsv(db, {
        sourceFilename: "metrics.csv",
        csvText,
        importedAt: "2026-06-14T09:00:00.000Z",
        runId: "metrics-import-duplicate-reserved"
      });

      expect(result).toMatchObject({ duplicate: true, rows: [], traceEvents: [] });
      expect(result.importRecord.contentHash).toBe(contentHash);
      expect(tableCount(db, "health_metric_imports")).toBe(1);
      expect(tableCount(db, "health_metrics")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("detects duplicate CSV imports by content hash without inserting metrics again", () => {
    const db = migratedDb();
    const csvText = [
      "metric_key,metric_label,value,unit,observed_at,note",
      "Weight,Weight,58.2,kg,2026-06-14T08:00:00.000Z,morning"
    ].join("\n");

    try {
      const first = importHealthMetricsCsv(db, {
        sourceFilename: "metrics.csv",
        csvText,
        importedAt: "2026-06-14T09:00:00.000Z",
        runId: "metrics-import-first"
      });
      const second = importHealthMetricsCsv(db, {
        sourceFilename: "metrics-copy.csv",
        csvText,
        importedAt: "2026-06-14T10:00:00.000Z",
        runId: "metrics-import-second"
      });

      expect(first.duplicate).toBe(false);
      expect(second).toMatchObject({ duplicate: true, importRecord: { id: first.importRecord.id }, rows: [] });
      expect(tableCount(db, "health_metric_imports")).toBe(1);
      expect(tableCount(db, "health_metrics")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("exports stable CSV rows that can be imported into an empty database", () => {
    const db = migratedDb();
    const roundTripDb = migratedDb();

    try {
      createHealthMetric(db, {
        metricKey: "Weight",
        metricLabel: "Weight",
        value: 58.2,
        unit: "kg",
        observedAt: "2026-06-14T08:00:00.000Z",
        source: "manual",
        note: "morning, fasted"
      });
      createHealthMetric(db, {
        metricKey: "Sleep",
        metricLabel: "Sleep",
        value: 7.5,
        unit: "hours",
        observedAt: "2026-06-14T07:00:00.000Z",
        source: "mock"
      });

      const csvText = exportHealthMetricsCsvRows(queryHealthMetrics(db, {}));
      expect(csvText.split("\n")[0]).toBe("metric_key,metric_label,value,unit,observed_at,note");

      const imported = importHealthMetricsCsv(roundTripDb, {
        sourceFilename: "round-trip.csv",
        csvText,
        importedAt: "2026-06-14T09:00:00.000Z",
        runId: "metrics-round-trip"
      });

      expect(imported.importRecord).toMatchObject({ rowCount: 2, acceptedCount: 2, rejectedCount: 0 });
      expect(projectMetricValues(queryHealthMetrics(roundTripDb, {}))).toEqual(projectMetricValues(queryHealthMetrics(db, {})));
      expect(queryHealthMetrics(roundTripDb, {}).map((metric) => metric.source)).toEqual(["csv", "csv"]);
    } finally {
      db.close();
      roundTripDb.close();
    }
  });

  test("rejects quoted CSV fields with trailing content before a delimiter", () => {
    const db = migratedDb();

    try {
      expect(() =>
        importHealthMetricsCsv(db, {
          sourceFilename: "bad-quotes.csv",
          csvText: [
            "metric_key,metric_label,value,unit,observed_at,note",
            '"Weight"x,Weight,58.2,kg,2026-06-14T08:00:00.000Z,morning'
          ].join("\n"),
          importedAt: "2026-06-14T09:00:00.000Z",
          runId: "metrics-import-bad-quotes"
        })
      ).toThrow("CSV quoted field must end before delimiter");
      expect(tableCount(db, "health_metric_imports")).toBe(0);
      expect(tableCount(db, "health_metrics")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("captures the previous metric row inside the update transaction", () => {
    const db = migratedDb();

    try {
      const created = createHealthMetric(db, {
        metricKey: "Weight",
        metricLabel: "Weight",
        value: 58.2,
        unit: "kg",
        observedAt: "2026-06-14T08:00:00.000Z",
        source: "manual"
      });
      let mutatedBeforeTransactionCallback = false;
      const originalTransaction = db.transaction.bind(db);
      const transactionalDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") {
            return (callback: () => unknown) =>
              originalTransaction(() => {
                if (!mutatedBeforeTransactionCallback) {
                  mutatedBeforeTransactionCallback = true;
                  target
                    .prepare("UPDATE health_metrics SET value = ?, updated_at = ? WHERE id = ?")
                    .run(59.0, "2026-06-14T08:04:00.000Z", created.metric.id);
                }
                return callback();
              });
          }

          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as Database.Database;

      const result = updateHealthMetric(transactionalDb, {
        id: created.metric.id,
        changes: { value: 58.0 },
        changedBy: "cli",
        reason: "corrected morning reading",
        now: "2026-06-14T08:05:00.000Z",
        runId: "health-metric-update-transaction-previous"
      });

      expect(result.metric.value).toBe(58.0);
      expect(result.audit.previous.value).toBe(59.0);
      expect(result.audit.previous.updatedAt).toBe("2026-06-14T08:04:00.000Z");
      expect(result.audit.next.value).toBe(58.0);
    } finally {
      db.close();
    }
  });

  test("updates one metric with audit and health trace in one transaction", () => {
    const db = migratedDb();

    try {
      const created = createHealthMetric(db, {
        metricKey: "Weight",
        metricLabel: "Weight",
        value: 58.2,
        unit: "kg",
        observedAt: "2026-06-14T08:00:00.000Z",
        source: "manual"
      });
      const result = updateHealthMetric(db, {
        id: created.metric.id,
        changes: { value: 58.0, note: "scale correction" },
        changedBy: "cli",
        reason: "corrected morning reading",
        now: "2026-06-14T08:05:00.000Z",
        runId: "health-metric-update-test"
      });
      expect(result.metric.value).toBe(58.0);
      expect(result.metric.updatedAt).toBe("2026-06-14T08:05:00.000Z");
      expect(result.audit.previous.value).toBe(58.2);
      expect(result.audit.next.value).toBe(58.0);
      expect(result.traceEvents).toMatchObject([{ stage: "metric", message: "Health metric updated" }]);
      expect(tableCount(db, "health_metric_audit_events")).toBe(1);
      expect(tableCount(db, "health_trace_events")).toBe(2);
    } finally {
      db.close();
    }
  });

  test("rejects no-change updates without writing audit or trace rows", () => {
    const db = migratedDb();

    try {
      const created = createHealthMetric(db, {
        metricKey: "Weight",
        metricLabel: "Weight",
        value: 58.2,
        unit: "kg",
        observedAt: "2026-06-14T08:00:00.000Z",
        source: "manual",
        note: "morning"
      });

      expect(() =>
        updateHealthMetric(db, {
          id: created.metric.id,
          changes: { metricKey: "weight", value: 58.2, note: "morning" },
          changedBy: "api",
          reason: "same values",
          now: "2026-06-14T08:05:00.000Z",
          runId: "health-metric-no-change"
        })
      ).toThrow("metric update must change at least one field");
      expect(tableCount(db, "health_metric_audit_events")).toBe(0);
      expect(tableCount(db, "health_trace_events")).toBe(1);
      expect(queryHealthMetrics(db, { metricKey: "weight" })).toMatchObject([{ value: 58.2, note: "morning" }]);
    } finally {
      db.close();
    }
  });

  test("rolls back the metric update when audit insert fails", () => {
    const db = migratedDb();

    try {
      const created = createHealthMetric(db, {
        metricKey: "Weight",
        metricLabel: "Weight",
        value: 58.2,
        unit: "kg",
        observedAt: "2026-06-14T08:00:00.000Z",
        source: "manual"
      });
      db.prepare("DROP TABLE health_metric_audit_events").run();

      expect(() =>
        updateHealthMetric(db, {
          id: created.metric.id,
          changes: { value: 58.0 },
          changedBy: "cli",
          reason: "corrected morning reading",
          now: "2026-06-14T08:05:00.000Z",
          runId: "health-metric-rollback-test"
        })
      ).toThrow();
      expect(queryHealthMetrics(db, { metricKey: "weight" })).toMatchObject([{ value: 58.2 }]);
      expect(tableCount(db, "health_trace_events")).toBe(1);
    } finally {
      db.close();
    }
  });
});

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function tableCount(
  db: Database.Database,
  tableName: "health_metric_audit_events" | "health_metric_imports" | "health_metrics" | "health_trace_events"
): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

function metricCsvHash(csvText: string): string {
  return `sha256:${createHash("sha256").update(csvText).digest("hex")}`;
}

function projectMetricValues(metrics: ReturnType<typeof queryHealthMetrics>): Array<{
  metricKey: string;
  metricLabel: string;
  value: number;
  unit: string;
  observedAt: string;
  note?: string;
}> {
  return metrics.map((metric) => ({
    metricKey: metric.metricKey,
    metricLabel: metric.metricLabel,
    value: metric.value,
    unit: metric.unit,
    observedAt: metric.observedAt,
    ...(metric.note === undefined ? {} : { note: metric.note })
  }));
}
