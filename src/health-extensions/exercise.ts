import type Database from "better-sqlite3";

import {
  assertIsoDate,
  assertIsoInstant,
  assertSafeText,
  type ExerciseIntensity,
  type ExerciseTemplateDay,
  type StoredExercisePlan,
  type StoredExerciseSession,
  type StoredExerciseTemplate
} from "./schema.js";
import {
  findExerciseSessionByPlanAndTemplateKey,
  findActiveExercisePlanByWeekStart,
  findExerciseTemplateBySlug,
  getExerciseSessionById,
  insertExercisePlan,
  insertExerciseSession,
  listExerciseSessionsForCompletion,
  updateExerciseSessionCompletion,
  upsertExerciseTemplate
} from "./store.js";

export interface ExerciseTemplateDayInput {
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
  readonly defaultDays: readonly ExerciseTemplateDayInput[];
  readonly active?: boolean;
}

export interface ExerciseTemplateResult {
  readonly template: StoredExerciseTemplate;
  readonly created: boolean;
}

export interface ExercisePlanCreateInput {
  readonly templateSlug: string;
  readonly weekStart: string;
}

export interface ExercisePlanResult {
  readonly plan: StoredExercisePlan;
  readonly template: StoredExerciseTemplate;
  readonly sessions: readonly StoredExerciseSession[];
}

export interface ExerciseSessionCompletionInput {
  readonly sessionId?: number;
  readonly planId?: number;
  readonly templateSessionKey?: string;
  readonly completedAt: string;
  readonly durationMinutes?: number;
  readonly intensity?: ExerciseIntensity;
  readonly note?: string;
}

export interface ExerciseSessionCompletionResult {
  readonly session: StoredExerciseSession;
}

export interface ExerciseCompletionQuery {
  readonly from: string;
  readonly to: string;
}

export interface ExerciseCompletionSummary {
  readonly planned: number;
  readonly completed: number;
  readonly missed: number;
  readonly rate: number;
  readonly sessions: readonly StoredExerciseSession[];
  readonly adHocSessions: readonly StoredExerciseSession[];
}

const EXERCISE_INTENSITIES: readonly ExerciseIntensity[] = ["low", "moderate", "high"];

export function createExerciseTemplate(
  db: Database.Database,
  input: ExerciseTemplateInput
): ExerciseTemplateResult {
  const normalized = normalizeTemplateInput(input);
  const transaction = db.transaction((): ExerciseTemplateResult => upsertExerciseTemplate(db, normalized));
  return transaction();
}

export function createExercisePlanFromTemplate(
  db: Database.Database,
  input: ExercisePlanCreateInput
): ExercisePlanResult {
  const templateSlug = assertSafeText(input.templateSlug, "templateSlug");
  const weekStart = assertMondayWeekStart(input.weekStart);
  const transaction = db.transaction((): ExercisePlanResult => {
    const template = findExerciseTemplateBySlug(db, templateSlug);
    if (template === undefined) {
      throw new Error("exercise template not found");
    }
    if (findActiveExercisePlanByWeekStart(db, weekStart) !== undefined) {
      throw new Error("active exercise plan already exists for weekStart");
    }

    const defaultDays = normalizeTemplateDays(template.defaultDays);
    const plan = insertExercisePlan(db, {
      templateId: template.id,
      weekStart,
      status: "active",
      generatedFrom: `exercise-template:${template.slug}`
    });
    const sessions = defaultDays.map((day) =>
      insertExerciseSession(db, {
        planId: plan.id,
        templateSessionKey: day.sessionKey,
        scheduledFor: scheduledInstantFor(weekStart, day.dayOffset),
        status: "planned",
        ...(day.targetMinutes === undefined ? {} : { durationMinutes: day.targetMinutes })
      })
    );

    return { plan, template, sessions };
  });

  return transaction();
}

export function completeExerciseSession(
  db: Database.Database,
  input: ExerciseSessionCompletionInput
): ExerciseSessionCompletionResult {
  const normalized = normalizeCompletionInput(input);
  const transaction = db.transaction((): ExerciseSessionCompletionResult => {
    const existing = findCompletionTarget(db, normalized);
    if (existing === undefined) {
      return { session: insertAdHocExerciseSessionCompletion(db, normalized) };
    }

    return { session: completePlannedExerciseSessionTarget(db, existing, normalized) };
  });

  return transaction();
}

function insertAdHocExerciseSessionCompletion(
  db: Database.Database,
  input: ExerciseSessionCompletionInput
): StoredExerciseSession {
  return insertExerciseSession(db, {
    completedAt: input.completedAt,
    status: "ad_hoc",
    ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }),
    ...(input.intensity === undefined ? {} : { intensity: input.intensity }),
    ...(input.note === undefined ? {} : { note: input.note })
  });
}

function completePlannedExerciseSessionTarget(
  db: Database.Database,
  existing: StoredExerciseSession,
  input: ExerciseSessionCompletionInput
): StoredExerciseSession {
  if (existing.planId === undefined) {
    throw new Error("sessionId must reference a planned exercise session");
  }
  if (existing.scheduledFor !== undefined && input.completedAt < existing.scheduledFor) {
    throw new Error("completedAt cannot be before scheduledFor");
  }

  const durationMinutes = input.durationMinutes ?? existing.durationMinutes;
  const intensity = input.intensity ?? existing.intensity;
  const note = input.note ?? existing.note;
  return updateExerciseSessionCompletion(db, existing.id, {
    completedAt: input.completedAt,
    status: "completed",
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    ...(intensity === undefined ? {} : { intensity }),
    ...(note === undefined ? {} : { note })
  });
}

function findCompletionTarget(
  db: Database.Database,
  input: ExerciseSessionCompletionInput
): StoredExerciseSession | undefined {
  if (input.sessionId !== undefined) {
    const session = getExerciseSessionById(db, input.sessionId);
    if (session === undefined) {
      throw new Error("exercise session not found");
    }
    return session;
  }

  if (input.planId !== undefined && input.templateSessionKey !== undefined) {
    const session = findExerciseSessionByPlanAndTemplateKey(db, input.planId, input.templateSessionKey);
    if (session === undefined) {
      throw new Error("planned exercise session not found");
    }
    return session;
  }

  return undefined;
}

export function queryExerciseCompletion(
  db: Database.Database,
  query: ExerciseCompletionQuery
): ExerciseCompletionSummary {
  const from = assertIsoDate(query.from, "from");
  const to = assertIsoDate(query.to, "to");
  if (`${to}T00:00:00.000Z` <= `${from}T00:00:00.000Z`) {
    throw new Error("to must be after from");
  }

  const window = listExerciseSessionsForCompletion(db, { from, to });
  const endInstant = `${to}T00:00:00.000Z`;
  const sessions = window.plannedSessions.map((session) => effectivePlannedSession(session, endInstant));
  const planned = sessions.length;
  const completed = sessions.filter((session) => session.status === "completed").length;
  const missed = sessions.filter((session) => session.status === "missed").length;

  return {
    planned,
    completed,
    missed,
    rate: planned === 0 ? 0 : completed / planned,
    sessions,
    adHocSessions: window.adHocSessions
  };
}

function normalizeTemplateInput(input: ExerciseTemplateInput): ExerciseTemplateInput {
  return {
    slug: assertSafeText(input.slug, "slug"),
    name: assertSafeText(input.name, "name"),
    ...(input.description === undefined ? {} : { description: assertSafeText(input.description, "description") }),
    defaultDays: normalizeTemplateDays(input.defaultDays),
    ...(input.active === undefined ? {} : { active: Boolean(input.active) })
  };
}

function normalizeTemplateDays(days: readonly ExerciseTemplateDayInput[]): readonly ExerciseTemplateDay[] {
  if (!Array.isArray(days) || days.length === 0) {
    throw new Error("defaultDays must include at least one day");
  }

  const seenSessionKeys = new Set<string>();
  return days.map((day) => {
    const sessionKey = assertSafeText(day.sessionKey, "defaultDays sessionKey");
    if (seenSessionKeys.has(sessionKey)) {
      throw new Error("defaultDays sessionKey values must be unique");
    }
    seenSessionKeys.add(sessionKey);

    const targetMinutes = optionalPositiveInteger(day.targetMinutes, "targetMinutes");
    const targetReps = optionalPositiveInteger(day.targetReps, "targetReps");
    if (targetMinutes === undefined && targetReps === undefined) {
      throw new Error("defaultDays targetMinutes or targetReps is required");
    }

    return {
      sessionKey,
      dayOffset: assertNonNegativeInteger(day.dayOffset, "dayOffset"),
      title: assertSafeText(day.title, "title"),
      ...(targetMinutes === undefined ? {} : { targetMinutes }),
      ...(targetReps === undefined ? {} : { targetReps })
    };
  });
}

function normalizeCompletionInput(input: ExerciseSessionCompletionInput): ExerciseSessionCompletionInput {
  const sessionId = input.sessionId === undefined ? undefined : assertPositiveInteger(input.sessionId, "sessionId");
  const planId = input.planId === undefined ? undefined : assertPositiveInteger(input.planId, "planId");
  const templateSessionKey =
    input.templateSessionKey === undefined ? undefined : assertSafeText(input.templateSessionKey, "templateSessionKey");
  assertCompletionTargetMode(sessionId, planId, templateSessionKey);
  const durationMinutes = optionalPositiveInteger(input.durationMinutes, "durationMinutes");
  const intensity = input.intensity === undefined ? undefined : assertIntensity(input.intensity);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(planId === undefined ? {} : { planId }),
    ...(templateSessionKey === undefined ? {} : { templateSessionKey }),
    completedAt: assertIsoInstant(input.completedAt, "completedAt"),
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    ...(intensity === undefined ? {} : { intensity }),
    ...(input.note === undefined ? {} : { note: assertSafeText(input.note, "note") })
  };
}

function assertCompletionTargetMode(
  sessionId: number | undefined,
  planId: number | undefined,
  templateSessionKey: string | undefined
): void {
  const hasSessionId = sessionId !== undefined;
  const hasPlanTarget = planId !== undefined || templateSessionKey !== undefined;
  const hasCompletePlanTarget = planId !== undefined && templateSessionKey !== undefined;
  if ((hasSessionId && hasPlanTarget) || (!hasSessionId && hasPlanTarget && !hasCompletePlanTarget)) {
    throw new Error("completion target must be sessionId, planId with templateSessionKey, or omitted");
  }
}

function effectivePlannedSession(session: StoredExerciseSession, endInstant: string): StoredExerciseSession {
  if (session.status === "completed") {
    return session;
  }
  if (session.scheduledFor !== undefined && session.scheduledFor < endInstant) {
    return { ...session, status: "missed" };
  }
  return session;
}

function assertMondayWeekStart(value: string): string {
  const weekStart = assertIsoDate(value, "weekStart");
  if (new Date(`${weekStart}T00:00:00.000Z`).getUTCDay() !== 1) {
    throw new Error("weekStart must be a Monday");
  }
  return weekStart;
}

function scheduledInstantFor(weekStart: string, dayOffset: number): string {
  const date = new Date(`${weekStart}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString();
}

function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertPositiveInteger(value, field);
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

function assertIntensity(value: ExerciseIntensity): ExerciseIntensity {
  if (!EXERCISE_INTENSITIES.includes(value)) {
    throw new Error("intensity must be low, moderate, or high");
  }
  return value;
}
