import type Database from "better-sqlite3";

export interface OpsDashboardSummary {
  readonly generatedAt: string;
  readonly tableCounts: Record<string, number>;
  readonly sourceAdapters: Array<{ adapterId: string; sourceCount: number; failedCount: number }>;
  readonly publicPageCount: number;
  readonly privatePageCount: number;
  readonly masteryCount: number;
  readonly recentTraceEventCount: number;
}

const DASHBOARD_TABLES = ["sources", "chunks", "concepts", "pages", "mastery", "trace_events"] as const;

type DashboardTable = (typeof DASHBOARD_TABLES)[number];

export function buildOpsDashboardSummary(
  db: Database.Database,
  options?: { now?: () => Date }
): OpsDashboardSummary {
  const now = options?.now?.() ?? new Date();
  const generatedAt = now.toISOString();
  const recentCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const tableCounts = Object.fromEntries(DASHBOARD_TABLES.map((table) => [table, countRows(db, table)]));
  const pageCounts = countPagesByVisibility(db);

  return {
    generatedAt,
    tableCounts,
    sourceAdapters: listSourceAdapterSummaries(db),
    publicPageCount: pageCounts.public,
    privatePageCount: pageCounts.private,
    masteryCount: tableCounts.mastery,
    recentTraceEventCount: countRecentTraceEvents(db, recentCutoff)
  };
}

function countRows(db: Database.Database, table: DashboardTable): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function listSourceAdapterSummaries(
  db: Database.Database
): Array<{ adapterId: string; sourceCount: number; failedCount: number }> {
  return db
    .prepare(
      `SELECT
         adapter_id AS adapterId,
         COUNT(*) AS sourceCount,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failedCount
       FROM sources
       GROUP BY adapter_id
       ORDER BY adapter_id`
    )
    .all() as Array<{ adapterId: string; sourceCount: number; failedCount: number }>;
}

function countPagesByVisibility(db: Database.Database): { public: number; private: number } {
  const rows = db
    .prepare(
      `SELECT visibility, COUNT(*) AS count
       FROM pages
       WHERE visibility IN ('public', 'private')
       GROUP BY visibility`
    )
    .all() as Array<{ visibility: "public" | "private"; count: number }>;

  return rows.reduce(
    (counts, row) => ({
      ...counts,
      [row.visibility]: row.count
    }),
    { public: 0, private: 0 }
  );
}

function countRecentTraceEvents(db: Database.Database, recentCutoff: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM trace_events
       WHERE timestamp >= ?`
    )
    .get(recentCutoff) as { count: number };

  return row.count;
}
