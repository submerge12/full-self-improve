import type Database from "better-sqlite3";

import {
  assertFiniteMetricValue,
  assertIsoDate,
  assertIsoInstant,
  assertSafeText,
  normalizeHealthMetricInput,
  normalizeMetricKey,
  type BreakReminderInput,
  type BreakReminderStatus,
  type CoachDigestSnapshotInput,
  type ExercisePlanInput,
  type ExercisePlanStatus,
  type ExerciseSessionInput,
  type ExerciseSessionStatus,
  type ExerciseTemplateInput,
  type HealthMetricInput,
  type HealthMetricQuery,
  type HealthMetricSource,
  type HealthTraceEventInput,
  type HealthTraceLevel,
  type HealthTraceStage,
  type MetricAuditChangedBy,
  type MetricAuditInput,
  type MetricImportInput,
  type SedentarySpanInput,
  type SedentaryState,
  type SedentaryStreakInput,
  type StoredBreakReminder,
  type StoredCoachDigestSnapshot,
  type StoredExercisePlan,
  type StoredExerciseSession,
  type StoredExerciseTemplate,
  type StoredHealthMetric,
  type StoredHealthTraceEvent,
  type StoredMetricAuditEvent,
  type StoredMetricImport,
  type StoredSedentarySpan,
  type StoredSedentaryStreak
} from "./schema.js";

export function insertHealthMetric(db: Database.Database, input: HealthMetricInput): StoredHealthMetric {
  const normalized = normalizeHealthMetricInput(input);
  const row = db
    .prepare(
      `INSERT INTO health_metrics (metric_key, metric_label, value, unit, observed_at, source, note)
       VALUES (@metricKey, @metricLabel, @value, @unit, @observedAt, @source, @note)
       RETURNING id, metric_key, metric_label, value, unit, observed_at, source, note, created_at, updated_at`
    )
    .get({
      ...normalized,
      note: normalized.note ?? null
    }) as HealthMetricRow;

  return mapHealthMetricRow(row);
}

export function getHealthMetricById(db: Database.Database, id: number): StoredHealthMetric | undefined {
  const row = db
    .prepare(
      `SELECT id, metric_key, metric_label, value, unit, observed_at, source, note, created_at, updated_at
       FROM health_metrics
       WHERE id = ?`
    )
    .get(assertPositiveInteger(id, "id")) as HealthMetricRow | undefined;

  return row === undefined ? undefined : mapHealthMetricRow(row);
}

export function listHealthMetrics(db: Database.Database, query: HealthMetricQuery): StoredHealthMetric[] {
  const where: string[] = [];
  const params: Record<string, number | string> = {};

  if (query.metricKey !== undefined) {
    where.push("metric_key = @metricKey");
    params.metricKey = normalizeMetricKey(query.metricKey);
  }
  if (query.observedFrom !== undefined) {
    where.push("observed_at >= @observedFrom");
    params.observedFrom = assertIsoInstant(query.observedFrom, "observedFrom");
  }
  if (query.observedTo !== undefined) {
    where.push("observed_at <= @observedTo");
    params.observedTo = assertIsoInstant(query.observedTo, "observedTo");
  }

  const limitClause = query.limit === undefined ? "" : " LIMIT @limit";
  if (query.limit !== undefined) {
    params.limit = assertPositiveInteger(query.limit, "limit");
  }

  const rows = db
    .prepare(
      `SELECT id, metric_key, metric_label, value, unit, observed_at, source, note, created_at, updated_at
       FROM health_metrics
       ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
       ORDER BY observed_at ASC, id ASC${limitClause}`
    )
    .all(params) as HealthMetricRow[];

  return rows.map(mapHealthMetricRow);
}

export function insertHealthTraceEvent(db: Database.Database, event: HealthTraceEventInput): StoredHealthTraceEvent {
  const row = db
    .prepare(
      `INSERT INTO health_trace_events (run_id, stage, level, message, timestamp, data)
       VALUES (@runId, @stage, @level, @message, @timestamp, @data)
       RETURNING id, run_id, stage, level, message, timestamp, data`
    )
    .get({
      runId: assertSafeText(event.runId, "runId"),
      stage: event.stage,
      level: event.level,
      message: assertSafeText(event.message, "message"),
      timestamp: assertIsoInstant(event.timestamp, "timestamp"),
      data: stringifyJson(event.data ?? null, "data")
    }) as HealthTraceEventRow;

  return mapHealthTraceEventRow(row);
}

export function insertMetricAuditEvent(db: Database.Database, input: MetricAuditInput): StoredMetricAuditEvent {
  const row = db
    .prepare(
      `INSERT INTO health_metric_audit_events
         (metric_id, changed_at, changed_by, previous_json, next_json, reason)
       VALUES (@metricId, @changedAt, @changedBy, @previousJson, @nextJson, @reason)
       RETURNING id, metric_id, changed_at, changed_by, previous_json, next_json, reason`
    )
    .get({
      metricId: assertPositiveInteger(input.metricId, "metricId"),
      changedAt: assertIsoInstant(input.changedAt, "changedAt"),
      changedBy: input.changedBy,
      previousJson: stringifyJson(input.previous, "previous"),
      nextJson: stringifyJson(input.next, "next"),
      reason: assertSafeText(input.reason, "reason")
    }) as MetricAuditEventRow;

  return mapMetricAuditEventRow(row);
}

export function insertMetricImportRecord(db: Database.Database, input: MetricImportInput): StoredMetricImport {
  const normalized = normalizeMetricImportInput(input);
  const row = db
    .prepare(
      `INSERT INTO health_metric_imports
         (source_filename, row_count, accepted_count, rejected_count, imported_at, content_hash)
       VALUES (@sourceFilename, @rowCount, @acceptedCount, @rejectedCount, @importedAt, @contentHash)
       ON CONFLICT(content_hash) DO NOTHING
       RETURNING id, source_filename, row_count, accepted_count, rejected_count, imported_at, content_hash`
    )
    .get(normalized) as MetricImportRow | undefined;

  if (row !== undefined) {
    return mapMetricImportRow(row);
  }

  const existing = findMetricImportByHash(db, normalized.contentHash);
  if (existing === undefined) {
    throw new Error("metric import insert did not return or find a row");
  }
  return existing;
}

export function findMetricImportByHash(db: Database.Database, contentHash: string): StoredMetricImport | undefined {
  const row = db
    .prepare(
      `SELECT id, source_filename, row_count, accepted_count, rejected_count, imported_at, content_hash
       FROM health_metric_imports
       WHERE content_hash = ?`
    )
    .get(assertSafeText(contentHash, "contentHash")) as MetricImportRow | undefined;

  return row === undefined ? undefined : mapMetricImportRow(row);
}

export function insertExerciseTemplate(db: Database.Database, input: ExerciseTemplateInput): StoredExerciseTemplate {
  const row = db
    .prepare(
      `INSERT INTO exercise_templates (slug, name, description, default_days, active)
       VALUES (@slug, @name, @description, @defaultDays, @active)
       RETURNING id, slug, name, description, default_days, active, created_at, updated_at`
    )
    .get({
      slug: assertSafeText(input.slug, "slug"),
      name: assertSafeText(input.name, "name"),
      description: optionalText(input.description, "description"),
      defaultDays: stringifyJsonStringArray(input.defaultDays, "defaultDays"),
      active: input.active === undefined || input.active ? 1 : 0
    }) as ExerciseTemplateRow;

  return mapExerciseTemplateRow(row);
}

export function insertExercisePlan(db: Database.Database, input: ExercisePlanInput): StoredExercisePlan {
  const row = db
    .prepare(
      `INSERT INTO exercise_plans (template_id, week_start, status, generated_from)
       VALUES (@templateId, @weekStart, @status, @generatedFrom)
       RETURNING id, template_id, week_start, status, generated_from, created_at, updated_at`
    )
    .get({
      templateId: assertPositiveInteger(input.templateId, "templateId"),
      weekStart: assertIsoDate(input.weekStart, "weekStart"),
      status: input.status ?? "active",
      generatedFrom: assertSafeText(input.generatedFrom, "generatedFrom")
    }) as ExercisePlanRow;

  return mapExercisePlanRow(row);
}

export function insertExerciseSession(db: Database.Database, input: ExerciseSessionInput): StoredExerciseSession {
  const row = db
    .prepare(
      `INSERT INTO exercise_sessions
         (plan_id, template_session_key, scheduled_for, completed_at, status, duration_minutes, intensity, note)
       VALUES (@planId, @templateSessionKey, @scheduledFor, @completedAt, @status, @durationMinutes, @intensity, @note)
       RETURNING id, plan_id, template_session_key, scheduled_for, completed_at, status, duration_minutes, intensity, note, created_at, updated_at`
    )
    .get({
      planId: input.planId === undefined ? null : assertPositiveInteger(input.planId, "planId"),
      templateSessionKey: optionalText(input.templateSessionKey, "templateSessionKey"),
      scheduledFor: input.scheduledFor === undefined ? null : assertIsoInstant(input.scheduledFor, "scheduledFor"),
      completedAt: input.completedAt === undefined ? null : assertIsoInstant(input.completedAt, "completedAt"),
      status: input.status,
      durationMinutes: input.durationMinutes === undefined ? null : assertPositiveInteger(input.durationMinutes, "durationMinutes"),
      intensity: input.intensity ?? null,
      note: optionalText(input.note, "note")
    }) as ExerciseSessionRow;

  return mapExerciseSessionRow(row);
}

export function insertSedentarySpan(db: Database.Database, input: SedentarySpanInput): StoredSedentarySpan {
  const row = db
    .prepare(
      `INSERT INTO sedentary_spans (source_id, span_start, span_end, state, confidence, received_at)
       VALUES (@sourceId, @spanStart, @spanEnd, @state, @confidence, @receivedAt)
       RETURNING id, source_id, span_start, span_end, state, confidence, received_at, created_at, updated_at`
    )
    .get({
      sourceId: optionalText(input.sourceId, "sourceId"),
      spanStart: assertIsoInstant(input.spanStart, "spanStart"),
      spanEnd: assertIsoInstant(input.spanEnd, "spanEnd"),
      state: input.state,
      confidence: input.confidence === undefined ? null : assertConfidence(input.confidence, "confidence"),
      receivedAt: assertIsoInstant(input.receivedAt, "receivedAt")
    }) as SedentarySpanRow;

  return mapSedentarySpanRow(row);
}

export function insertSedentaryStreak(db: Database.Database, input: SedentaryStreakInput): StoredSedentaryStreak {
  const row = db
    .prepare(
      `INSERT INTO sedentary_streaks (window_start, window_end, duration_minutes, source_span_ids, computed_at)
       VALUES (@windowStart, @windowEnd, @durationMinutes, @sourceSpanIds, @computedAt)
       RETURNING id, window_start, window_end, duration_minutes, source_span_ids, computed_at, created_at, updated_at`
    )
    .get({
      windowStart: assertIsoInstant(input.windowStart, "windowStart"),
      windowEnd: assertIsoInstant(input.windowEnd, "windowEnd"),
      durationMinutes: assertPositiveInteger(input.durationMinutes, "durationMinutes"),
      sourceSpanIds: stringifyJsonPositiveIntegerArray(input.sourceSpanIds, "sourceSpanIds"),
      computedAt: assertIsoInstant(input.computedAt, "computedAt")
    }) as SedentaryStreakRow;

  return mapSedentaryStreakRow(row);
}

export function insertBreakReminder(db: Database.Database, input: BreakReminderInput): StoredBreakReminder {
  const row = db
    .prepare(
      `INSERT INTO break_reminders (streak_id, eligible_at, status, reason, delivered_at, delivery_channel)
       VALUES (@streakId, @eligibleAt, @status, @reason, @deliveredAt, @deliveryChannel)
       RETURNING id, streak_id, eligible_at, status, reason, delivered_at, delivery_channel, created_at, updated_at`
    )
    .get({
      streakId: assertPositiveInteger(input.streakId, "streakId"),
      eligibleAt: assertIsoInstant(input.eligibleAt, "eligibleAt"),
      status: input.status,
      reason: assertSafeText(input.reason, "reason"),
      deliveredAt: input.deliveredAt === undefined ? null : assertIsoInstant(input.deliveredAt, "deliveredAt"),
      deliveryChannel: optionalText(input.deliveryChannel, "deliveryChannel")
    }) as BreakReminderRow;

  return mapBreakReminderRow(row);
}

export function insertCoachDigestSnapshot(
  db: Database.Database,
  input: CoachDigestSnapshotInput
): StoredCoachDigestSnapshot {
  const row = db
    .prepare(
      `INSERT INTO coach_digest_snapshots
         (
           date,
           metrics_summary_json,
           exercise_summary_json,
           sedentary_summary_json,
           compass_context_json,
           rendered_markdown,
           source_hash,
           published_at,
           publish_result_json
         )
       VALUES
         (
           @date,
           @metricsSummaryJson,
           @exerciseSummaryJson,
           @sedentarySummaryJson,
           @compassContextJson,
           @renderedMarkdown,
           @sourceHash,
           @publishedAt,
           @publishResultJson
         )
       RETURNING
         id,
         date,
         metrics_summary_json,
         exercise_summary_json,
         sedentary_summary_json,
         compass_context_json,
         rendered_markdown,
         source_hash,
         published_at,
         publish_result_json,
         created_at,
         updated_at`
    )
    .get({
      date: assertIsoDate(input.date, "date"),
      metricsSummaryJson: stringifyJson(input.metricsSummary, "metricsSummary"),
      exerciseSummaryJson: stringifyJson(input.exerciseSummary, "exerciseSummary"),
      sedentarySummaryJson: stringifyJson(input.sedentarySummary, "sedentarySummary"),
      compassContextJson: stringifyJson(input.compassContext, "compassContext"),
      renderedMarkdown: assertSafeText(input.renderedMarkdown, "renderedMarkdown"),
      sourceHash: assertSafeText(input.sourceHash, "sourceHash"),
      publishedAt: input.publishedAt === undefined ? null : assertIsoInstant(input.publishedAt, "publishedAt"),
      publishResultJson: input.publishResult === undefined ? null : stringifyJson(input.publishResult, "publishResult")
    }) as CoachDigestSnapshotRow;

  return mapCoachDigestSnapshotRow(row);
}

interface HealthMetricRow {
  readonly id: number;
  readonly metric_key: string;
  readonly metric_label: string;
  readonly value: number;
  readonly unit: string;
  readonly observed_at: string;
  readonly source: HealthMetricSource;
  readonly note: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MetricAuditEventRow {
  readonly id: number;
  readonly metric_id: number;
  readonly changed_at: string;
  readonly changed_by: MetricAuditChangedBy;
  readonly previous_json: string;
  readonly next_json: string;
  readonly reason: string;
}

interface MetricImportRow {
  readonly id: number;
  readonly source_filename: string;
  readonly row_count: number;
  readonly accepted_count: number;
  readonly rejected_count: number;
  readonly imported_at: string;
  readonly content_hash: string;
}

interface ExerciseTemplateRow {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly default_days: string;
  readonly active: 0 | 1;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ExercisePlanRow {
  readonly id: number;
  readonly template_id: number;
  readonly week_start: string;
  readonly status: ExercisePlanStatus;
  readonly generated_from: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ExerciseSessionRow {
  readonly id: number;
  readonly plan_id: number | null;
  readonly template_session_key: string | null;
  readonly scheduled_for: string | null;
  readonly completed_at: string | null;
  readonly status: ExerciseSessionStatus;
  readonly duration_minutes: number | null;
  readonly intensity: "low" | "moderate" | "high" | null;
  readonly note: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SedentarySpanRow {
  readonly id: number;
  readonly source_id: string | null;
  readonly span_start: string;
  readonly span_end: string;
  readonly state: SedentaryState;
  readonly confidence: number | null;
  readonly received_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SedentaryStreakRow {
  readonly id: number;
  readonly window_start: string;
  readonly window_end: string;
  readonly duration_minutes: number;
  readonly source_span_ids: string;
  readonly computed_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BreakReminderRow {
  readonly id: number;
  readonly streak_id: number;
  readonly eligible_at: string;
  readonly status: BreakReminderStatus;
  readonly reason: string;
  readonly delivered_at: string | null;
  readonly delivery_channel: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CoachDigestSnapshotRow {
  readonly id: number;
  readonly date: string;
  readonly metrics_summary_json: string;
  readonly exercise_summary_json: string;
  readonly sedentary_summary_json: string;
  readonly compass_context_json: string;
  readonly rendered_markdown: string;
  readonly source_hash: string;
  readonly published_at: string | null;
  readonly publish_result_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface HealthTraceEventRow {
  readonly id: number;
  readonly run_id: string;
  readonly stage: HealthTraceStage;
  readonly level: HealthTraceLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly data: string;
}

function mapHealthMetricRow(row: HealthMetricRow): StoredHealthMetric {
  return withoutUndefined({
    id: row.id,
    metricKey: row.metric_key,
    metricLabel: row.metric_label,
    value: row.value,
    unit: row.unit,
    observedAt: row.observed_at,
    source: row.source,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapMetricAuditEventRow(row: MetricAuditEventRow): StoredMetricAuditEvent {
  return {
    id: row.id,
    metricId: row.metric_id,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
    previousJson: row.previous_json,
    nextJson: row.next_json,
    reason: row.reason
  };
}

function mapMetricImportRow(row: MetricImportRow): StoredMetricImport {
  return {
    id: row.id,
    sourceFilename: row.source_filename,
    rowCount: row.row_count,
    acceptedCount: row.accepted_count,
    rejectedCount: row.rejected_count,
    importedAt: row.imported_at,
    contentHash: row.content_hash
  };
}

function mapExerciseTemplateRow(row: ExerciseTemplateRow): StoredExerciseTemplate {
  return withoutUndefined({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? undefined,
    defaultDays: parseJsonArray(row.default_days, "defaultDays"),
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapExercisePlanRow(row: ExercisePlanRow): StoredExercisePlan {
  return {
    id: row.id,
    templateId: row.template_id,
    weekStart: row.week_start,
    status: row.status,
    generatedFrom: row.generated_from,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapExerciseSessionRow(row: ExerciseSessionRow): StoredExerciseSession {
  return withoutUndefined({
    id: row.id,
    planId: row.plan_id ?? undefined,
    templateSessionKey: row.template_session_key ?? undefined,
    scheduledFor: row.scheduled_for ?? undefined,
    completedAt: row.completed_at ?? undefined,
    status: row.status,
    durationMinutes: row.duration_minutes ?? undefined,
    intensity: row.intensity ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapSedentarySpanRow(row: SedentarySpanRow): StoredSedentarySpan {
  return withoutUndefined({
    id: row.id,
    sourceId: row.source_id ?? undefined,
    spanStart: row.span_start,
    spanEnd: row.span_end,
    state: row.state,
    confidence: row.confidence ?? undefined,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapSedentaryStreakRow(row: SedentaryStreakRow): StoredSedentaryStreak {
  return {
    id: row.id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    durationMinutes: row.duration_minutes,
    sourceSpanIds: parseJsonNumberArray(row.source_span_ids, "sourceSpanIds"),
    computedAt: row.computed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapBreakReminderRow(row: BreakReminderRow): StoredBreakReminder {
  return withoutUndefined({
    id: row.id,
    streakId: row.streak_id,
    eligibleAt: row.eligible_at,
    status: row.status,
    reason: row.reason,
    deliveredAt: row.delivered_at ?? undefined,
    deliveryChannel: row.delivery_channel ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapCoachDigestSnapshotRow(row: CoachDigestSnapshotRow): StoredCoachDigestSnapshot {
  return withoutUndefined({
    id: row.id,
    date: row.date,
    metricsSummaryJson: row.metrics_summary_json,
    exerciseSummaryJson: row.exercise_summary_json,
    sedentarySummaryJson: row.sedentary_summary_json,
    compassContextJson: row.compass_context_json,
    renderedMarkdown: row.rendered_markdown,
    sourceHash: row.source_hash,
    publishedAt: row.published_at ?? undefined,
    publishResultJson: row.publish_result_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapHealthTraceEventRow(row: HealthTraceEventRow): StoredHealthTraceEvent {
  return {
    id: row.id,
    runId: row.run_id,
    stage: row.stage,
    level: row.level,
    message: row.message,
    timestamp: row.timestamp,
    dataJson: row.data
  };
}

function normalizeMetricImportInput(input: MetricImportInput): MetricImportInput {
  const rowCount = assertNonNegativeInteger(input.rowCount, "rowCount");
  const acceptedCount = assertNonNegativeInteger(input.acceptedCount, "acceptedCount");
  const rejectedCount = assertNonNegativeInteger(input.rejectedCount, "rejectedCount");
  if (acceptedCount + rejectedCount !== rowCount) {
    throw new Error("acceptedCount and rejectedCount must total rowCount");
  }

  return {
    sourceFilename: assertSafeText(input.sourceFilename, "sourceFilename"),
    rowCount,
    acceptedCount,
    rejectedCount,
    importedAt: assertIsoInstant(input.importedAt, "importedAt"),
    contentHash: assertSafeText(input.contentHash, "contentHash")
  };
}

function optionalText(value: string | undefined, field: string): string | null {
  if (value === undefined) {
    return null;
  }
  return assertSafeText(value, field);
}

function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function assertConfidence(value: number, field: string): number {
  assertFiniteMetricValue(value, field);
  if (value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return value;
}

function stringifyJson(value: unknown, field: string): string {
  assertStrictJsonValue(value, field, new WeakSet<object>());
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error(`${field} must be JSON serializable`);
  }
  return json;
}

function stringifyJsonStringArray(value: readonly string[], field: string): string {
  const candidate: unknown = value;
  if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be a JSON string array`);
  }
  return stringifyJson(candidate, field);
}

function stringifyJsonPositiveIntegerArray(value: readonly number[], field: string): string {
  const candidate: unknown = value;
  if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === "number" && Number.isInteger(item) && item > 0)) {
    throw new Error(`${field} must be positive integer IDs`);
  }
  return stringifyJson(candidate, field);
}

function assertStrictJsonValue(value: unknown, field: string, ancestors: WeakSet<object>): void {
  if (value === null) {
    return;
  }

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") {
    return;
  }
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} contains a non-finite number`);
    }
    return;
  }
  if (valueType === "undefined") {
    throw new Error(`${field} contains undefined`);
  }
  if (valueType === "function") {
    throw new Error(`${field} contains a function`);
  }
  if (valueType === "symbol") {
    throw new Error(`${field} contains a symbol`);
  }
  if (valueType !== "object") {
    throw new Error(`${field} contains an unsupported JSON value`);
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new Error(`${field} contains a circular reference`);
  }
  ancestors.add(objectValue);

  if (Array.isArray(value)) {
    for (const item of value) {
      assertStrictJsonValue(item, field, ancestors);
    }
    ancestors.delete(objectValue);
    return;
  }

  const prototype = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(objectValue);
    throw new Error(`${field} contains an unsupported object type`);
  }

  if (Object.getOwnPropertySymbols(objectValue).length > 0) {
    ancestors.delete(objectValue);
    throw new Error(`${field} contains a symbol`);
  }

  for (const item of Object.values(objectValue as Record<string, unknown>)) {
    assertStrictJsonValue(item, field, ancestors);
  }
  ancestors.delete(objectValue);
}

function parseJsonArray(value: string, field: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be a JSON string array`);
  }
  return parsed;
}

function parseJsonNumberArray(value: string, field: string): readonly number[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => Number.isInteger(item))) {
    throw new Error(`${field} must be a JSON integer array`);
  }
  return parsed;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}
