import type Database from "better-sqlite3";

import {
  assertFiniteMetricValue,
  assertIsoInstant,
  assertSafeText,
  type BreakReminderStatus,
  type SedentaryState,
  type StoredBreakReminder,
  type StoredSedentarySpan,
  type StoredSedentaryStreak
} from "./schema.js";
import {
  findBreakReminderByStreakAndEligibleAt,
  findBreakReminderByStreakStartAndEligibleAt,
  findSedentaryStreakByProjection,
  insertBreakReminder,
  insertSedentaryStreak,
  listEligibleBreakRemindersNear,
  listSedentarySpansForWindow,
  reserveSedentarySpanBySourceId
} from "./store.js";

export interface SedentarySpanIngestionInput {
  readonly sourceId: string;
  readonly spanStart: string;
  readonly spanEnd: string;
  readonly state: SedentaryState;
  readonly confidence?: number;
  readonly receivedAt?: string;
}

export interface SedentarySummaryOptions {
  readonly from: string;
  readonly to: string;
  readonly activeBreakMinutes?: number;
  readonly mergeUnknownGaps?: boolean;
}

export interface SedentaryIdleStreak {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly durationMinutes: number;
  readonly idleMinutes: number;
  readonly sourceSpanIds: readonly number[];
}

export interface SedentarySummary {
  readonly from: string;
  readonly to: string;
  readonly idleMinutes: number;
  readonly activeMinutes: number;
  readonly unknownMinutes: number;
  readonly longestIdleStreakMinutes: number;
  readonly currentIdleStreakMinutes: number;
  readonly currentIdleStreak?: SedentaryIdleStreak;
  readonly idleStreaks: readonly SedentaryIdleStreak[];
  readonly spans: readonly StoredSedentarySpan[];
}

export interface BreakReminderEvaluationInput extends SedentarySummaryOptions {
  readonly thresholdMinutes?: number;
  readonly cooldownMinutes?: number;
  readonly evaluatedAt?: string;
  readonly deliveryChannel?: string;
}

export type BreakReminderEvaluationStatus = BreakReminderStatus | "not_eligible";

export interface BreakReminderEvaluationResult {
  readonly status: BreakReminderEvaluationStatus;
  readonly summary: SedentarySummary;
  readonly streak?: StoredSedentaryStreak;
  readonly reminder?: StoredBreakReminder;
}

interface TimelineSegment {
  readonly start: string;
  readonly end: string;
  readonly state: SedentaryState;
  readonly spanId?: number;
}

interface StreakDraft {
  windowStart: string;
  windowEnd: string;
  idleMinutes: number;
  sourceSpanIds: number[];
}

const SEDENTARY_STATES: readonly SedentaryState[] = ["active", "idle", "unknown"];
const DEFAULT_ACTIVE_BREAK_MINUTES = 5;
const DEFAULT_REMINDER_THRESHOLD_MINUTES = 60;

export function ingestSedentarySpan(
  db: Database.Database,
  input: SedentarySpanIngestionInput
): StoredSedentarySpan {
  const normalized = normalizeSpanInput(input);
  const transaction = db.transaction((): StoredSedentarySpan => reserveSedentarySpanBySourceId(db, normalized).span);
  return transaction();
}

export function computeSedentarySummary(
  db: Database.Database,
  options: SedentarySummaryOptions
): SedentarySummary {
  const normalized = normalizeSummaryOptions(options);
  const spans = listSedentarySpansForWindow(db, normalized);
  const timeline = buildTimeline(spans, normalized.from, normalized.to);
  const idleStreaks = buildIdleStreaks(timeline, normalized.activeBreakMinutes, normalized.mergeUnknownGaps);
  const currentIdleStreak = idleStreaks.findLast((streak) => streak.windowEnd === normalized.to);

  return withoutUndefined({
    from: normalized.from,
    to: normalized.to,
    idleMinutes: totalMinutesFor(timeline, "idle"),
    activeMinutes: totalMinutesFor(timeline, "active"),
    unknownMinutes: totalMinutesFor(timeline, "unknown"),
    longestIdleStreakMinutes: Math.max(0, ...idleStreaks.map((streak) => streak.durationMinutes)),
    currentIdleStreakMinutes: currentIdleStreak?.durationMinutes ?? 0,
    currentIdleStreak,
    idleStreaks,
    spans
  });
}

export function evaluateBreakReminders(
  db: Database.Database,
  input: BreakReminderEvaluationInput
): BreakReminderEvaluationResult {
  const transaction = db.transaction((): BreakReminderEvaluationResult => {
    const summary = computeSedentarySummary(db, input);
    const thresholdMinutes = positiveInteger(input.thresholdMinutes ?? DEFAULT_REMINDER_THRESHOLD_MINUTES, "thresholdMinutes");
    const candidate = summary.currentIdleStreak;
    if (candidate === undefined || candidate.durationMinutes < thresholdMinutes) {
      return { status: "not_eligible", summary };
    }

    const evaluatedAt = assertIsoInstant(input.evaluatedAt ?? input.to, "evaluatedAt");
    const eligibleAt = addMinutes(candidate.windowStart, thresholdMinutes);
    const existingForContinuousStreak = findBreakReminderByStreakStartAndEligibleAt(db, {
      windowStart: candidate.windowStart,
      eligibleAt
    });
    if (existingForContinuousStreak !== undefined) {
      return {
        status: existingForContinuousStreak.reminder.status,
        summary,
        streak: existingForContinuousStreak.streak,
        reminder: existingForContinuousStreak.reminder
      };
    }

    const streak = persistSedentaryStreak(db, candidate, evaluatedAt);
    const existing = findBreakReminderByStreakAndEligibleAt(db, streak.id, eligibleAt);
    if (existing !== undefined) {
      return { status: existing.status, summary, streak, reminder: existing };
    }

    const status = reminderStatusForCooldown(db, eligibleAt, input.cooldownMinutes ?? 0);
    const reminder = insertBreakReminder(db, {
      streakId: streak.id,
      eligibleAt,
      status,
      reason: status === "eligible" ? `sedentary streak reached ${thresholdMinutes} minutes` : "cooldown active",
      ...(input.deliveryChannel === undefined ? {} : { deliveryChannel: assertSafeText(input.deliveryChannel, "deliveryChannel") })
    });
    return { status, summary, streak, reminder };
  });
  return transaction();
}

function normalizeSpanInput(input: SedentarySpanIngestionInput): Required<Omit<SedentarySpanIngestionInput, "confidence">> & {
  readonly confidence?: number;
} {
  const spanStart = assertIsoInstant(input.spanStart, "spanStart");
  const spanEnd = assertIsoInstant(input.spanEnd, "spanEnd");
  if (spanEnd <= spanStart) {
    throw new Error("spanEnd must be after spanStart");
  }
  return {
    sourceId: assertSafeText(input.sourceId, "sourceId"),
    spanStart,
    spanEnd,
    state: assertSedentaryState(input.state),
    ...(input.confidence === undefined ? {} : { confidence: assertConfidence(input.confidence, "confidence") }),
    receivedAt: assertIsoInstant(input.receivedAt ?? spanEnd, "receivedAt")
  };
}

function normalizeSummaryOptions(options: SedentarySummaryOptions): Required<SedentarySummaryOptions> {
  const from = assertIsoInstant(options.from, "from");
  const to = assertIsoInstant(options.to, "to");
  if (to <= from) {
    throw new Error("to must be after from");
  }
  return {
    from,
    to,
    activeBreakMinutes: nonNegativeInteger(options.activeBreakMinutes ?? DEFAULT_ACTIVE_BREAK_MINUTES, "activeBreakMinutes"),
    mergeUnknownGaps: options.mergeUnknownGaps ?? false
  };
}

function buildTimeline(spans: readonly StoredSedentarySpan[], from: string, to: string): readonly TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let cursor = from;
  for (const span of spans) {
    const start = maxInstant(from, cursor, span.spanStart);
    const end = minInstant(to, span.spanEnd);
    if (end <= cursor) {
      continue;
    }
    if (cursor < start) {
      segments.push({ start: cursor, end: start, state: "unknown" });
    }
    segments.push({ start, end, state: span.state, spanId: span.id });
    cursor = end;
  }
  if (cursor < to) {
    segments.push({ start: cursor, end: to, state: "unknown" });
  }
  return segments;
}

function buildIdleStreaks(
  segments: readonly TimelineSegment[],
  activeBreakMinutes: number,
  mergeUnknownGaps: boolean
): readonly SedentaryIdleStreak[] {
  const streaks: SedentaryIdleStreak[] = [];
  let current: StreakDraft | undefined;
  for (const segment of segments) {
    if (segment.state === "idle") {
      current = appendToStreak(current ?? newStreak(segment), segment, true);
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (keepsCurrentStreak(segment, activeBreakMinutes, mergeUnknownGaps)) {
      current = appendToStreak(current, segment, false);
    } else {
      closeStreak(streaks, current);
      current = undefined;
    }
  }
  if (current !== undefined) {
    closeStreak(streaks, current);
  }
  return streaks;
}

function appendToStreak(draft: StreakDraft, segment: TimelineSegment, countsAsIdle: boolean): StreakDraft {
  if (countsAsIdle) {
    draft.idleMinutes += minutesBetween(segment.start, segment.end);
  }
  draft.windowEnd = segment.end;
  if (segment.spanId !== undefined && !draft.sourceSpanIds.includes(segment.spanId)) {
    draft.sourceSpanIds.push(segment.spanId);
  }
  return draft;
}

function closeStreak(streaks: SedentaryIdleStreak[], draft: StreakDraft): void {
  streaks.push({
    windowStart: draft.windowStart,
    windowEnd: draft.windowEnd,
    durationMinutes: minutesBetween(draft.windowStart, draft.windowEnd),
    idleMinutes: draft.idleMinutes,
    sourceSpanIds: draft.sourceSpanIds
  });
}

function persistSedentaryStreak(
  db: Database.Database,
  streak: SedentaryIdleStreak,
  computedAt: string
): StoredSedentaryStreak {
  return (
    findSedentaryStreakByProjection(db, streak) ??
    insertSedentaryStreak(db, {
      windowStart: streak.windowStart,
      windowEnd: streak.windowEnd,
      durationMinutes: streak.durationMinutes,
      sourceSpanIds: streak.sourceSpanIds,
      computedAt
    })
  );
}

function reminderStatusForCooldown(
  db: Database.Database,
  eligibleAt: string,
  cooldownMinutes: number
): "eligible" | "suppressed" {
  const cooldown = nonNegativeInteger(cooldownMinutes, "cooldownMinutes");
  if (cooldown === 0) {
    return "eligible";
  }
  const recent = listEligibleBreakRemindersNear(db, { eligibleAt, cooldownMinutes: cooldown });
  return recent.length === 0 ? "eligible" : "suppressed";
}

function newStreak(segment: TimelineSegment): StreakDraft {
  return { windowStart: segment.start, windowEnd: segment.start, idleMinutes: 0, sourceSpanIds: [] };
}

function keepsCurrentStreak(segment: TimelineSegment, activeBreakMinutes: number, mergeUnknownGaps: boolean): boolean {
  if (segment.state === "active") {
    return minutesBetween(segment.start, segment.end) < activeBreakMinutes;
  }
  return segment.state === "unknown" && mergeUnknownGaps;
}

function totalMinutesFor(segments: readonly TimelineSegment[], state: SedentaryState): number {
  return segments.filter((segment) => segment.state === state).reduce((total, segment) => total + minutesBetween(segment.start, segment.end), 0);
}

function assertSedentaryState(value: SedentaryState): SedentaryState {
  if (!SEDENTARY_STATES.includes(value)) {
    throw new Error("state must be active, idle, or unknown");
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

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function minutesBetween(start: string, end: string): number {
  return Math.floor((Date.parse(end) - Date.parse(start)) / 60000);
}

function addMinutes(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60 * 1000).toISOString();
}

function maxInstant(...values: readonly string[]): string {
  return values.reduce((max, value) => (value > max ? value : max));
}

function minInstant(...values: readonly string[]): string {
  return values.reduce((min, value) => (value < min ? value : min));
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}
