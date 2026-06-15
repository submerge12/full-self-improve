import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { createCompassHealthClient } from "./compass-client.js";
import { queryExerciseCompletion, type ExerciseCompletionSummary } from "./exercise.js";
import { queryHealthMetrics } from "./metrics.js";
import { assertIsoDate, assertIsoInstant, type StoredCoachDigestSnapshot, type StoredHealthMetric, type StoredHealthTraceEvent } from "./schema.js";
import { computeSedentarySummary, type SedentarySummary } from "./sedentary.js";
import {
  findCoachDigestSnapshotByDateAndSourceHash,
  getCoachDigestSnapshotById,
  insertCoachDigestSnapshot,
  insertHealthTraceEvent,
  markCoachDigestSnapshotPublished
} from "./store.js";

export interface CoachDigestGenerateInput {
  readonly date: string;
  readonly compass?: { readonly baseUrl: string; readonly bearerToken?: string; readonly fetch: typeof fetch };
  readonly offline?: boolean;
  readonly now?: string;
  readonly runId?: string;
}

export interface CoachDigestSnapshotResult {
  readonly snapshot: StoredCoachDigestSnapshot;
  readonly renderedMarkdown: string;
  readonly sourceHash: string;
  readonly traceEvents: readonly StoredHealthTraceEvent[];
}

export interface CoachDigestPublishAction {
  readonly type: "publish_coach_digest_snapshot";
  readonly date: string;
  readonly sourceHash: string;
  readonly renderedMarkdown: string;
}

export type CoachDigestBoardPublish = (action: CoachDigestPublishAction) => Promise<unknown> | unknown;

export interface CoachDigestPublishInput {
  readonly snapshotId: number;
  readonly dryRun: boolean;
  readonly now?: string;
  readonly publish?: CoachDigestBoardPublish;
}

export type CoachDigestPublishResult =
  | {
      readonly snapshotId: number;
      readonly status: "dry_run";
      readonly intendedAction: CoachDigestPublishAction;
    }
  | {
      readonly snapshotId: number;
      readonly status: "published";
      readonly publishedAt: string;
      readonly publishResult: unknown;
    }
  | {
      readonly snapshotId: number;
      readonly status: "blocked";
      readonly reason: string;
    };

interface MetricsSummary {
  readonly from: string;
  readonly to: string;
  readonly metrics: readonly NormalizedMetric[];
}

interface NormalizedMetric {
  readonly metricKey: string;
  readonly metricLabel: string;
  readonly value: number;
  readonly unit: string;
  readonly observedAt: string;
  readonly source: string;
  readonly note?: string;
}

interface NormalizedExerciseSession {
  readonly templateSessionKey: string | null;
  readonly scheduledFor: string | null;
  readonly completedAt: string | null;
  readonly status: string;
  readonly durationMinutes: number | null;
  readonly intensity: string | null;
  readonly note: string | null;
}

interface ExerciseSummary {
  readonly from: string;
  readonly to: string;
  readonly planned: number;
  readonly completed: number;
  readonly missed: number;
  readonly rate: number;
  readonly sessions: readonly NormalizedExerciseSession[];
  readonly adHocSessions: readonly NormalizedExerciseSession[];
}

interface SedentarySummarySnapshot {
  readonly from: string;
  readonly to: string;
  readonly idleMinutes: number;
  readonly activeMinutes: number;
  readonly unknownMinutes: number;
  readonly longestIdleStreakMinutes: number;
  readonly currentIdleStreakMinutes: number;
  readonly currentIdleStreak: NormalizedSedentaryStreak | null;
  readonly idleStreaks: readonly NormalizedSedentaryStreak[];
  readonly spans: readonly NormalizedSedentarySpan[];
}

interface NormalizedSedentaryStreak {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly durationMinutes: number;
  readonly idleMinutes: number;
}

interface NormalizedSedentarySpan {
  readonly sourceId: string | null;
  readonly spanStart: string;
  readonly spanEnd: string;
  readonly state: string;
  readonly confidence: number | null;
  readonly receivedAt: string;
}

interface CompassContextSummary {
  readonly available: boolean;
  readonly sourceUrl: string | null;
  readonly unavailableReason: string | null;
  readonly meals: JsonValue;
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export async function generateCoachDigestSnapshot(
  db: Database.Database,
  input: CoachDigestGenerateInput
): Promise<CoachDigestSnapshotResult> {
  const date = assertIsoDate(input.date, "date");
  const now = assertIsoInstant(input.now ?? new Date().toISOString(), "now");
  const nextDate = addUtcDays(date, 1);
  const fromInstant = `${date}T00:00:00.000Z`;
  const toInstant = `${nextDate}T00:00:00.000Z`;

  const metricsSummary = summarizeMetrics(
    queryHealthMetrics(db, {
      observedFrom: fromInstant,
      observedTo: previousInstant(toInstant)
    }),
    fromInstant,
    toInstant
  );
  const exerciseSummary = summarizeExercise(queryExerciseCompletion(db, { from: date, to: nextDate }), date, nextDate);
  const sedentarySummary = summarizeSedentary(computeSedentarySummary(db, { from: fromInstant, to: toInstant }));
  const compassContext = await readCompassContext(date, input);
  const sourceHash = hashSourceInputs({
    metricsSummary,
    exerciseSummary,
    sedentarySummary,
    compassContext
  });
  const renderedMarkdown = renderCoachDigestMarkdown({
    date,
    metricsSummary,
    exerciseSummary,
    sedentarySummary,
    compassContext
  });

  const transaction = db.transaction((): CoachDigestSnapshotResult => {
    const snapshot =
      findCoachDigestSnapshotByDateAndSourceHash(db, date, sourceHash) ??
      insertCoachDigestSnapshot(db, {
        date,
        metricsSummary,
        exerciseSummary,
        sedentarySummary,
        compassContext,
        renderedMarkdown,
        sourceHash
      });
    const trace = insertHealthTraceEvent(db, {
      runId: input.runId ?? `coach-digest-${date}`,
      stage: "coach",
      level: "info",
      message: "Coach digest snapshot generated",
      timestamp: now,
      data: {
        snapshotId: snapshot.id,
        date,
        sourceHash,
        compassAvailable: compassContext.available
      }
    });

    return {
      snapshot,
      renderedMarkdown,
      sourceHash,
      traceEvents: [trace]
    };
  });

  return transaction();
}

export async function publishCoachDigestSnapshot(
  db: Database.Database,
  input: CoachDigestPublishInput
): Promise<CoachDigestPublishResult> {
  const snapshot = getCoachDigestSnapshotById(db, input.snapshotId);
  if (snapshot === undefined) {
    throw new Error("coach digest snapshot not found");
  }

  const intendedAction: CoachDigestPublishAction = {
    type: "publish_coach_digest_snapshot",
    date: snapshot.date,
    sourceHash: snapshot.sourceHash,
    renderedMarkdown: snapshot.renderedMarkdown
  };

  if (input.dryRun) {
    return {
      snapshotId: snapshot.id,
      status: "dry_run",
      intendedAction
    };
  }

  if (snapshot.publishedAt !== undefined && snapshot.publishResultJson !== undefined) {
    return {
      snapshotId: snapshot.id,
      status: "published",
      publishedAt: snapshot.publishedAt,
      publishResult: JSON.parse(snapshot.publishResultJson) as unknown
    };
  }

  if (input.publish === undefined) {
    throw new Error("publish function is required for live coach digest publish");
  }

  const publishedAt = assertIsoInstant(input.now ?? new Date().toISOString(), "now");
  let publishResult: unknown;
  try {
    publishResult = (await input.publish(intendedAction)) ?? null;
  } catch (error) {
    return {
      snapshotId: snapshot.id,
      status: "blocked",
      reason: errorMessage(error)
    };
  }

  markCoachDigestSnapshotPublished(db, snapshot.id, {
    publishedAt,
    publishResult
  });

  return {
    snapshotId: snapshot.id,
    status: "published",
    publishedAt,
    publishResult
  };
}

function summarizeMetrics(metrics: readonly StoredHealthMetric[], from: string, to: string): MetricsSummary {
  return {
    from,
    to,
    metrics: metrics
      .map((metric) => ({
        metricKey: metric.metricKey,
        metricLabel: metric.metricLabel,
        value: metric.value,
        unit: metric.unit,
        observedAt: metric.observedAt,
        source: metric.source,
        ...(metric.note === undefined ? {} : { note: metric.note })
      }))
      .sort(compareMetrics)
  };
}

function summarizeExercise(summary: ExerciseCompletionSummary, from: string, to: string): ExerciseSummary {
  return {
    from,
    to,
    planned: summary.planned,
    completed: summary.completed,
    missed: summary.missed,
    rate: summary.rate,
    sessions: summary.sessions.map(normalizeExerciseSession).sort(compareExerciseSessions),
    adHocSessions: summary.adHocSessions.map(normalizeExerciseSession).sort(compareExerciseSessions)
  };
}

function normalizeExerciseSession(session: ExerciseCompletionSummary["sessions"][number]): NormalizedExerciseSession {
  return {
    templateSessionKey: session.templateSessionKey ?? null,
    scheduledFor: session.scheduledFor ?? null,
    completedAt: session.completedAt ?? null,
    status: session.status,
    durationMinutes: session.durationMinutes ?? null,
    intensity: session.intensity ?? null,
    note: session.note ?? null
  };
}

function summarizeSedentary(summary: SedentarySummary): SedentarySummarySnapshot {
  return {
    from: summary.from,
    to: summary.to,
    idleMinutes: summary.idleMinutes,
    activeMinutes: summary.activeMinutes,
    unknownMinutes: summary.unknownMinutes,
    longestIdleStreakMinutes: summary.longestIdleStreakMinutes,
    currentIdleStreakMinutes: summary.currentIdleStreakMinutes,
    currentIdleStreak: summary.currentIdleStreak === undefined ? null : normalizeSedentaryStreak(summary.currentIdleStreak),
    idleStreaks: summary.idleStreaks.map(normalizeSedentaryStreak).sort(compareSedentaryStreaks),
    spans: summary.spans
      .map((span) => ({
        sourceId: span.sourceId ?? null,
        spanStart: span.spanStart,
        spanEnd: span.spanEnd,
        state: span.state,
        confidence: span.confidence ?? null,
        receivedAt: span.receivedAt
      }))
      .sort(compareSedentarySpans)
  };
}

function normalizeSedentaryStreak(streak: SedentarySummary["idleStreaks"][number]): NormalizedSedentaryStreak {
  return {
    windowStart: streak.windowStart,
    windowEnd: streak.windowEnd,
    durationMinutes: streak.durationMinutes,
    idleMinutes: streak.idleMinutes
  };
}

async function readCompassContext(date: string, input: CoachDigestGenerateInput): Promise<CompassContextSummary> {
  if (input.offline === true || input.compass === undefined) {
    return {
      available: false,
      sourceUrl: null,
      unavailableReason: "offline",
      meals: null
    };
  }

  const context = await createCompassHealthClient(input.compass).readDailyContext(date);
  if (context.unavailableReason !== undefined) {
    return {
      available: false,
      sourceUrl: context.sourceUrl,
      unavailableReason: context.unavailableReason,
      meals: null
    };
  }

  return {
    available: true,
    sourceUrl: context.sourceUrl,
    unavailableReason: null,
    meals: toJsonValue(context.meals ?? null, "compass meals")
  };
}

function renderCoachDigestMarkdown(input: {
  readonly date: string;
  readonly metricsSummary: MetricsSummary;
  readonly exerciseSummary: ExerciseSummary;
  readonly sedentarySummary: SedentarySummarySnapshot;
  readonly compassContext: CompassContextSummary;
}): string {
  return [
    "# Coach daily health digest",
    "## Date",
    input.date,
    "",
    "## Metrics",
    ...renderMetrics(input.metricsSummary),
    "",
    "## Exercise",
    ...renderExercise(input.exerciseSummary),
    "",
    "## Sedentary",
    ...renderSedentary(input.sedentarySummary),
    "",
    "## Compass context",
    ...renderCompass(input.compassContext)
  ].join("\n");
}

function renderMetrics(summary: MetricsSummary): string[] {
  if (summary.metrics.length === 0) {
    return ["- No metrics recorded for this date."];
  }
  return summary.metrics.map((metric) => {
    const note = metric.note === undefined ? "" : `; note: ${metric.note}`;
    return `- ${metric.metricLabel}: ${formatNumber(metric.value)} ${metric.unit} at ${metric.observedAt} (${metric.source})${note}`;
  });
}

function compareMetrics(left: NormalizedMetric, right: NormalizedMetric): number {
  return compareStrings(
    `${left.observedAt}\0${left.metricKey}\0${left.metricLabel}\0${left.value}\0${left.unit}\0${left.source}\0${left.note ?? ""}`,
    `${right.observedAt}\0${right.metricKey}\0${right.metricLabel}\0${right.value}\0${right.unit}\0${right.source}\0${right.note ?? ""}`
  );
}

function compareExerciseSessions(left: NormalizedExerciseSession, right: NormalizedExerciseSession): number {
  return compareStrings(
    `${left.scheduledFor ?? ""}\0${left.completedAt ?? ""}\0${left.templateSessionKey ?? ""}\0${left.status}\0${left.durationMinutes ?? ""}\0${left.intensity ?? ""}\0${left.note ?? ""}`,
    `${right.scheduledFor ?? ""}\0${right.completedAt ?? ""}\0${right.templateSessionKey ?? ""}\0${right.status}\0${right.durationMinutes ?? ""}\0${right.intensity ?? ""}\0${right.note ?? ""}`
  );
}

function compareSedentaryStreaks(left: NormalizedSedentaryStreak, right: NormalizedSedentaryStreak): number {
  return compareStrings(
    `${left.windowStart}\0${left.windowEnd}\0${left.durationMinutes}\0${left.idleMinutes}`,
    `${right.windowStart}\0${right.windowEnd}\0${right.durationMinutes}\0${right.idleMinutes}`
  );
}

function compareSedentarySpans(left: NormalizedSedentarySpan, right: NormalizedSedentarySpan): number {
  return compareStrings(
    `${left.spanStart}\0${left.spanEnd}\0${left.sourceId ?? ""}\0${left.state}\0${left.confidence ?? ""}\0${left.receivedAt}`,
    `${right.spanStart}\0${right.spanEnd}\0${right.sourceId ?? ""}\0${right.state}\0${right.confidence ?? ""}\0${right.receivedAt}`
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderExercise(summary: ExerciseSummary): string[] {
  return [
    `- Planned sessions: ${summary.planned}`,
    `- Completed sessions: ${summary.completed}`,
    `- Missed sessions: ${summary.missed}`,
    `- Completion rate: ${formatPercent(summary.rate)}`,
    `- Ad hoc sessions: ${summary.adHocSessions.length}`,
    ...summary.sessions.map((session) => `- Session: ${renderExerciseSession(session)}`),
    ...summary.adHocSessions.map((session) => `- Ad hoc: ${renderExerciseSession(session)}`)
  ];
}

function renderExerciseSession(session: NormalizedExerciseSession): string {
  const parts = [
    session.status,
    session.templateSessionKey === null ? undefined : session.templateSessionKey,
    session.scheduledFor === null ? undefined : `scheduled ${session.scheduledFor}`,
    session.completedAt === null ? undefined : `completed ${session.completedAt}`,
    session.durationMinutes === null ? undefined : `${session.durationMinutes} min`,
    session.intensity,
    session.note
  ].filter((part): part is string => part !== undefined && part !== null);
  return parts.join(", ");
}

function renderSedentary(summary: SedentarySummarySnapshot): string[] {
  return [
    `- Idle minutes: ${summary.idleMinutes}`,
    `- Active minutes: ${summary.activeMinutes}`,
    `- Unknown minutes: ${summary.unknownMinutes}`,
    `- Longest idle streak minutes: ${summary.longestIdleStreakMinutes}`,
    `- Current idle streak minutes: ${summary.currentIdleStreakMinutes}`,
    `- Span count: ${summary.spans.length}`
  ];
}

function renderCompass(context: CompassContextSummary): string[] {
  return [
    `- Availability: ${context.available ? "available" : "unavailable"}`,
    `- Source: ${context.sourceUrl ?? "none"}`,
    `- Reason: ${context.unavailableReason ?? "none"}`,
    `- Meal entries: ${countMealEntries(context.meals)}`
  ];
}

function hashSourceInputs(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(toJsonValue(value, "source inputs"))).digest("hex")}`;
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

function toJsonValue(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, field));
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${field} contains an unsupported object type`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, toJsonValue(entryValue, field)]));
  }
  throw new Error(`${field} contains an unsupported JSON value`);
}

function countMealEntries(meals: JsonValue): number {
  if (Array.isArray(meals)) {
    return meals.length;
  }
  if (meals !== null && typeof meals === "object" && !Array.isArray(meals)) {
    const value = (meals as { readonly [key: string]: JsonValue }).meals;
    return Array.isArray(value) ? value.length : 0;
  }
  return 0;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function previousInstant(instant: string): string {
  return new Date(Date.parse(instant) - 1).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
