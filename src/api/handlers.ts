import type Database from "better-sqlite3";

import {
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
import { diagnosePersistentWeakSpots } from "../engine/persistent-diagnose.js";
import { runPersistentMockIngest } from "../engine/persistent-ingest.js";
import { createPersistentDailyPlan } from "../engine/persistent-plan.js";
import { gradePersistentExactQuizAttempt } from "../engine/persistent-quiz.js";
import { gradePersistentTeachback } from "../engine/persistent-teachback.js";
import type { SourceAdapter } from "../engine/source-adapter.js";
import type { TraceEvent } from "../engine/trace.js";

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
  const route = findApiRoute(request.method, request.path);
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
        return errorResponse(
          501,
          "not_implemented",
          "Forced study plan regeneration is not implemented yet.",
          "plan.generate"
        );
      case "mastery.summary":
        return handleMasterySummary(context);
      case "quiz.grade":
        return handleQuizGrade(request, context);
      case "teachback.submit":
        return handleTeachback(request, context);
      case "wiki.pages":
        return successResponse("wiki.pages", { pages: listPublicPages(context.db) });
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

function adapterIdFromPath(path: string): string | undefined {
  try {
    const url = new URL(path, "https://knowledge-loop.local");
    const adapterId = url.searchParams.get("adapter");

    return adapterId === null || adapterId.length === 0 ? undefined : adapterId;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
