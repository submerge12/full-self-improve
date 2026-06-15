import type Database from "better-sqlite3";

import {
  API_ROUTE_MANIFEST,
  ApiAuthConfigurationError,
  ApiAuthError,
  authorizeApiRequest,
  findApiRoute,
  type ApiMethod,
  type ApiResponse,
  type ApiRouteId
} from "./contracts.js";
import { listPublicPages } from "../db/content-store.js";
import { persistTraceEvents } from "../db/trace-store.js";
import {
  createPersistentApplicationTask,
  gradePersistentApplicationAttempt
} from "../engine/persistent-application.js";
import { diagnosePersistentWeakSpots } from "../engine/persistent-diagnose.js";
import { runPersistentMockIngest } from "../engine/persistent-ingest.js";
import { createPersistentDailyPlan } from "../engine/persistent-plan.js";
import { gradePersistentExactQuizAttempt } from "../engine/persistent-quiz.js";
import {
  listDuePersistentReviews,
  recordPersistentReviewAttempt,
  type PersistentReviewRating
} from "../engine/persistent-review.js";
import { gradePersistentTeachback } from "../engine/persistent-teachback.js";
import type { SourceAdapter } from "../engine/source-adapter.js";
import type { TraceEvent } from "../engine/trace.js";
import type { AgentBoardClient } from "../agents/executor.js";
import {
  completeExerciseSession,
  createExercisePlanFromTemplate,
  createExerciseTemplate,
  queryExerciseCompletion,
  type ExerciseTemplateDayInput
} from "../health-extensions/exercise.js";
import {
  generateCoachDigestSnapshot,
  publishCoachDigestSnapshot,
  type CoachDigestBoardPublish,
  type CoachDigestPublishAction,
  type CoachDigestPublishResult
} from "../health-extensions/coach-digest.js";
import type { AgentIntendedAction } from "../agents/dry-run.js";
import {
  createHealthMetric,
  importHealthMetricsCsv,
  queryHealthMetrics,
  updateHealthMetric
} from "../health-extensions/metrics.js";
import {
  computeSedentarySummary,
  evaluateBreakReminders,
  ingestSedentarySpan,
  type BreakReminderEvaluationInput,
  type SedentarySummaryOptions
} from "../health-extensions/sedentary.js";
import {
  assertIsoDate,
  assertIsoInstant,
  assertSafeText,
  type ExerciseIntensity,
  type HealthMetricQuery,
  type StoredSedentarySpan
} from "../health-extensions/schema.js";
import { parseWindowsLoggerSpanPost } from "../health-extensions/windows-logger-contract.js";

export interface ApiRequest {
  readonly method: ApiMethod;
  readonly path: string;
  readonly headers: Record<string, string | readonly string[] | undefined>;
  readonly body?: unknown;
}

export interface ApiHandlerContext {
  readonly db: Database.Database;
  readonly expectedBearerToken?: string;
  readonly adapters?: Readonly<Record<string, SourceAdapter>>;
  readonly now?: Date | (() => Date);
  readonly coachDigestPublisher?: CoachDigestBoardPublish;
  readonly boardClient?: Pick<AgentBoardClient, "publish">;
}

export type ApiHandlerResponseBody = ApiSuccessBody | ApiErrorBody;

export interface ApiSuccessBody {
  readonly ok: true;
  readonly routeId: ApiRouteId;
  readonly data: Record<string, unknown>;
}

export interface ApiErrorBody {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly routeId?: ApiRouteId;
  };
}

interface MasterySummaryRow {
  conceptSlug: string;
  conceptName: string;
  score: number;
  confidence: number;
  attemptsN: number;
  lastSeenAt: string | null;
}

interface QuizGradeBody {
  conceptSlug: string;
  statement: string;
  answer?: string | string[];
  answers?: string[];
  answerSpec?: {
    type: "exact";
    answers: string[];
    trim?: boolean;
    caseSensitive?: boolean;
  };
  response: string;
  difficulty?: number;
}

interface TeachbackBody {
  conceptSlug: string;
  transcript: string;
}

interface ApplicationTaskBody {
  conceptSlug: string;
  difficulty?: number;
}

interface ApplicationGradeBody {
  itemId: number;
  response: string;
}

interface ReviewDueQuery {
  target: string;
  limit?: number;
}

interface ReviewAttemptBody {
  conceptSlug: string;
  rating: PersistentReviewRating;
  reviewedAt: string;
}

interface HealthMetricCreateBody {
  metricKey: string;
  metricLabel: string;
  value: number;
  unit: string;
  observedAt: string;
  note?: string;
}

interface HealthMetricUpdateBody {
  id: number;
  changes: {
    metricKey?: string;
    metricLabel?: string;
    value?: number;
    unit?: string;
    observedAt?: string;
    note?: string;
  };
  reason: string;
}

interface HealthMetricImportBody {
  sourceFilename: string;
  csvText: string;
}

interface HealthCoachDigestGenerateBody {
  date: string;
  offline?: boolean;
  compassBaseUrl?: string;
}

interface HealthCoachDigestPublishBody {
  snapshotId: number;
  dryRun?: boolean;
}

type ApiCoachDigestPublishResult =
  | {
      readonly snapshotId: number;
      readonly status: "dry_run";
      readonly intendedAction: AgentIntendedAction;
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

interface ExerciseTemplateCreateBody {
  slug: string;
  name: string;
  description?: string;
  defaultDays: ExerciseTemplateDayInput[];
}

interface ExercisePlanCreateBody {
  templateSlug: string;
  weekStart: string;
}

interface ExerciseSessionCompleteBody {
  sessionId?: number;
  planId?: number;
  templateSessionKey?: string;
  completedAt: string;
  durationMinutes?: number;
  intensity?: ExerciseIntensity;
  note?: string;
}

interface ExerciseCompletionQuery {
  from: string;
  to: string;
}

interface SedentarySpanResponse {
  readonly id: number;
  readonly sourceId?: string;
  readonly spanStart: string;
  readonly spanEnd: string;
  readonly state: string;
  readonly confidence?: number;
  readonly receivedAt: string;
}

class ApiBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiBadRequestError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function handleApiRequest(
  request: ApiRequest,
  context: ApiHandlerContext
): Promise<ApiResponse<ApiHandlerResponseBody>> {
  const route = findApiRoute(request.method, request.path) ?? reviewDueRouteForMalformedQuery(request);
  if (route === undefined) {
    return errorResponse(404, "route_not_found", "API route was not found.");
  }

  try {
    authorizeApiRequest(route, request.headers, context.expectedBearerToken);
  } catch (error) {
    if (error instanceof ApiAuthConfigurationError) {
      return errorResponse(500, "auth_not_configured", error.message, route.id);
    }

    if (error instanceof ApiAuthError) {
      return errorResponse(401, "unauthorized", error.message, route.id);
    }

    return unexpectedError(route.id);
  }

  try {
    switch (route.id) {
      case "ingest.run":
        return await handleIngestRun(request, context);
      case "plan.today":
        return handlePlanToday(context);
      case "plan.generate":
        return handlePlanGenerate(context);
      case "mastery.summary":
        return handleMasterySummary(context);
      case "quiz.grade":
        return handleQuizGrade(request, context);
      case "teachback.submit":
        return handleTeachback(request, context);
      case "application.task.create":
        return handleApplicationTaskCreate(request, context);
      case "application.grade":
        return handleApplicationGrade(request, context);
      case "review.due":
        return handleReviewDue(request, context);
      case "review.attempt":
        return handleReviewAttempt(request, context);
      case "wiki.pages":
        return successResponse("wiki.pages", { pages: listPublicPages(context.db) });
      case "health.metrics.create":
        return handleHealthMetricCreate(request, context);
      case "health.metrics.list":
        return handleHealthMetricList(request, context);
      case "health.metrics.update":
        return handleHealthMetricUpdate(request, context);
      case "health.metrics.import":
        return handleHealthMetricImport(request, context);
      case "health.exercise.templates.create":
        return handleExerciseTemplateCreate(request, context);
      case "health.exercise.plans.create":
        return handleExercisePlanCreate(request, context);
      case "health.exercise.sessions.complete":
        return handleExerciseSessionComplete(request, context);
      case "health.exercise.completion":
        return handleExerciseCompletion(request, context);
      case "health.sedentary.spans.ingest":
        return handleSedentarySpanIngest(request, context);
      case "health.sedentary.summary":
        return handleSedentarySummary(request, context);
      case "health.break-reminders.evaluate":
        return handleBreakReminderEvaluate(request, context);
      case "health.coach-digest.generate":
        return await handleHealthCoachDigestGenerate(request, context);
      case "health.coach-digest.publish":
        return await handleHealthCoachDigestPublish(request, context);
    }
  } catch (error) {
    if (error instanceof ApiBadRequestError || isRouteInputError(route.id, error)) {
      return errorResponse(400, "invalid_request_body", error.message, route.id);
    }

    return unexpectedError(route.id);
  }
}

async function handleIngestRun(
  request: ApiRequest,
  context: ApiHandlerContext
): Promise<ApiResponse<ApiHandlerResponseBody>> {
  const adapterId = adapterIdFromPath(request.path);
  const adapter = adapterId === undefined ? undefined : context.adapters?.[adapterId];
  if (adapter === undefined) {
    return errorResponse(404, "adapter_not_found", "Source adapter was not found.", "ingest.run");
  }

  const summary = await runPersistentMockIngest(context.db, adapter);
  persistTraceEvents(context.db, summary.traceEvents);

  return successResponse("ingest.run", { summary });
}

function handlePlanToday(context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const plan = runMutationWithTrace(context.db, () => createPersistentDailyPlan(context.db, { date: currentDate(context) }));

  return successResponse("plan.today", { plan });
}

function handlePlanGenerate(context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const plan = runMutationWithTrace(context.db, () =>
    createPersistentDailyPlan(context.db, { date: currentDate(context), force: true })
  );

  return successResponse("plan.generate", { plan });
}

function handleMasterySummary(context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const { diagnosis, masteryRows } = context.db.transaction(() => {
    const diagnosis = diagnosePersistentWeakSpots(context.db);
    persistTraceEvents(context.db, diagnosis.traceEvents);

    return {
      masteryRows: listMasteryRows(context.db),
      diagnosis
    };
  })();

  return successResponse("mastery.summary", {
    masteryRows,
    diagnosis
  });
}

function handleQuizGrade(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const body = parseQuizGradeBody(request.body);
  const result = runMutationWithTrace(context.db, () =>
    gradePersistentExactQuizAttempt(context.db, {
      ...body,
      lastSeenAt: nowDate(context).toISOString()
    })
  );

  return successResponse("quiz.grade", { result });
}

function handleTeachback(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const body = parseTeachbackBody(request.body);
  const result = runMutationWithTrace(context.db, () =>
    gradePersistentTeachback(context.db, {
      ...body,
      lastSeenAt: nowDate(context).toISOString()
    })
  );

  return successResponse("teachback.submit", { result });
}

function handleApplicationTaskCreate(
  request: ApiRequest,
  context: ApiHandlerContext
): ApiResponse<ApiHandlerResponseBody> {
  const body = parseApplicationTaskBody(request.body);
  const result = runMutationWithTrace(context.db, () => createPersistentApplicationTask(context.db, body));

  return successResponse("application.task.create", { result });
}

function handleApplicationGrade(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const body = parseApplicationGradeBody(request.body);
  const result = runMutationWithTrace(context.db, () =>
    gradePersistentApplicationAttempt(context.db, {
      ...body,
      lastSeenAt: nowDate(context).toISOString()
    })
  );

  return successResponse("application.grade", { result });
}

function handleReviewDue(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const query = parseReviewDueQuery(request.path);
  const reviews = listDuePersistentReviews(context.db, {
    target: query.target,
    ...(query.limit === undefined ? {} : { limit: query.limit })
  });

  return successResponse("review.due", { target: query.target, reviews });
}

function handleReviewAttempt(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const body = parseReviewAttemptBody(request.body);
  const result = runMutationWithTrace(context.db, () => recordPersistentReviewAttempt(context.db, body));

  return successResponse("review.attempt", { result });
}

function handleHealthMetricCreate(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const body = parseHealthMetricCreateBody(request.body);
  const result = createHealthMetric(
    context.db,
    {
      ...body,
      source: "manual"
    },
    { now: nowDate(context).toISOString() }
  );

  return successResponse("health.metrics.create", { result });
}

function handleHealthMetricList(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const metrics = queryHealthMetrics(context.db, parseHealthMetricListQuery(request.path));

  return successResponse("health.metrics.list", { metrics });
}

function handleHealthMetricUpdate(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const body = parseHealthMetricUpdateBody(request.body);
  const result = updateHealthMetric(context.db, {
    id: body.id,
    changes: body.changes,
    changedBy: "api",
    reason: body.reason,
    now: nowDate(context).toISOString(),
    runId: `health-metric-api-update-${body.id}`
  });

  return successResponse("health.metrics.update", { result });
}

function handleHealthMetricImport(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const body = parseHealthMetricImportBody(request.body);
  const importedAt = nowDate(context).toISOString();
  const result = importHealthMetricsCsv(context.db, {
    ...body,
    importedAt,
    runId: `health-metrics-api-import-${importedAt}`
  });

  return successResponse("health.metrics.import", { result });
}

function handleExerciseTemplateCreate(
  request: ApiRequest,
  context: ApiHandlerContext
): ApiResponse<ApiHandlerResponseBody> {
  const body = parseExerciseTemplateCreateBody(request.body);
  const result = createExerciseTemplate(context.db, body);

  return successResponse("health.exercise.templates.create", { result });
}

function handleExercisePlanCreate(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const body = parseExercisePlanCreateBody(request.body);
  const result = createExercisePlanFromTemplate(context.db, body);

  return successResponse("health.exercise.plans.create", { result });
}

function handleExerciseSessionComplete(
  request: ApiRequest,
  context: ApiHandlerContext
): ApiResponse<ApiHandlerResponseBody> {
  const body = parseExerciseSessionCompleteBody(request.body);
  const result = completeExerciseSession(context.db, body);

  return successResponse("health.exercise.sessions.complete", { result });
}

function handleExerciseCompletion(request: ApiRequest, context: ApiHandlerContext): ApiResponse<ApiHandlerResponseBody> {
  const summary = queryExerciseCompletion(context.db, parseExerciseCompletionQuery(request.path));

  return successResponse("health.exercise.completion", { summary });
}

function handleSedentarySpanIngest(
  request: ApiRequest,
  context: ApiHandlerContext
): ApiResponse<ApiHandlerResponseBody> {
  const span = ingestSedentarySpan(context.db, parseSedentarySpanIngestBody(request.body));

  return successResponse("health.sedentary.spans.ingest", { span: stableSedentarySpan(span) });
}

function handleSedentarySummary(
  request: ApiRequest,
  context: ApiHandlerContext
): ApiResponse<ApiHandlerResponseBody> {
  const summary = computeSedentarySummary(context.db, parseSedentarySummaryQuery(request.path));

  return successResponse("health.sedentary.summary", { summary });
}

function handleBreakReminderEvaluate(
  request: ApiRequest,
  context: ApiHandlerContext
): ApiResponse<ApiHandlerResponseBody> {
  const result = evaluateBreakReminders(context.db, parseBreakReminderEvaluationBody(request.body));

  return successResponse("health.break-reminders.evaluate", { result });
}

async function handleHealthCoachDigestGenerate(
  request: ApiRequest,
  context: ApiHandlerContext
): Promise<ApiResponse<ApiHandlerResponseBody>> {
  const body = parseHealthCoachDigestGenerateBody(request.body);
  const compassBaseUrl = body.offline === true ? undefined : body.compassBaseUrl;
  const result = await generateCoachDigestSnapshot(context.db, {
    date: body.date,
    offline: compassBaseUrl === undefined,
    now: nowDate(context).toISOString(),
    runId: `health-coach-digest-api-${body.date}`,
    ...(compassBaseUrl === undefined
      ? {}
      : {
          compass: {
            baseUrl: compassBaseUrl,
            fetch: globalThis.fetch
          }
        })
  });

  return successResponse("health.coach-digest.generate", { result });
}

async function handleHealthCoachDigestPublish(
  request: ApiRequest,
  context: ApiHandlerContext
): Promise<ApiResponse<ApiHandlerResponseBody>> {
  const body = parseHealthCoachDigestPublishBody(request.body);
  const result = await publishCoachDigestSnapshot(context.db, {
    snapshotId: body.snapshotId,
    dryRun: body.dryRun ?? false,
    now: nowDate(context).toISOString(),
    ...(body.dryRun === true ? {} : { publish: coachDigestPublishFunction(context) ?? missingCoachDigestPublisher })
  });

  return successResponse("health.coach-digest.publish", { result: apiCoachDigestPublishResult(result) });
}

function runMutationWithTrace<T extends { traceEvents: readonly TraceEvent[] }>(
  db: Database.Database,
  mutation: () => T
): T {
  return db.transaction(() => {
    const result = mutation();
    persistTraceEvents(db, result.traceEvents);

    return result;
  })();
}

function listMasteryRows(db: Database.Database): MasterySummaryRow[] {
  return db
    .prepare(
      `SELECT
         concepts.slug AS conceptSlug,
         concepts.name AS conceptName,
         mastery.score,
         mastery.confidence,
         mastery.attempts_n AS attemptsN,
         mastery.last_seen_at AS lastSeenAt
       FROM mastery
       INNER JOIN concepts ON concepts.id = mastery.concept_id
       ORDER BY concepts.slug`
    )
    .all() as MasterySummaryRow[];
}

function parseQuizGradeBody(body: unknown): QuizGradeBody {
  const record = parseBodyRecord(body);
  const conceptSlug = requiredString(record, "conceptSlug");
  const statement = requiredString(record, "statement");
  const response = requiredString(record, "response");
  const difficulty = optionalDifficulty(record.difficulty);
  const answer = optionalStringOrStringArray(record.answer, "answer");
  const answers = optionalStringArray(record.answers, "answers");
  const answerSpec = optionalAnswerSpec(record.answerSpec);

  if (answer === undefined && answers === undefined && answerSpec === undefined) {
    throw new ApiBadRequestError("Quiz grading requires answer, answers, or answerSpec.");
  }

  return {
    conceptSlug,
    statement,
    response,
    ...(answer === undefined ? {} : { answer }),
    ...(answers === undefined ? {} : { answers }),
    ...(answerSpec === undefined ? {} : { answerSpec }),
    ...(difficulty === undefined ? {} : { difficulty })
  };
}

function parseTeachbackBody(body: unknown): TeachbackBody {
  const record = parseBodyRecord(body);

  return {
    conceptSlug: requiredString(record, "conceptSlug"),
    transcript: requiredString(record, "transcript")
  };
}

function parseApplicationTaskBody(body: unknown): ApplicationTaskBody {
  const record = parseBodyRecord(body);
  const difficulty = optionalDifficulty(record.difficulty);

  return {
    conceptSlug: requiredString(record, "conceptSlug"),
    ...(difficulty === undefined ? {} : { difficulty })
  };
}

function parseApplicationGradeBody(body: unknown): ApplicationGradeBody {
  const record = parseBodyRecord(body);

  return {
    itemId: requiredPositiveInteger(record, "itemId"),
    response: requiredString(record, "response")
  };
}

function parseReviewAttemptBody(body: unknown): ReviewAttemptBody {
  const record = parseBodyRecord(body);

  return {
    conceptSlug: requiredString(record, "conceptSlug"),
    rating: requiredReviewRating(record.rating),
    reviewedAt: requiredString(record, "reviewedAt")
  };
}

function parseHealthMetricCreateBody(body: unknown): HealthMetricCreateBody {
  const record = parseBodyRecord(body);
  const note = optionalString(record.note, "note");

  return {
    metricKey: requiredString(record, "metricKey"),
    metricLabel: requiredString(record, "metricLabel"),
    value: requiredFiniteNumber(record, "value"),
    unit: requiredString(record, "unit"),
    observedAt: requiredString(record, "observedAt"),
    ...(note === undefined ? {} : { note })
  };
}

function parseHealthMetricUpdateBody(body: unknown): HealthMetricUpdateBody {
  const record = parseBodyRecord(body);
  const changes: HealthMetricUpdateBody["changes"] = {};
  const metricKey = optionalNonEmptyString(record.metricKey, "metricKey");
  const metricLabel = optionalNonEmptyString(record.metricLabel, "metricLabel");
  const value = optionalFiniteNumber(record.value, "value");
  const unit = optionalNonEmptyString(record.unit, "unit");
  const observedAt = optionalNonEmptyString(record.observedAt, "observedAt");
  const note = optionalString(record.note, "note");

  if (metricKey !== undefined) {
    changes.metricKey = metricKey;
  }
  if (metricLabel !== undefined) {
    changes.metricLabel = metricLabel;
  }
  if (value !== undefined) {
    changes.value = value;
  }
  if (unit !== undefined) {
    changes.unit = unit;
  }
  if (observedAt !== undefined) {
    changes.observedAt = observedAt;
  }
  if (note !== undefined) {
    changes.note = note;
  }
  if (Object.keys(changes).length === 0) {
    throw new ApiBadRequestError("Health metric update requires at least one changed field.");
  }

  return {
    id: requiredPositiveInteger(record, "id"),
    changes,
    reason: requiredString(record, "reason")
  };
}

function parseHealthMetricImportBody(body: unknown): HealthMetricImportBody {
  const record = parseBodyRecord(body);

  return {
    sourceFilename: requiredString(record, "sourceFilename"),
    csvText: requiredString(record, "csvText")
  };
}

function parseHealthCoachDigestGenerateBody(body: unknown): HealthCoachDigestGenerateBody {
  const record = parseBodyRecord(body);
  const date = requiredIsoDateBody(record, "date");
  const offline = optionalBoolean(record.offline, "offline");
  const compassBaseUrl = optionalCompassBaseUrl(record.compassBaseUrl);

  return {
    date,
    ...(offline === undefined ? {} : { offline }),
    ...(compassBaseUrl === undefined ? {} : { compassBaseUrl })
  };
}

function parseHealthCoachDigestPublishBody(body: unknown): HealthCoachDigestPublishBody {
  const record = parseBodyRecord(body);
  const dryRun = optionalBoolean(record.dryRun, "dryRun");

  return {
    snapshotId: requiredPositiveInteger(record, "snapshotId"),
    ...(dryRun === undefined ? {} : { dryRun })
  };
}

function parseExerciseTemplateCreateBody(body: unknown): ExerciseTemplateCreateBody {
  const record = parseBodyRecord(body);
  const description = optionalString(record.description, "description");

  return {
    slug: requiredString(record, "slug"),
    name: requiredString(record, "name"),
    ...(description === undefined ? {} : { description }),
    defaultDays: requiredExerciseTemplateDays(record.defaultDays)
  };
}

function parseExercisePlanCreateBody(body: unknown): ExercisePlanCreateBody {
  const record = parseBodyRecord(body);

  return {
    templateSlug: requiredString(record, "templateSlug"),
    weekStart: requiredString(record, "weekStart")
  };
}

function parseExerciseSessionCompleteBody(body: unknown): ExerciseSessionCompleteBody {
  const record = parseBodyRecord(body);
  const sessionId = optionalPositiveSafeInteger(record.sessionId, "sessionId");
  const planId = optionalPositiveSafeInteger(record.planId, "planId");
  const templateSessionKey = optionalNonEmptyString(record.templateSessionKey, "templateSessionKey");
  assertExerciseCompletionTargetMode(sessionId, planId, templateSessionKey);
  const durationMinutes = optionalPositiveSafeInteger(record.durationMinutes, "durationMinutes");
  const intensity = optionalExerciseIntensity(record.intensity);
  const note = optionalString(record.note, "note");

  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(planId === undefined ? {} : { planId }),
    ...(templateSessionKey === undefined ? {} : { templateSessionKey }),
    completedAt: requiredString(record, "completedAt"),
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    ...(intensity === undefined ? {} : { intensity }),
    ...(note === undefined ? {} : { note })
  };
}

function assertExerciseCompletionTargetMode(
  sessionId: number | undefined,
  planId: number | undefined,
  templateSessionKey: string | undefined
): void {
  const hasSessionId = sessionId !== undefined;
  const hasPlanTarget = planId !== undefined || templateSessionKey !== undefined;
  const hasCompletePlanTarget = planId !== undefined && templateSessionKey !== undefined;
  if ((hasSessionId && hasPlanTarget) || (!hasSessionId && hasPlanTarget && !hasCompletePlanTarget)) {
    throw new ApiBadRequestError("completion target must be sessionId, planId with templateSessionKey, or omitted");
  }
}

function parseExerciseCompletionQuery(path: string): ExerciseCompletionQuery {
  const url = parseRequestPath(path);

  return {
    from: requiredIsoDateQuery(url.searchParams.get("from"), "from"),
    to: requiredIsoDateQuery(url.searchParams.get("to"), "to")
  };
}

function parseSedentarySpanIngestBody(body: unknown): ReturnType<typeof parseWindowsLoggerSpanPost> {
  try {
    return parseWindowsLoggerSpanPost(body);
  } catch (error) {
    throw new ApiBadRequestError(errorMessage(error));
  }
}

function parseSedentarySummaryQuery(path: string): SedentarySummaryOptions {
  const url = parseRequestPath(path);
  const from = requiredIsoInstantQuery(url.searchParams.get("from"), "from", "Sedentary summary");
  const to = requiredIsoInstantQuery(url.searchParams.get("to"), "to", "Sedentary summary");
  assertOrderedInstantWindow(from, to);
  const activeBreakMinutes = optionalNonNegativeIntegerQuery(url.searchParams.get("activeBreakMinutes"), "activeBreakMinutes");
  const mergeUnknownGaps = optionalBooleanQuery(url.searchParams.get("mergeUnknownGaps"), "mergeUnknownGaps");

  return {
    from,
    to,
    ...(activeBreakMinutes === undefined ? {} : { activeBreakMinutes }),
    ...(mergeUnknownGaps === undefined ? {} : { mergeUnknownGaps })
  };
}

function parseBreakReminderEvaluationBody(body: unknown): BreakReminderEvaluationInput {
  const record = parseBodyRecord(body);
  const from = requiredIsoInstantBody(record, "from");
  const to = requiredIsoInstantBody(record, "to");
  assertOrderedInstantWindow(from, to);
  const thresholdMinutes = optionalPositiveSafeInteger(record.thresholdMinutes, "thresholdMinutes");
  const cooldownMinutes = optionalNonNegativeSafeInteger(record.cooldownMinutes, "cooldownMinutes");
  const activeBreakMinutes = optionalNonNegativeSafeInteger(record.activeBreakMinutes, "activeBreakMinutes");
  const evaluatedAt = optionalIsoInstantBody(record.evaluatedAt, "evaluatedAt");
  const mergeUnknownGaps = optionalBoolean(record.mergeUnknownGaps, "mergeUnknownGaps");
  const deliveryChannel = optionalSafeText(record.deliveryChannel, "deliveryChannel");

  return {
    from,
    to,
    ...(thresholdMinutes === undefined ? {} : { thresholdMinutes }),
    ...(cooldownMinutes === undefined ? {} : { cooldownMinutes }),
    ...(evaluatedAt === undefined ? {} : { evaluatedAt }),
    ...(activeBreakMinutes === undefined ? {} : { activeBreakMinutes }),
    ...(mergeUnknownGaps === undefined ? {} : { mergeUnknownGaps }),
    ...(deliveryChannel === undefined ? {} : { deliveryChannel })
  };
}

function parseReviewDueQuery(path: string): ReviewDueQuery {
  const url = parseRequestPath(path);
  const target = url.searchParams.get("target");
  if (target === null || target.trim().length === 0) {
    throw new ApiBadRequestError("Review due-list query parameter target must be a non-empty string.");
  }

  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? undefined : parseQueryLimit(limitValue);

  return {
    target,
    ...(limit === undefined ? {} : { limit })
  };
}

function parseHealthMetricListQuery(path: string): HealthMetricQuery {
  const url = parseRequestPath(path);
  const metric = url.searchParams.get("metric");
  const observedFrom = parseHealthMetricQueryInstant(url.searchParams.get("from"), "from", "start");
  const observedTo = parseHealthMetricQueryInstant(url.searchParams.get("to"), "to", "end");
  const limit = parseHealthMetricQueryLimit(url.searchParams.get("limit"));

  if (observedFrom !== undefined && observedTo !== undefined && observedFrom > observedTo) {
    throw new ApiBadRequestError("Health metric query from must be before or equal to to.");
  }

  return {
    ...(metric === null ? {} : { metricKey: requiredQueryString(metric, "metric") }),
    ...(observedFrom === undefined ? {} : { observedFrom }),
    ...(observedTo === undefined ? {} : { observedTo }),
    ...(limit === undefined ? {} : { limit })
  };
}

function parseBodyRecord(body: unknown): Record<string, unknown> {
  const parsed = typeof body === "string" ? parseJsonBody(body) : body;
  if (isPlainObject(parsed)) {
    return parsed;
  }

  throw new ApiBadRequestError("Request body must be a JSON object.");
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiBadRequestError("Request body must be valid JSON.");
  }
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiBadRequestError(`Request body field ${field} must be a non-empty string.`);
  }

  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ApiBadRequestError(`Request body field ${field} must be an array of strings.`);
  }

  return [...value];
}

function optionalStringOrStringArray(value: unknown, field: string): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  return optionalStringArray(value, field);
}

function optionalAnswerSpec(value: unknown): QuizGradeBody["answerSpec"] {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value) || value.type !== "exact") {
    throw new ApiBadRequestError("Request body field answerSpec must be an exact answer spec.");
  }

  const answers = optionalStringArray(value.answers, "answerSpec.answers");
  if (answers === undefined || answers.length === 0) {
    throw new ApiBadRequestError("Request body field answerSpec.answers must contain at least one answer.");
  }

  if (value.trim !== undefined && typeof value.trim !== "boolean") {
    throw new ApiBadRequestError("Request body field answerSpec.trim must be boolean.");
  }

  if (value.caseSensitive !== undefined && typeof value.caseSensitive !== "boolean") {
    throw new ApiBadRequestError("Request body field answerSpec.caseSensitive must be boolean.");
  }

  return {
    type: "exact",
    answers,
    ...(value.trim === undefined ? {} : { trim: value.trim }),
    ...(value.caseSensitive === undefined ? {} : { caseSensitive: value.caseSensitive })
  };
}

function optionalDifficulty(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new ApiBadRequestError("Request body field difficulty must be an integer between 1 and 5.");
  }

  return value;
}

function requiredPositiveInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiBadRequestError(`Request body field ${field} must be a positive safe integer.`);
  }

  return value;
}

function requiredFiniteNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiBadRequestError(`Request body field ${field} must be a finite number.`);
  }

  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiBadRequestError(`Request body field ${field} must be a non-empty string.`);
  }

  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ApiBadRequestError(`Request body field ${field} must be a string.`);
  }

  return value;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiBadRequestError(`Request body field ${field} must be a finite number.`);
  }

  return value;
}

function requiredExerciseTemplateDays(value: unknown): ExerciseTemplateDayInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiBadRequestError("Request body field defaultDays must be a non-empty array.");
  }

  return value.map(requiredExerciseTemplateDay);
}

function requiredExerciseTemplateDay(value: unknown): ExerciseTemplateDayInput {
  if (!isPlainObject(value)) {
    throw new ApiBadRequestError("Request body field defaultDays must contain objects.");
  }

  const targetMinutes = optionalPositiveSafeInteger(value.targetMinutes, "defaultDays.targetMinutes");
  const targetReps = optionalPositiveSafeInteger(value.targetReps, "defaultDays.targetReps");
  if (targetMinutes === undefined && targetReps === undefined) {
    throw new ApiBadRequestError("Request body field defaultDays requires targetMinutes or targetReps.");
  }

  return {
    sessionKey: requiredString(value, "sessionKey"),
    dayOffset: requiredNonNegativeSafeInteger(value, "dayOffset"),
    title: requiredString(value, "title"),
    ...(targetMinutes === undefined ? {} : { targetMinutes }),
    ...(targetReps === undefined ? {} : { targetReps })
  };
}

function requiredNonNegativeSafeInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiBadRequestError(`Request body field ${field} must be a non-negative safe integer.`);
  }

  return value;
}

function optionalPositiveSafeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiBadRequestError(`Request body field ${field} must be a positive safe integer.`);
  }

  return value;
}

function optionalNonNegativeSafeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiBadRequestError(`Request body field ${field} must be a non-negative safe integer.`);
  }

  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ApiBadRequestError(`Request body field ${field} must be boolean.`);
  }

  return value;
}

function optionalSafeText(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ApiBadRequestError(`Request body field ${field} must be a non-empty string.`);
  }

  try {
    return assertSafeText(value, field);
  } catch (error) {
    throw new ApiBadRequestError(errorMessage(error));
  }
}

function optionalExerciseIntensity(value: unknown): ExerciseIntensity | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "low" || value === "moderate" || value === "high") {
    return value;
  }

  throw new ApiBadRequestError("Request body field intensity must be low, moderate, or high.");
}

function requiredIsoDateQuery(value: string | null, field: "from" | "to"): string {
  if (value === null || value.trim().length === 0) {
    throw new ApiBadRequestError(`Exercise completion query parameter ${field} must be an ISO date.`);
  }

  try {
    return assertIsoDate(value, field);
  } catch (error) {
    throw new ApiBadRequestError(errorMessage(error));
  }
}

function requiredIsoDateBody(record: Record<string, unknown>, field: string): string {
  try {
    return assertIsoDate(requiredString(record, field), field);
  } catch (error) {
    throw new ApiBadRequestError(errorMessage(error));
  }
}

function requiredIsoInstantQuery(value: string | null, field: "from" | "to", label: string): string {
  if (value === null || value.trim().length === 0) {
    throw new ApiBadRequestError(`${label} query parameter ${field} must be an ISO instant.`);
  }

  try {
    return assertIsoInstant(value, field);
  } catch (error) {
    throw new ApiBadRequestError(errorMessage(error));
  }
}

function requiredIsoInstantBody(record: Record<string, unknown>, field: "from" | "to"): string {
  try {
    return assertIsoInstant(requiredString(record, field), field);
  } catch (error) {
    throw new ApiBadRequestError(errorMessage(error));
  }
}

function optionalIsoInstantBody(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ApiBadRequestError(`Request body field ${field} must be a non-empty string.`);
  }

  try {
    return assertIsoInstant(value, field);
  } catch (error) {
    throw new ApiBadRequestError(errorMessage(error));
  }
}

function assertOrderedInstantWindow(from: string, to: string): void {
  if (to <= from) {
    throw new ApiBadRequestError("to must be after from");
  }
}

function optionalNonNegativeIntegerQuery(value: string | null, field: string): number | undefined {
  if (value === null) {
    return undefined;
  }

  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new ApiBadRequestError(`Sedentary summary query parameter ${field} must be a non-negative integer string.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiBadRequestError(`Sedentary summary query parameter ${field} must be a non-negative integer string.`);
  }

  return parsed;
}

function optionalBooleanQuery(value: string | null, field: string): boolean | undefined {
  if (value === null) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new ApiBadRequestError(`Sedentary summary query parameter ${field} must be true or false.`);
}

function optionalCompassBaseUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ApiBadRequestError("Request body field compassBaseUrl must be an HTTP(S) URL without credentials.");
  }

  const text = value.trim();
  if (text.length === 0) {
    throw new ApiBadRequestError("Request body field compassBaseUrl must be an HTTP(S) URL without credentials.");
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ApiBadRequestError("Request body field compassBaseUrl must be an HTTP(S) URL without credentials.");
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ApiBadRequestError("Request body field compassBaseUrl must be an HTTP(S) URL without credentials.");
  }

  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }

  return parsed.toString();
}

function requiredReviewRating(value: unknown): PersistentReviewRating {
  if (value === "again" || value === "hard" || value === "good" || value === "easy") {
    return value;
  }

  throw new ApiBadRequestError("Request body field rating must be one of again, hard, good, or easy.");
}

function parseQueryLimit(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ApiBadRequestError("Review due-list query parameter limit must be a positive safe integer string.");
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new ApiBadRequestError("Review due-list query parameter limit must be a positive safe integer string.");
  }

  return limit;
}

function requiredQueryString(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new ApiBadRequestError(`Health metric query parameter ${field} must be a non-empty string.`);
  }

  return value;
}

function parseHealthMetricQueryInstant(
  value: string | null,
  field: "from" | "to",
  boundary: "start" | "end"
): string | undefined {
  if (value === null) {
    return undefined;
  }

  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const date = assertIsoDate(value, field);

      return boundary === "start" ? `${date}T00:00:00.000Z` : `${date}T23:59:59.999Z`;
    }

    return assertIsoInstant(value, field);
  } catch (error) {
    throw new ApiBadRequestError(errorMessage(error));
  }
}

function parseHealthMetricQueryLimit(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new ApiBadRequestError("Health metric query parameter limit must be a positive safe integer string.");
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new ApiBadRequestError("Health metric query parameter limit must be a positive safe integer string.");
  }

  return limit;
}

function adapterIdFromPath(path: string): string | undefined {
  try {
    const url = new URL(path, "https://knowledge-loop.local");
    const adapterId = url.searchParams.get("adapter");

    return adapterId === null || adapterId.length === 0 ? undefined : adapterId;
  } catch {
    return undefined;
  }
}

function parseRequestPath(path: string): URL {
  try {
    return new URL(path, "https://knowledge-loop.local");
  } catch {
    throw new ApiBadRequestError("Request path must be a valid API path.");
  }
}

function reviewDueRouteForMalformedQuery(request: ApiRequest) {
  if (request.method !== "GET") {
    return undefined;
  }

  const url = parseMalformedRoutePath(request.path);
  if (url?.pathname !== "/api/review/due") {
    return undefined;
  }

  return API_ROUTE_MANIFEST.find((route) => route.id === "review.due");
}

function parseMalformedRoutePath(path: string): URL | undefined {
  try {
    return new URL(path, "https://knowledge-loop.local");
  } catch {
    return undefined;
  }
}

function currentDate(context: ApiHandlerContext): string {
  return nowDate(context).toISOString().slice(0, 10);
}

function nowDate(context: ApiHandlerContext): Date {
  if (typeof context.now === "function") {
    return context.now();
  }

  return context.now ?? new Date();
}

function stableSedentarySpan(span: StoredSedentarySpan): SedentarySpanResponse {
  return {
    id: span.id,
    ...(span.sourceId === undefined ? {} : { sourceId: span.sourceId }),
    spanStart: span.spanStart,
    spanEnd: span.spanEnd,
    state: span.state,
    ...(span.confidence === undefined ? {} : { confidence: span.confidence }),
    receivedAt: span.receivedAt
  };
}

function coachDigestPublishFunction(context: ApiHandlerContext): CoachDigestBoardPublish | undefined {
  if (context.coachDigestPublisher !== undefined) {
    return context.coachDigestPublisher;
  }

  if (context.boardClient === undefined) {
    return undefined;
  }
  const boardClient = context.boardClient;

  return (action) => boardClient.publish(coachDigestBoardAction(action));
}

function coachDigestBoardAction(action: CoachDigestPublishAction): AgentIntendedAction {
  return {
    target: "multica",
    type: "add_comment",
    title: `Coach health digest for ${action.date}`,
    body: action.renderedMarkdown,
    checklist: [],
    sourceEndpoints: ["POST /api/health/coach-digest/publish"]
  };
}

function missingCoachDigestPublisher(): never {
  throw new Error("Coach digest publisher is not configured.");
}

function apiCoachDigestPublishResult(result: CoachDigestPublishResult): ApiCoachDigestPublishResult {
  if (result.status === "dry_run") {
    return {
      snapshotId: result.snapshotId,
      status: "dry_run",
      intendedAction: coachDigestBoardAction(result.intendedAction)
    };
  }

  if (result.status === "blocked") {
    return {
      snapshotId: result.snapshotId,
      status: "blocked",
      reason: redactApiBoundaryMessage(result.reason)
    };
  }

  return result;
}

function redactApiBoundaryMessage(message: string): string {
  return message
    .replace(
      /\b(authorization\s*[:=]\s*)(bearer\s+)?[^\s;,]+/giu,
      (_match, prefix: string, bearer: string | undefined) => `${prefix}${bearer ?? ""}REDACTED`
    )
    .replace(/\b(cookie\s*[:=]\s*)[^\r\n]*/giu, "$1REDACTED")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|auth|session|sid|password)\s*[:=]\s*)[^\s;,)&]+/giu,
      "$1REDACTED"
    )
    .replace(/(https?:\/\/)[^\s/@]+@[^\s;,)]*/giu, (url) => redactUrlCredentialsAndSensitiveQuery(url))
    .replace(
      /([?&][^=\s&]*(?:token|key|secret|authorization|auth|cookie|session|sid|password)[^=\s&]*=)[^\s&;,)]*/giu,
      "$1REDACTED"
    )
    .replace(/\\\\(?:\?\\[A-Z]:[\\/][^\s;,)]*|[^\\/\s;,)]+[\\/][^\s;,)]*)/giu, "PATH_REDACTED")
    .replace(/\b[A-Z]:[\\/][^\s;,)]*/giu, "PATH_REDACTED")
    .replace(/\bfile:\/\/\/?[^\s;,)]*/giu, "PATH_REDACTED");
}

function redactUrlCredentialsAndSensitiveQuery(value: string): string {
  try {
    const url = new URL(value);
    if (url.username.length > 0) {
      url.username = "REDACTED";
    }
    if (url.password.length > 0) {
      url.password = "";
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (/(?:token|key|secret|authorization|auth|cookie|session|sid|password)/iu.test(key)) {
        url.searchParams.set(key, "REDACTED");
      }
    }
    return url.toString();
  } catch {
    return "URL_REDACTED";
  }
}

function successResponse(routeId: ApiRouteId, data: Record<string, unknown>): ApiResponse<ApiHandlerResponseBody> {
  return {
    status: 200,
    body: {
      ok: true,
      routeId,
      data
    }
  };
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  routeId?: ApiRouteId
): ApiResponse<ApiHandlerResponseBody> {
  return {
    status,
    body: {
      ok: false,
      error: {
        code,
        message,
        ...(routeId === undefined ? {} : { routeId })
      }
    }
  };
}

function unexpectedError(routeId: ApiRouteId): ApiResponse<ApiHandlerResponseBody> {
  return errorResponse(500, "unexpected_error", "Unexpected API handler error.", routeId);
}

function isRouteInputError(routeId: ApiRouteId, error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  switch (routeId) {
    case "quiz.grade":
      return isQuizInputError(error.message);
    case "teachback.submit":
      return isTeachbackInputError(error.message);
    case "application.task.create":
      return isApplicationTaskInputError(error.message);
    case "application.grade":
      return isApplicationGradeInputError(error.message);
    case "review.due":
      return isReviewDueInputError(error.message);
    case "review.attempt":
      return isReviewAttemptInputError(error.message);
    case "health.metrics.create":
    case "health.metrics.list":
    case "health.metrics.update":
    case "health.metrics.import":
      return isHealthMetricInputError(error.message);
    case "health.exercise.templates.create":
    case "health.exercise.plans.create":
    case "health.exercise.sessions.complete":
    case "health.exercise.completion":
      return isExerciseInputError(error.message);
    case "health.sedentary.spans.ingest":
    case "health.sedentary.summary":
    case "health.break-reminders.evaluate":
      return isSedentaryInputError(error.message);
    case "health.coach-digest.generate":
    case "health.coach-digest.publish":
      return isHealthCoachDigestInputError(error.message);
    default:
      return false;
  }
}

function isQuizInputError(message: string): boolean {
  return (
    /^Concept [^\s]+ was not found\.$/.test(message) ||
    message === "Persistent quiz grading requires a statement." ||
    message === "Persistent quiz difficulty must be an integer between 1 and 5." ||
    message === "Exact-match grading requires at least one answer." ||
    message === "Exact-match grading requires string answers." ||
    message === "Exact-match grading requires each answer to be a non-empty answer."
  );
}

function isTeachbackInputError(message: string): boolean {
  return (
    /^Concept [^\s]+ was not found\.$/.test(message) ||
    /^No page was found for concept [^\s]+\.$/.test(message) ||
    message === "Persistent teach-back grading requires a non-empty transcript." ||
    message === "Persistent teach-back grading requires a non-empty concept slug."
  );
}

function isApplicationTaskInputError(message: string): boolean {
  return (
    /^Concept [^\s]+ was not found\.$/.test(message) ||
    /^No page was found for concept [^\s]+\.$/.test(message) ||
    /^Page \d+ has no extractable application rubric keywords\.$/.test(message) ||
    message === "Persistent application task requires a non-empty concept slug." ||
    message === "Persistent application difficulty must be an integer between 1 and 5."
  );
}

function isApplicationGradeInputError(message: string): boolean {
  return (
    /^Item \d+ was not found\.$/.test(message) ||
    /^Item \d+ is not a free-form application item\.$/.test(message) ||
    /^Item \d+ does not contain a valid application rubric\.$/.test(message) ||
    message === "Persistent application grading requires a positive item id." ||
    message === "Persistent application grading requires a non-empty response."
  );
}

function isReviewDueInputError(message: string): boolean {
  return /^Invalid review target/.test(message) || message === "limit must be a positive safe integer";
}

function isReviewAttemptInputError(message: string): boolean {
  return (
    isConceptNotFoundMessage(message) ||
    isReviewScheduleMissingMessage(message) ||
    message === "Persistent review attempt requires a non-empty conceptSlug." ||
    message === "Persistent review rating must be one of again, hard, good, or easy." ||
    message === "Persistent review attempt requires reviewedAt." ||
    /^Invalid reviewedAt/.test(message)
  );
}

function isHealthMetricInputError(message: string): boolean {
  return (
    message === "health metric not found" ||
    message === "metric update must change at least one field" ||
    message === "csvText is required" ||
    message === "csvText must be text" ||
    message === "CSV must include a header row" ||
    message === "CSV quoted field must end before delimiter" ||
    message === "CSV quote must start a quoted field" ||
    message === "CSV quoted field is not closed" ||
    message === "source must be manual, csv, or mock" ||
    message === "acceptedCount and rejectedCount must total rowCount" ||
    /^CSV is missing .+ column$/.test(message) ||
    /^(metricKey|metricLabel|unit|observedAt|note|now|reason|sourceFilename|importedAt|contentHash) /.test(message) ||
    /^(value|id|metricId|rowCount|acceptedCount|rejectedCount) /.test(message)
  );
}

function isExerciseInputError(message: string): boolean {
  return (
    message === "exercise template not found" ||
    message === "active exercise plan already exists for weekStart" ||
    message === "exercise session not found" ||
    message === "planned exercise session not found" ||
    message === "sessionId must reference a planned exercise session" ||
    message === "completedAt cannot be before scheduledFor" ||
    message === "completion target must be sessionId, planId with templateSessionKey, or omitted" ||
    message === "weekStart must be a Monday" ||
    message === "defaultDays must include at least one day" ||
    message === "defaultDays sessionKey values must be unique" ||
    message === "defaultDays targetMinutes or targetReps is required" ||
    message === "to must be after from" ||
    /^(slug|name|description|templateSlug|weekStart|completedAt|durationMinutes|sessionId|planId|templateSessionKey|targetMinutes|targetReps|dayOffset|title|note|from|to) /.test(
      message
    ) ||
    /^defaultDays /.test(message)
  );
}

function isSedentaryInputError(message: string): boolean {
  return (
    message === "spanEnd must be after spanStart" ||
    message === "state must be active, idle, or unknown" ||
    message === "to must be after from" ||
    /^(sourceId|spanStart|spanEnd|receivedAt|from|to|evaluatedAt|deliveryChannel) /.test(message) ||
    /^(confidence|thresholdMinutes|cooldownMinutes|activeBreakMinutes) must /.test(message)
  );
}

function isHealthCoachDigestInputError(message: string): boolean {
  return (
    message === "date must be an ISO date" ||
    message === "now must be an ISO instant" ||
    message === "coach digest snapshot not found"
  );
}

function isConceptNotFoundMessage(message: string): boolean {
  return message.startsWith("Concept ") && message.endsWith(" was not found.");
}

function isReviewScheduleMissingMessage(message: string): boolean {
  return message.startsWith("Review schedule for concept ") && message.endsWith(" does not exist.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
