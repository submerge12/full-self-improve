export type HealthMetricSource = "manual" | "csv" | "mock";
export type ExercisePlanStatus = "active" | "archived";
export type ExerciseSessionStatus = "planned" | "completed" | "missed" | "ad_hoc";
export type ExerciseIntensity = "low" | "moderate" | "high";
export type SedentaryState = "active" | "idle" | "unknown";
export type BreakReminderStatus = "eligible" | "suppressed" | "delivered" | "expired";
export type HealthTraceStage = "metric" | "exercise" | "sedentary" | "coach" | "live-evidence";
export type HealthTraceLevel = "info" | "warn" | "error";
export type MetricAuditChangedBy = "cli" | "api";

export interface HealthMetricInput {
  readonly metricKey: string;
  readonly metricLabel: string;
  readonly value: number;
  readonly unit: string;
  readonly observedAt: string;
  readonly source: HealthMetricSource;
  readonly note?: string;
}

export interface StoredHealthMetric extends HealthMetricInput {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HealthMetricQuery {
  readonly metricKey?: string;
  readonly observedFrom?: string;
  readonly observedTo?: string;
  readonly limit?: number;
}

export interface MetricAuditInput {
  readonly metricId: number;
  readonly changedAt: string;
  readonly changedBy: MetricAuditChangedBy;
  readonly previous: unknown;
  readonly next: unknown;
  readonly reason: string;
}

export interface StoredMetricAuditEvent {
  readonly id: number;
  readonly metricId: number;
  readonly changedAt: string;
  readonly changedBy: MetricAuditChangedBy;
  readonly previousJson: string;
  readonly nextJson: string;
  readonly reason: string;
}

export interface MetricImportInput {
  readonly sourceFilename: string;
  readonly rowCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly importedAt: string;
  readonly contentHash: string;
}

export interface StoredMetricImport extends MetricImportInput {
  readonly id: number;
}

export interface ExerciseTemplateDay {
  readonly sessionKey: string;
  readonly dayOffset: number;
  readonly title: string;
  readonly targetMinutes?: number;
  readonly targetReps?: number;
}

export interface ExerciseTemplateInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly defaultDays: readonly ExerciseTemplateDay[];
  readonly active?: boolean;
}

export interface StoredExerciseTemplate {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly defaultDays: readonly ExerciseTemplateDay[];
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExercisePlanInput {
  readonly templateId: number;
  readonly weekStart: string;
  readonly status?: ExercisePlanStatus;
  readonly generatedFrom: string;
}

export interface StoredExercisePlan {
  readonly id: number;
  readonly templateId: number;
  readonly weekStart: string;
  readonly status: ExercisePlanStatus;
  readonly generatedFrom: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExerciseSessionInput {
  readonly planId?: number;
  readonly templateSessionKey?: string;
  readonly scheduledFor?: string;
  readonly completedAt?: string;
  readonly status: ExerciseSessionStatus;
  readonly durationMinutes?: number;
  readonly intensity?: ExerciseIntensity;
  readonly note?: string;
}

export interface StoredExerciseSession extends ExerciseSessionInput {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SedentarySpanInput {
  readonly sourceId?: string;
  readonly spanStart: string;
  readonly spanEnd: string;
  readonly state: SedentaryState;
  readonly confidence?: number;
  readonly receivedAt: string;
}

export interface StoredSedentarySpan extends SedentarySpanInput {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SedentaryStreakInput {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly durationMinutes: number;
  readonly sourceSpanIds: readonly number[];
  readonly computedAt: string;
}

export interface StoredSedentaryStreak extends SedentaryStreakInput {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BreakReminderInput {
  readonly streakId: number;
  readonly eligibleAt: string;
  readonly status: BreakReminderStatus;
  readonly reason: string;
  readonly deliveredAt?: string;
  readonly deliveryChannel?: string;
}

export interface StoredBreakReminder extends BreakReminderInput {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CoachDigestSnapshotInput {
  readonly date: string;
  readonly metricsSummary: unknown;
  readonly exerciseSummary: unknown;
  readonly sedentarySummary: unknown;
  readonly compassContext: unknown;
  readonly renderedMarkdown: string;
  readonly sourceHash: string;
  readonly publishedAt?: string;
  readonly publishResult?: unknown;
}

export interface StoredCoachDigestSnapshot {
  readonly id: number;
  readonly date: string;
  readonly metricsSummaryJson: string;
  readonly exerciseSummaryJson: string;
  readonly sedentarySummaryJson: string;
  readonly compassContextJson: string;
  readonly renderedMarkdown: string;
  readonly sourceHash: string;
  readonly publishedAt?: string;
  readonly publishResultJson?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HealthTraceEventInput {
  readonly runId: string;
  readonly stage: HealthTraceStage;
  readonly level: HealthTraceLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly data?: unknown;
}

export interface StoredHealthTraceEvent {
  readonly id: number;
  readonly runId: string;
  readonly stage: HealthTraceStage;
  readonly level: HealthTraceLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly dataJson: string;
}

const HEALTH_METRIC_SOURCES: readonly HealthMetricSource[] = ["manual", "csv", "mock"];

export function normalizeMetricKey(value: string): string {
  const normalized = assertSafeText(value, "metricKey")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    throw new Error("metricKey must contain at least one alphanumeric character");
  }
  return normalized;
}

export function assertIsoInstant(value: string, field: string): string {
  const text = assertSafeText(value, field);
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${field} must be an ISO instant`);
  }
  return text;
}

export function assertIsoDate(value: string, field: string): string {
  const text = assertSafeText(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) {
    throw new Error(`${field} must be an ISO date`);
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
  if (normalized !== text) {
    throw new Error(`${field} must be an ISO date`);
  }
  return text;
}

export function assertFiniteMetricValue(value: number, field: string): number {
  if (!Number.isFinite(value) || Math.abs(value) >= 1.0e308) {
    throw new Error(`${field} must be finite`);
  }
  return value;
}

export function assertSafeText(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be text`);
  }

  const text = value.trim();
  if (text.length === 0) {
    throw new Error(`${field} is required`);
  }
  if (hasUnsupportedControlCharacter(text)) {
    throw new Error(`${field} contains unsupported control characters`);
  }
  return text;
}

export function normalizeHealthMetricInput(input: HealthMetricInput): HealthMetricInput {
  if (!HEALTH_METRIC_SOURCES.includes(input.source)) {
    throw new Error("source must be manual, csv, or mock");
  }

  const unit = assertSafeText(input.unit, "unit");
  if (unit.length > 32) {
    throw new Error("unit must be 32 characters or less");
  }

  const note = input.note === undefined || input.note.trim().length === 0 ? undefined : assertSafeText(input.note, "note");
  return {
    metricKey: normalizeMetricKey(input.metricKey),
    metricLabel: assertSafeText(input.metricLabel, "metricLabel"),
    value: assertFiniteMetricValue(input.value, "value"),
    unit,
    observedAt: assertIsoInstant(input.observedAt, "observedAt"),
    source: input.source,
    ...(note === undefined || note.length === 0 ? {} : { note })
  };
}

function hasUnsupportedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      return true;
    }
  }
  return false;
}
