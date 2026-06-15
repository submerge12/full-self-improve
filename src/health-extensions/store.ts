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
  type ExerciseTemplateDay,
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

export interface HealthMetricWriteOptions {
  readonly now?: string;
}

export interface MetricImportReservation {
  readonly importRecord: StoredMetricImport;
  readonly created: boolean;
}

export interface ExerciseTemplateUpsertResult {
  readonly template: StoredExerciseTemplate;
  readonly created: boolean;
}

export interface ExerciseSessionCompletionWindowQuery {
  readonly from: string;
  readonly to: string;
}

export interface ExerciseSessionCompletionWindow {
  readonly plannedSessions: readonly StoredExerciseSession[];
  readonly adHocSessions: readonly StoredExerciseSession[];
}

export interface SedentarySpanReservation {
  readonly span: StoredSedentarySpan;
  readonly created: boolean;
}

export interface SedentarySpanWindowQuery {
  readonly from: string;
  readonly to: string;
}

export interface SedentaryStreakProjectionQuery {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly durationMinutes: number;
  readonly sourceSpanIds: readonly number[];
}

export interface BreakReminderCooldownQuery {
  readonly eligibleAt: string;
  readonly cooldownMinutes: number;
}

export interface BreakReminderStreakStartQuery {
  readonly windowStart: string;
  readonly eligibleAt: string;
}

export interface BreakReminderWithStreak {
  readonly streak: StoredSedentaryStreak;
  readonly reminder: StoredBreakReminder;
}

export function insertHealthMetric(
  db: Database.Database,
  input: HealthMetricInput,
  options: HealthMetricWriteOptions = {}
): StoredHealthMetric {
  const normalized = normalizeHealthMetricInput(input);
  const now = options.now === undefined ? null : assertIsoInstant(options.now, "now");
  const row = db
    .prepare(
      `INSERT INTO health_metrics (metric_key, metric_label, value, unit, observed_at, source, note, created_at, updated_at)
       VALUES (@metricKey, @metricLabel, @value, @unit, @observedAt, @source, @note, COALESCE(@now, CURRENT_TIMESTAMP), COALESCE(@now, CURRENT_TIMESTAMP))
       RETURNING id, metric_key, metric_label, value, unit, observed_at, source, note, created_at, updated_at`
    )
    .get({
      ...normalized,
      note: normalized.note ?? null,
      now
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

export function updateHealthMetricRow(
  db: Database.Database,
  id: number,
  input: HealthMetricInput,
  options: HealthMetricWriteOptions = {}
): StoredHealthMetric {
  const normalized = normalizeHealthMetricInput(input);
  const now = options.now === undefined ? null : assertIsoInstant(options.now, "now");
  const row = db
    .prepare(
      `UPDATE health_metrics
       SET metric_key = @metricKey,
           metric_label = @metricLabel,
           value = @value,
           unit = @unit,
           observed_at = @observedAt,
           source = @source,
           note = @note,
           updated_at = COALESCE(@now, CURRENT_TIMESTAMP)
       WHERE id = @id
       RETURNING id, metric_key, metric_label, value, unit, observed_at, source, note, created_at, updated_at`
    )
    .get({
      id: assertPositiveInteger(id, "id"),
      ...normalized,
      note: normalized.note ?? null,
      now
    }) as HealthMetricRow | undefined;

  if (row === undefined) {
    throw new Error("health metric not found");
  }
  return mapHealthMetricRow(row);
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
  return reserveMetricImportRecord(db, input).importRecord;
}

export function reserveMetricImportRecord(db: Database.Database, input: MetricImportInput): MetricImportReservation {
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
    return { importRecord: mapMetricImportRow(row), created: true };
  }

  const existing = findMetricImportByHash(db, normalized.contentHash);
  if (existing === undefined) {
    throw new Error("metric import insert did not return or find a row");
  }
  return { importRecord: existing, created: false };
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
      defaultDays: stringifyExerciseTemplateDays(input.defaultDays, "defaultDays"),
      active: input.active === undefined || input.active ? 1 : 0
    }) as ExerciseTemplateRow;

  return mapExerciseTemplateRow(row);
}

export function upsertExerciseTemplate(db: Database.Database, input: ExerciseTemplateInput): ExerciseTemplateUpsertResult {
  const existing = findExerciseTemplateBySlug(db, input.slug);
  if (existing === undefined) {
    return { template: insertExerciseTemplate(db, input), created: true };
  }

  const row = db
    .prepare(
      `UPDATE exercise_templates
       SET name = @name,
           description = @description,
           default_days = @defaultDays,
           active = @active,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = @id
       RETURNING id, slug, name, description, default_days, active, created_at, updated_at`
    )
    .get({
      id: existing.id,
      name: assertSafeText(input.name, "name"),
      description: optionalText(input.description, "description"),
      defaultDays: stringifyExerciseTemplateDays(input.defaultDays, "defaultDays"),
      active: input.active === undefined || input.active ? 1 : 0
    }) as ExerciseTemplateRow | undefined;

  if (row === undefined) {
    throw new Error("exercise template update did not return a row");
  }
  return { template: mapExerciseTemplateRow(row), created: false };
}

export function findExerciseTemplateBySlug(db: Database.Database, slug: string): StoredExerciseTemplate | undefined {
  const row = db
    .prepare(
      `SELECT id, slug, name, description, default_days, active, created_at, updated_at
       FROM exercise_templates
       WHERE slug = ?`
    )
    .get(assertSafeText(slug, "slug")) as ExerciseTemplateRow | undefined;

  return row === undefined ? undefined : mapExerciseTemplateRow(row);
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

export function findActiveExercisePlanByWeekStart(
  db: Database.Database,
  weekStart: string
): StoredExercisePlan | undefined {
  const row = db
    .prepare(
      `SELECT id, template_id, week_start, status, generated_from, created_at, updated_at
       FROM exercise_plans
       WHERE week_start = ? AND status = 'active'`
    )
    .get(assertIsoDate(weekStart, "weekStart")) as ExercisePlanRow | undefined;

  return row === undefined ? undefined : mapExercisePlanRow(row);
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

export function getExerciseSessionById(db: Database.Database, id: number): StoredExerciseSession | undefined {
  const row = db
    .prepare(
      `SELECT id, plan_id, template_session_key, scheduled_for, completed_at, status, duration_minutes, intensity, note, created_at, updated_at
       FROM exercise_sessions
       WHERE id = ?`
    )
    .get(assertPositiveInteger(id, "id")) as ExerciseSessionRow | undefined;

  return row === undefined ? undefined : mapExerciseSessionRow(row);
}

export function findExerciseSessionByPlanAndTemplateKey(
  db: Database.Database,
  planId: number,
  templateSessionKey: string
): StoredExerciseSession | undefined {
  const row = db
    .prepare(
      `SELECT id, plan_id, template_session_key, scheduled_for, completed_at, status, duration_minutes, intensity, note, created_at, updated_at
       FROM exercise_sessions
       WHERE plan_id = @planId
         AND template_session_key = @templateSessionKey`
    )
    .get({
      planId: assertPositiveInteger(planId, "planId"),
      templateSessionKey: assertSafeText(templateSessionKey, "templateSessionKey")
    }) as ExerciseSessionRow | undefined;

  return row === undefined ? undefined : mapExerciseSessionRow(row);
}

export function updateExerciseSessionCompletion(
  db: Database.Database,
  id: number,
  input: Omit<ExerciseSessionInput, "planId" | "scheduledFor" | "status" | "templateSessionKey"> & {
    readonly status: "completed";
  }
): StoredExerciseSession {
  const row = db
    .prepare(
      `UPDATE exercise_sessions
       SET completed_at = @completedAt,
           status = 'completed',
           duration_minutes = COALESCE(@durationMinutes, duration_minutes),
           intensity = COALESCE(@intensity, intensity),
           note = COALESCE(@note, note),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = @id
       RETURNING id, plan_id, template_session_key, scheduled_for, completed_at, status, duration_minutes, intensity, note, created_at, updated_at`
    )
    .get({
      id: assertPositiveInteger(id, "id"),
      completedAt: input.completedAt === undefined ? null : assertIsoInstant(input.completedAt, "completedAt"),
      durationMinutes: input.durationMinutes === undefined ? null : assertPositiveInteger(input.durationMinutes, "durationMinutes"),
      intensity: input.intensity ?? null,
      note: optionalText(input.note, "note")
    }) as ExerciseSessionRow | undefined;

  if (row === undefined) {
    throw new Error("exercise session not found");
  }
  return mapExerciseSessionRow(row);
}

export function listExerciseSessionsForCompletion(
  db: Database.Database,
  query: ExerciseSessionCompletionWindowQuery
): ExerciseSessionCompletionWindow {
  const start = startInstantForIsoDate(query.from, "from");
  const end = startInstantForIsoDate(query.to, "to");
  if (end <= start) {
    throw new Error("to must be after from");
  }

  const plannedRows = db
    .prepare(
      `SELECT id, plan_id, template_session_key, scheduled_for, completed_at, status, duration_minutes, intensity, note, created_at, updated_at
       FROM exercise_sessions
       WHERE plan_id IS NOT NULL
         AND scheduled_for >= @start
         AND scheduled_for < @end
       ORDER BY scheduled_for ASC, id ASC`
    )
    .all({ start, end }) as ExerciseSessionRow[];
  const adHocRows = db
    .prepare(
      `SELECT id, plan_id, template_session_key, scheduled_for, completed_at, status, duration_minutes, intensity, note, created_at, updated_at
       FROM exercise_sessions
       WHERE status = 'ad_hoc'
         AND completed_at >= @start
         AND completed_at < @end
       ORDER BY completed_at ASC, id ASC`
    )
    .all({ start, end }) as ExerciseSessionRow[];

  return {
    plannedSessions: plannedRows.map(mapExerciseSessionRow),
    adHocSessions: adHocRows.map(mapExerciseSessionRow)
  };
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

export function reserveSedentarySpanBySourceId(
  db: Database.Database,
  input: SedentarySpanInput & { readonly sourceId: string }
): SedentarySpanReservation {
  const row = db
    .prepare(
      `INSERT INTO sedentary_spans (source_id, span_start, span_end, state, confidence, received_at)
       VALUES (@sourceId, @spanStart, @spanEnd, @state, @confidence, @receivedAt)
       ON CONFLICT(source_id) DO NOTHING
       RETURNING id, source_id, span_start, span_end, state, confidence, received_at, created_at, updated_at`
    )
    .get({
      sourceId: assertSafeText(input.sourceId, "sourceId"),
      spanStart: assertIsoInstant(input.spanStart, "spanStart"),
      spanEnd: assertIsoInstant(input.spanEnd, "spanEnd"),
      state: input.state,
      confidence: input.confidence === undefined ? null : assertConfidence(input.confidence, "confidence"),
      receivedAt: assertIsoInstant(input.receivedAt, "receivedAt")
    }) as SedentarySpanRow | undefined;

  if (row !== undefined) {
    return { span: mapSedentarySpanRow(row), created: true };
  }

  const existing = findSedentarySpanBySourceId(db, input.sourceId);
  if (existing === undefined) {
    throw new Error("sedentary span insert did not return or find a row");
  }
  return { span: existing, created: false };
}

export function findSedentarySpanBySourceId(
  db: Database.Database,
  sourceId: string
): StoredSedentarySpan | undefined {
  const row = db
    .prepare(
      `SELECT id, source_id, span_start, span_end, state, confidence, received_at, created_at, updated_at
       FROM sedentary_spans
       WHERE source_id = ?`
    )
    .get(assertSafeText(sourceId, "sourceId")) as SedentarySpanRow | undefined;

  return row === undefined ? undefined : mapSedentarySpanRow(row);
}

export function listSedentarySpansForWindow(
  db: Database.Database,
  query: SedentarySpanWindowQuery
): StoredSedentarySpan[] {
  const from = assertIsoInstant(query.from, "from");
  const to = assertIsoInstant(query.to, "to");
  if (to <= from) {
    throw new Error("to must be after from");
  }

  const rows = db
    .prepare(
      `SELECT id, source_id, span_start, span_end, state, confidence, received_at, created_at, updated_at
       FROM sedentary_spans
       WHERE span_end > @from
         AND span_start < @to
       ORDER BY span_start ASC, span_end ASC, id ASC`
    )
    .all({ from, to }) as SedentarySpanRow[];

  return rows.map(mapSedentarySpanRow);
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

export function findSedentaryStreakByProjection(
  db: Database.Database,
  query: SedentaryStreakProjectionQuery
): StoredSedentaryStreak | undefined {
  const row = db
    .prepare(
      `SELECT id, window_start, window_end, duration_minutes, source_span_ids, computed_at, created_at, updated_at
       FROM sedentary_streaks
       WHERE window_start = @windowStart
         AND window_end = @windowEnd
         AND duration_minutes = @durationMinutes
         AND source_span_ids = @sourceSpanIds
       ORDER BY id ASC
       LIMIT 1`
    )
    .get({
      windowStart: assertIsoInstant(query.windowStart, "windowStart"),
      windowEnd: assertIsoInstant(query.windowEnd, "windowEnd"),
      durationMinutes: assertPositiveInteger(query.durationMinutes, "durationMinutes"),
      sourceSpanIds: stringifyJsonPositiveIntegerArray(query.sourceSpanIds, "sourceSpanIds")
    }) as SedentaryStreakRow | undefined;

  return row === undefined ? undefined : mapSedentaryStreakRow(row);
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

export function findBreakReminderByStreakAndEligibleAt(
  db: Database.Database,
  streakId: number,
  eligibleAt: string
): StoredBreakReminder | undefined {
  const row = db
    .prepare(
      `SELECT id, streak_id, eligible_at, status, reason, delivered_at, delivery_channel, created_at, updated_at
       FROM break_reminders
       WHERE streak_id = @streakId
         AND eligible_at = @eligibleAt`
    )
    .get({
      streakId: assertPositiveInteger(streakId, "streakId"),
      eligibleAt: assertIsoInstant(eligibleAt, "eligibleAt")
    }) as BreakReminderRow | undefined;

  return row === undefined ? undefined : mapBreakReminderRow(row);
}

export function findBreakReminderByStreakStartAndEligibleAt(
  db: Database.Database,
  query: BreakReminderStreakStartQuery
): BreakReminderWithStreak | undefined {
  const eligibleAt = assertIsoInstant(query.eligibleAt, "eligibleAt");
  const row = db
    .prepare(
      `SELECT
         sedentary_streaks.id,
         sedentary_streaks.window_start,
         sedentary_streaks.window_end,
         sedentary_streaks.duration_minutes,
         sedentary_streaks.source_span_ids,
         sedentary_streaks.computed_at,
         sedentary_streaks.created_at,
         sedentary_streaks.updated_at
       FROM sedentary_streaks
       INNER JOIN break_reminders ON break_reminders.streak_id = sedentary_streaks.id
       WHERE sedentary_streaks.window_start = @windowStart
         AND break_reminders.eligible_at = @eligibleAt
       ORDER BY break_reminders.id ASC
       LIMIT 1`
    )
    .get({
      windowStart: assertIsoInstant(query.windowStart, "windowStart"),
      eligibleAt
    }) as SedentaryStreakRow | undefined;

  if (row === undefined) {
    return undefined;
  }

  const streak = mapSedentaryStreakRow(row);
  const reminder = findBreakReminderByStreakAndEligibleAt(db, streak.id, eligibleAt);
  if (reminder === undefined) {
    throw new Error("break reminder lookup joined a missing reminder");
  }
  return { streak, reminder };
}

export function listEligibleBreakRemindersNear(
  db: Database.Database,
  query: BreakReminderCooldownQuery
): StoredBreakReminder[] {
  const eligibleAtMs = Date.parse(assertIsoInstant(query.eligibleAt, "eligibleAt"));
  const cooldownMinutes = assertNonNegativeInteger(query.cooldownMinutes, "cooldownMinutes");
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const from = new Date(eligibleAtMs - cooldownMs).toISOString();
  const to = new Date(eligibleAtMs).toISOString();
  const rows = db
    .prepare(
      `SELECT id, streak_id, eligible_at, status, reason, delivered_at, delivery_channel, created_at, updated_at
       FROM break_reminders
       WHERE status = 'eligible'
         AND eligible_at >= @from
         AND eligible_at <= @to
       ORDER BY eligible_at ASC, id ASC`
    )
    .all({ from, to }) as BreakReminderRow[];

  return rows.map(mapBreakReminderRow);
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

export function findCoachDigestSnapshotByDateAndSourceHash(
  db: Database.Database,
  date: string,
  sourceHash: string
): StoredCoachDigestSnapshot | undefined {
  const row = db
    .prepare(
      `SELECT
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
         updated_at
       FROM coach_digest_snapshots
       WHERE date = @date
         AND source_hash = @sourceHash
       ORDER BY id ASC
       LIMIT 1`
    )
    .get({
      date: assertIsoDate(date, "date"),
      sourceHash: assertSafeText(sourceHash, "sourceHash")
    }) as CoachDigestSnapshotRow | undefined;

  return row === undefined ? undefined : mapCoachDigestSnapshotRow(row);
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
    defaultDays: parseExerciseTemplateDays(row.default_days, "defaultDays"),
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

function startInstantForIsoDate(value: string, field: string): string {
  return `${assertIsoDate(value, field)}T00:00:00.000Z`;
}

function stringifyJson(value: unknown, field: string): string {
  assertStrictJsonValue(value, field, new WeakSet<object>());
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error(`${field} must be JSON serializable`);
  }
  return json;
}

function stringifyExerciseTemplateDays(value: readonly ExerciseTemplateDay[], field: string): string {
  return stringifyJson(normalizeExerciseTemplateDays(value, field), field);
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

function parseExerciseTemplateDays(value: string, field: string): readonly ExerciseTemplateDay[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(isExerciseTemplateDayCandidate)) {
    throw new Error(`${field} must be an array of exercise template day objects`);
  }
  return normalizeExerciseTemplateDays(parsed, field);
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

function isExerciseTemplateDayCandidate(value: unknown): value is ExerciseTemplateDay {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<Record<keyof ExerciseTemplateDay, unknown>>;
  return (
    typeof candidate.sessionKey === "string" &&
    typeof candidate.dayOffset === "number" &&
    typeof candidate.title === "string" &&
    (candidate.targetMinutes === undefined || typeof candidate.targetMinutes === "number") &&
    (candidate.targetReps === undefined || typeof candidate.targetReps === "number")
  );
}

function normalizeExerciseTemplateDays(value: readonly ExerciseTemplateDay[], field: string): readonly ExerciseTemplateDay[] {
  const candidate: unknown = value;
  if (!Array.isArray(candidate) || !candidate.every(isExerciseTemplateDayCandidate)) {
    throw new Error(`${field} must be an array of exercise template day objects`);
  }
  if (candidate.length === 0) {
    throw new Error(`${field} must include at least one day`);
  }

  const seenSessionKeys = new Set<string>();
  return candidate.map((day) => {
    const sessionKey = assertSafeText(day.sessionKey, `${field} sessionKey`);
    if (seenSessionKeys.has(sessionKey)) {
      throw new Error(`${field} sessionKey values must be unique`);
    }
    seenSessionKeys.add(sessionKey);

    const targetMinutes = optionalPositiveInteger(day.targetMinutes, `${field} targetMinutes`);
    const targetReps = optionalPositiveInteger(day.targetReps, `${field} targetReps`);
    if (targetMinutes === undefined && targetReps === undefined) {
      throw new Error(`${field} targetMinutes or targetReps is required`);
    }

    return {
      sessionKey,
      dayOffset: assertNonNegativeInteger(day.dayOffset, `${field} dayOffset`),
      title: assertSafeText(day.title, `${field} title`),
      ...(targetMinutes === undefined ? {} : { targetMinutes }),
      ...(targetReps === undefined ? {} : { targetReps })
    };
  });
}

function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertPositiveInteger(value, field);
}
