#!/usr/bin/env -S tsx
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  agentDayInputFromConfig,
  agentInputFromConfig,
  loadAgentRuntimeConfig,
  type AgentDryRunDefaults,
  type AgentRuntimeConfig
} from "../agents/config.js";
import {
  createAgentDayDryRunPlan,
  createAgentDryRunPlan,
  type AgentDayDryRunPlan,
  type AgentEndpointPlan,
  parseAgentPhase,
  parseAgentRole,
  type AgentDryRunPlan
} from "../agents/dry-run.js";
import { executeAgentDay, type AgentDayRunReport } from "../agents/day-runner.js";
import { createFetchAgentReadClient, createHttpBoardClient, type AgentFetch } from "../agents/http-clients.js";
import {
  createAgentScheduleReport,
  createAgentScheduleTiming,
  type AgentScheduleDryRunReport,
  type AgentScheduleArgvOptions,
  type AgentScheduleTiming
} from "../agents/schedule.js";
import { validateLiveSmokeManifest, type LiveSmokeManifestValidationResult } from "../agents/live-smoke-manifest.js";
import {
  BOARD_PUBLISH_CONFIG_LIVE_CLIENT_WARNING,
  validateBoardPublishConfig,
  type BoardPublishConfigValidationResult
} from "../agents/board-publish-config.js";
import {
  BOARD_DAY_EVIDENCE_OFFLINE_WARNING,
  validateBoardDayEvidence,
  type BoardDayEvidenceValidationResult
} from "../agents/board-day-evidence.js";
import {
  createAgentFailureSmokeReport,
  type AgentFailureSmokeEndpointSelector,
  type AgentFailureSmokeReport
} from "../agents/failure-smoke.js";
import {
  inspectPiHarnessRuntimeImport,
  validatePiHarnessDependency,
  type PiHarnessDependencyReport,
  type PiHarnessModuleImporter
} from "../agents/pi-harness-dependency.js";
import { MarkdownVaultAdapter } from "../adapters/markdown-vault.js";
import { applyMigrations } from "../db/migrations.js";
import { listTraceEvents, persistTraceEvents, type StoredTraceEvent } from "../db/trace-store.js";
import {
  diagnosePersistentWeakSpots,
  type PersistentDiagnoseResult
} from "../engine/persistent-diagnose.js";
import {
  createPersistentApplicationTask,
  gradePersistentApplicationAttempt,
  type PersistentApplicationGradeResult,
  type PersistentApplicationTaskResult
} from "../engine/persistent-application.js";
import { createRunId, TRACE_STAGES, type TraceEvent, type TraceStage } from "../engine/trace.js";
import {
  createDailyPlan,
  gradeQuizAttempt,
  runMockIngest,
  type DailyPlan,
  type MockIngestResult,
  type PlanConceptInput,
  type QuizGradeResult
} from "../engine/mock-commands.js";
import {
  runPersistentMockIngest,
  type PersistentMockIngestSummary
} from "../engine/persistent-ingest.js";
import { createPersistentDailyPlan, type PersistentDailyPlan } from "../engine/persistent-plan.js";
import {
  gradePersistentExactQuizAttempt,
  type PersistentQuizGradeResult
} from "../engine/persistent-quiz.js";
import {
  listDuePersistentReviews,
  recordPersistentReviewAttempt,
  type PersistentReviewAttemptResult,
  type PersistentReviewRating,
  type PersistentReviewRecord
} from "../engine/persistent-review.js";
import {
  gradePersistentTeachback,
  type PersistentTeachbackGradeResult
} from "../engine/persistent-teachback.js";
import {
  createHealthMetric,
  importHealthMetricsCsv,
  queryHealthMetrics,
  updateHealthMetric
} from "../health-extensions/metrics.js";
import {
  assertSafeText,
  normalizeHealthMetricInput,
  normalizeMetricKey,
  type ExerciseIntensity,
  type SedentaryState,
  type StoredSedentarySpan
} from "../health-extensions/schema.js";
import {
  completeExerciseSession,
  createExercisePlanFromTemplate,
  createExerciseTemplate,
  queryExerciseCompletion,
  type ExerciseCompletionSummary,
  type ExercisePlanResult,
  type ExerciseSessionCompletionResult,
  type ExerciseTemplateDayInput,
  type ExerciseTemplateResult
} from "../health-extensions/exercise.js";
import {
  computeSedentarySummary,
  evaluateBreakReminders,
  ingestSedentarySpan,
  type BreakReminderEvaluationResult,
  type SedentarySummary
} from "../health-extensions/sedentary.js";

export interface WritableSink {
  write(chunk: string | Uint8Array): unknown;
}

export interface KlHandlerIO {
  stdout?: WritableSink;
  stderr?: WritableSink;
  fetch?: AgentFetch;
  env?: Readonly<Record<string, string | undefined>>;
  execFile?: (file: string, args: readonly string[]) => string;
  importModule?: PiHarnessModuleImporter;
  fileSystem?: {
    readJson(filePath: string): unknown;
    isFile(filePath: string): boolean;
  };
}

export interface KlMockIngestCommandResult {
  command: "ingest";
  mode: "mock";
  result: MockIngestResult;
}

export interface KlPersistentIngestCommandResult {
  command: "ingest";
  mode: "mock-persistent";
  result: PersistentMockIngestSummary;
}

export type KlIngestCommandResult = KlMockIngestCommandResult | KlPersistentIngestCommandResult;

export interface KlMockPlanCommandResult {
  command: "plan";
  mode: "mock";
  result: DailyPlan;
}

export interface KlPersistentPlanCommandResult {
  command: "plan";
  mode: "mock-persistent";
  result: PersistentDailyPlan;
}

export type KlPlanCommandResult = KlMockPlanCommandResult | KlPersistentPlanCommandResult;

export interface KlMockQuizCommandResult {
  command: "quiz";
  mode: "mock";
  result: QuizGradeResult;
}

export interface KlPersistentQuizCommandResult {
  command: "quiz";
  mode: "mock-persistent";
  result: PersistentQuizGradeResult;
}

export type KlQuizCommandResult = KlMockQuizCommandResult | KlPersistentQuizCommandResult;

export interface KlPersistentTeachbackCommandResult {
  command: "teachback";
  mode: "mock-persistent";
  result: PersistentTeachbackGradeResult;
}

export type KlTeachbackCommandResult = KlPersistentTeachbackCommandResult;

export interface KlPersistentApplicationCommandResult {
  command: "application";
  mode: "mock-persistent";
  result: PersistentApplicationTaskResult | PersistentApplicationGradeResult;
}

export type KlApplicationCommandResult = KlPersistentApplicationCommandResult;

export interface KlPersistentDiagnoseCommandResult {
  command: "diagnose";
  mode: "mock-persistent";
  result: PersistentDiagnoseResult;
}

export type KlDiagnoseCommandResult = KlPersistentDiagnoseCommandResult;

export interface KlPersistentReviewDueListResult {
  target: string;
  reviews: PersistentReviewRecord[];
}

export interface KlPersistentReviewCommandResult {
  command: "review";
  mode: "mock-persistent";
  result: KlPersistentReviewDueListResult | PersistentReviewAttemptResult;
}

export type KlReviewCommandResult = KlPersistentReviewCommandResult;

export interface KlPersistentTraceResult {
  runId: string;
  stage?: TraceStage;
  eventCount: number;
  events: StoredTraceEvent[];
}

export interface KlPersistentTraceCommandResult {
  command: "trace";
  mode: "mock-persistent";
  result: KlPersistentTraceResult;
}

export type KlTraceCommandResult = KlPersistentTraceCommandResult;

export interface KlHealthMetricCommandResult {
  readonly command: "health-metric";
  readonly mode: "mock-persistent";
  readonly action: "add" | "list" | "update" | "import-csv";
  readonly result: unknown;
}

export interface KlHealthExerciseCommandResult {
  readonly command: "health-exercise";
  readonly mode: "mock-persistent";
  readonly action: "template.create" | "plan.create" | "complete" | "completion";
  readonly result:
    | ExerciseTemplateResult
    | ExercisePlanResult
    | ExerciseSessionCompletionResult
    | ExerciseCompletionSummary;
}

export interface KlHealthSedentaryCommandResult {
  readonly command: "health-sedentary";
  readonly mode: "mock-persistent";
  readonly action: "ingest-span" | "summary";
  readonly result: StoredSedentarySpan | SedentarySummary;
}

export interface KlHealthBreakReminderCommandResult {
  readonly command: "health-break-reminder";
  readonly mode: "mock-persistent";
  readonly action: "evaluate";
  readonly result: BreakReminderEvaluationResult;
}

export interface KlAgentDryRunCommandResult {
  command: "agent";
  mode: "dry-run";
  result: AgentDryRunPlan;
}

export type KlAgentCommandResult = KlAgentDryRunCommandResult;

export interface KlAgentDayDryRunCommandResult {
  command: "agent-day";
  mode: "dry-run";
  result: AgentDayDryRunPlan;
}

export interface KlAgentDayLiveCommandResult {
  command: "agent-day";
  mode: "live";
  result: AgentDayRunReport;
}

export type KlAgentDayCommandResult = KlAgentDayDryRunCommandResult | KlAgentDayLiveCommandResult;

export interface KlAgentScheduleDryRunCommandResult {
  command: "agent-schedule";
  mode: "dry-run";
  result: AgentScheduleDryRunReport;
}

export interface KlAgentScheduleLiveSkippedResult {
  readonly status: "skipped";
  readonly reason: "not_due";
  readonly schedule: AgentScheduleTiming;
}

export interface KlAgentScheduleLiveExecutedResult {
  readonly status: AgentDayRunReport["status"];
  readonly schedule: AgentScheduleTiming;
  readonly dayRunReport: AgentDayRunReport;
}

export type KlAgentScheduleLiveResult = KlAgentScheduleLiveSkippedResult | KlAgentScheduleLiveExecutedResult;

export interface KlAgentScheduleLiveCommandResult {
  command: "agent-schedule";
  mode: "live";
  result: KlAgentScheduleLiveResult;
}

export type KlAgentScheduleCommandResult = KlAgentScheduleDryRunCommandResult | KlAgentScheduleLiveCommandResult;

export interface KlAgentLiveSmokeDryRunResult {
  readonly manifestPath: string;
  readonly date: string;
  readonly valid: boolean;
  readonly validation: LiveSmokeManifestValidationResult;
  readonly nonCompletionNotice: string;
  readonly plan: AgentDayDryRunPlan;
}

export interface KlAgentLiveSmokeDryRunCommandResult {
  command: "agent-live-smoke";
  mode: "dry-run";
  result: KlAgentLiveSmokeDryRunResult;
}

export type KlAgentLiveSmokeCommandResult = KlAgentLiveSmokeDryRunCommandResult;

type KlAgentPreflightStatus = "ready_for_live_smoke" | "blocked";
type KlAgentPreflightCheckStatus = "passed" | "blocked";
type KlAgentPreflightLiveProofStatus = "not_verified_offline";

export interface KlAgentPreflightOfflineCheck {
  readonly id:
    | "scheduler_due"
    | "live_smoke_manifest_valid"
    | "manifest_starts_on_schedule_date"
    | "board_publish_config_valid";
  readonly status: KlAgentPreflightCheckStatus;
  readonly detail: string;
}

export interface KlAgentPreflightRequiredLiveProof {
  readonly id:
    | "multica_self_host_verified"
    | "pi_harness_dependency_clean"
    | "two_consecutive_hands_free_board_days"
    | "failure_blocker_board_comment"
    | "evening_mastery_delta_matches_api"
    | "daily_cost_visible";
  readonly status: KlAgentPreflightLiveProofStatus;
  readonly detail: string;
}

export interface KlAgentPreflightDryRunResult {
  readonly date: string;
  readonly status: KlAgentPreflightStatus;
  readonly nonCompletionNotice: string;
  readonly offlineChecks: readonly KlAgentPreflightOfflineCheck[];
  readonly requiredLiveProofs: readonly KlAgentPreflightRequiredLiveProof[];
  readonly schedule: AgentScheduleDryRunReport;
  readonly liveSmoke: {
    readonly manifestPath: string;
    readonly valid: boolean;
    readonly manifestEvidenceDays: readonly string[];
    readonly validation: LiveSmokeManifestValidationResult;
  };
  readonly boardConfig: {
    readonly configPath: string;
    readonly valid: boolean;
    readonly validation: BoardPublishConfigValidationResult;
  };
}

export interface KlAgentPreflightDryRunCommandResult {
  command: "agent-preflight";
  mode: "dry-run";
  result: KlAgentPreflightDryRunResult;
}

export type KlAgentPreflightCommandResult = KlAgentPreflightDryRunCommandResult;

export interface KlAgentBoardConfigDryRunResult {
  readonly configPath: string;
  readonly valid: boolean;
  readonly validation: BoardPublishConfigValidationResult;
  readonly nonCompletionNotice: string;
}

export interface KlAgentBoardConfigDryRunCommandResult {
  command: "agent-board-config";
  mode: "dry-run";
  result: KlAgentBoardConfigDryRunResult;
}

export type KlAgentBoardConfigCommandResult = KlAgentBoardConfigDryRunCommandResult;

type KlAgentBoardEvidenceStatus = "observed_evidence_valid" | "blocked";

export interface KlAgentBoardEvidenceDryRunResult {
  readonly evidencePath: string;
  readonly manifestPath: string;
  readonly status: KlAgentBoardEvidenceStatus;
  readonly valid: boolean;
  readonly validation: BoardDayEvidenceValidationResult;
  readonly nonCompletionNotice: string;
}

export interface KlAgentBoardEvidenceDryRunCommandResult {
  command: "agent-board-evidence";
  mode: "dry-run";
  result: KlAgentBoardEvidenceDryRunResult;
}

export type KlAgentBoardEvidenceCommandResult = KlAgentBoardEvidenceDryRunCommandResult;

export interface KlAgentFailureSmokeDryRunCommandResult {
  command: "agent-failure-smoke";
  mode: "dry-run";
  result: AgentFailureSmokeReport;
}

export type KlAgentFailureSmokeCommandResult = KlAgentFailureSmokeDryRunCommandResult;

export interface KlAgentHarnessDependencyDryRunResult extends PiHarnessDependencyReport {
  readonly harnessPath: string;
}

export interface KlAgentHarnessDependencyDryRunCommandResult {
  command: "agent-harness-dependency";
  mode: "dry-run";
  result: KlAgentHarnessDependencyDryRunResult;
}

export type KlAgentHarnessDependencyCommandResult = KlAgentHarnessDependencyDryRunCommandResult;

export type KlCommandResult =
  | KlIngestCommandResult
  | KlPlanCommandResult
  | KlQuizCommandResult
  | KlTeachbackCommandResult
  | KlApplicationCommandResult
  | KlDiagnoseCommandResult
  | KlReviewCommandResult
  | KlTraceCommandResult
  | KlHealthMetricCommandResult
  | KlHealthExerciseCommandResult
  | KlHealthSedentaryCommandResult
  | KlHealthBreakReminderCommandResult
  | KlAgentCommandResult
  | KlAgentDayCommandResult
  | KlAgentScheduleCommandResult
  | KlAgentLiveSmokeCommandResult
  | KlAgentPreflightCommandResult
  | KlAgentBoardConfigCommandResult
  | KlAgentBoardEvidenceCommandResult
  | KlAgentFailureSmokeCommandResult
  | KlAgentHarnessDependencyCommandResult;

class UsageError extends Error {
  readonly exitCode = 2;
}

export async function runKlCommand(argv: readonly string[], io: KlHandlerIO = {}): Promise<KlCommandResult> {
  const [command, ...args] = argv;

  if (command === "ingest") {
    return runIngestCommand(args);
  }

  if (command === "plan") {
    return runPlanCommand(args);
  }

  if (command === "quiz") {
    return runQuizCommand(args);
  }

  if (command === "teachback") {
    return runTeachbackCommand(args);
  }

  if (command === "diagnose") {
    return runDiagnoseCommand(args);
  }

  if (command === "trace") {
    return runTraceCommand(args);
  }

  if (command === "health-metric") {
    return runHealthMetricCommand(args);
  }

  if (command === "health-exercise") {
    return runHealthExerciseCommand(args);
  }

  if (command === "health-sedentary") {
    return runHealthSedentaryCommand(args);
  }

  if (command === "health-break-reminder") {
    return runHealthBreakReminderCommand(args);
  }

  if (command === "application") {
    return runApplicationCommand(args);
  }

  if (command === "review") {
    return runReviewCommand(args);
  }

  if (command === "agent") {
    return runAgentCommand(args);
  }

  if (command === "agent-day") {
    return runAgentDayCommand(args, io);
  }

  if (command === "agent-schedule") {
    return runAgentScheduleCommand(args, io);
  }

  if (command === "agent-live-smoke") {
    return runAgentLiveSmokeCommand(args);
  }

  if (command === "agent-preflight") {
    return runAgentPreflightCommand(args);
  }

  if (command === "agent-board-config") {
    return runAgentBoardConfigCommand(args);
  }

  if (command === "agent-board-evidence") {
    return runAgentBoardEvidenceCommand(args);
  }

  if (command === "agent-failure-smoke") {
    return runAgentFailureSmokeCommand(args);
  }

  if (command === "agent-harness-dependency") {
    return runAgentHarnessDependencyCommand(args, io);
  }

  throw new UsageError(
    `Unknown command "${command ?? ""}". Expected one of: ingest, plan, quiz, teachback, diagnose, trace, health-metric, health-exercise, health-sedentary, health-break-reminder, application, review, agent, agent-day, agent-schedule, agent-live-smoke, agent-preflight, agent-board-config, agent-board-evidence, agent-failure-smoke, agent-harness-dependency.`
  );
}

export async function handleKlCommand(argv: readonly string[], io: KlHandlerIO = {}): Promise<KlCommandResult> {
  const result = await runKlCommand(argv, io);
  io.stdout?.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const DEFAULT_LIVE_SMOKE_NON_COMPLETION_NOTICE =
  "This offline validation does not execute Multica, install a scheduler, prove live board posting, or close M2.";
const DEFAULT_PREFLIGHT_NON_COMPLETION_NOTICE =
  "This preflight is offline-only. It does not execute Multica, install a scheduler, prove live board posting, prove two hands-free days, or close M2.";
const DEFAULT_BOARD_PUBLISH_CONFIG_PATH = "config/multica/board-publish.example.json";
const DEFAULT_BOARD_CONFIG_NON_COMPLETION_NOTICE =
  "This board publish config validation is offline-only. It does not call Multica, prove the board contract, prove live posting, or close M2.";
const DEFAULT_BOARD_EVIDENCE_NON_COMPLETION_NOTICE =
  "This board-day evidence validation is offline-only. It does not call Multica, prove hands-free execution, prove live posting, or close M2.";
const M2_REQUIRED_LIVE_PROOFS = [
  {
    id: "multica_self_host_verified",
    status: "not_verified_offline",
    detail: "Verify a running Multica self-host instance from its unmodified repository."
  },
  {
    id: "pi_harness_dependency_clean",
    status: "not_verified_offline",
    detail: "Verify pi-harness is consumed externally and its checkout stays clean."
  },
  {
    id: "two_consecutive_hands_free_board_days",
    status: "not_verified_offline",
    detail: "Capture two consecutive board days produced by agents without manual prompting."
  },
  {
    id: "failure_blocker_board_comment",
    status: "not_verified_offline",
    detail: "Kill the knowledge-loop API mid-run and capture the visible Multica blocker."
  },
  {
    id: "evening_mastery_delta_matches_api",
    status: "not_verified_offline",
    detail: "Compare the evening Scholar board post with GET /api/mastery/summary."
  },
  {
    id: "daily_cost_visible",
    status: "not_verified_offline",
    detail: "Surface per-agent daily cost in the live report."
  }
] as const satisfies readonly KlAgentPreflightRequiredLiveProof[];

async function runIngestCommand(args: readonly string[]): Promise<KlIngestCommandResult> {
  const options = parseOptions(args, new Set(["--vault", "--db"]), "ingest");
  const vault = requireOne(options, "--vault", "ingest");
  const dbPath = optionalOne(options, "--db", "ingest");
  const adapter = new MarkdownVaultAdapter({
    id: "cli-vault",
    rootDir: vault
  });

  if (dbPath !== undefined) {
    const db = new Database(dbPath);
    try {
      applyMigrations(db);
      const result = await runPersistentMockIngest(db, adapter, { runId: createRunId("persistent-ingest") });
      persistCommandTraceEvents(db, result);
      return {
        command: "ingest",
        mode: "mock-persistent",
        result
      };
    } finally {
      db.close();
    }
  }

  return {
    command: "ingest",
    mode: "mock",
    result: await runMockIngest(adapter)
  };
}

function runPlanCommand(args: readonly string[]): KlPlanCommandResult {
  const options = parseOptions(args, new Set(["--date", "--concept", "--db"]), "plan");
  const date = requireOne(options, "--date", "plan");
  const dbPath = optionalOne(options, "--db", "plan");

  if (dbPath !== undefined) {
    if ((options.get("--concept") ?? []).length > 0) {
      throw new UsageError("Command plan cannot combine --db and --concept.");
    }

    const db = new Database(dbPath);
    try {
      applyMigrations(db);
      const result = createPersistentDailyPlan(db, { date, runId: createRunId("persistent-plan") });
      persistCommandTraceEvents(db, result);
      return {
        command: "plan",
        mode: "mock-persistent",
        result
      };
    } finally {
      db.close();
    }
  }

  const concepts = requireMany(options, "--concept", "plan").map(parseConcept);

  return {
    command: "plan",
    mode: "mock",
    result: createDailyPlan({
      date,
      concepts
    })
  };
}

function runQuizCommand(args: readonly string[]): KlQuizCommandResult {
  const options = parseOptions(args, new Set(["--item", "--concept", "--answer", "--response", "--db"]), "quiz");
  const dbPath = optionalOne(options, "--db", "quiz");
  const itemId = requireOne(options, "--item", "quiz");
  const conceptSlug = requireOne(options, "--concept", "quiz");
  const response = requireOne(options, "--response", "quiz");
  const answers = requireMany(options, "--answer", "quiz");

  if (dbPath !== undefined) {
    const db = new Database(dbPath);
    try {
      applyMigrations(db);
      const result = gradePersistentExactQuizAttempt(db, {
        conceptSlug,
        statement: itemId,
        answers,
        response,
        runId: createRunId("persistent-quiz")
      });
      persistCommandTraceEvents(db, result);
      return {
        command: "quiz",
        mode: "mock-persistent",
        result
      };
    } finally {
      db.close();
    }
  }

  return {
    command: "quiz",
    mode: "mock",
    result: gradeQuizAttempt({
      item: {
        id: itemId,
        conceptSlug,
        answer: answers
      },
      response
    })
  };
}

function runTeachbackCommand(args: readonly string[]): KlTeachbackCommandResult {
  const options = parseOptions(args, new Set(["--db", "--concept", "--transcript"]), "teachback");
  const dbPath = requireOne(options, "--db", "teachback");
  const conceptSlug = requireOne(options, "--concept", "teachback");
  const transcript = requireOne(options, "--transcript", "teachback");
  const db = new Database(dbPath);

  try {
    applyMigrations(db);
    const result = gradePersistentTeachback(db, {
      conceptSlug,
      transcript,
      runId: createRunId("persistent-teachback")
    });
    persistCommandTraceEvents(db, result);
    return {
      command: "teachback",
      mode: "mock-persistent",
      result
    };
  } finally {
    db.close();
  }
}

function runDiagnoseCommand(args: readonly string[]): KlDiagnoseCommandResult {
  const options = parseOptions(args, new Set(["--db", "--threshold", "--limit"]), "diagnose");
  const dbPath = requireOne(options, "--db", "diagnose");
  const thresholdValue = optionalOne(options, "--threshold", "diagnose");
  const limitValue = optionalOne(options, "--limit", "diagnose");
  const masteryThreshold = thresholdValue === undefined ? undefined : parseUnitNumber(thresholdValue, "--threshold");
  const limit = limitValue === undefined ? undefined : parsePositiveSafeInteger(limitValue, "--limit");
  const db = new Database(dbPath, { fileMustExist: true });

  try {
    const result = diagnosePersistentWeakSpots(db, {
      ...(masteryThreshold === undefined ? {} : { masteryThreshold }),
      ...(limit === undefined ? {} : { limit }),
      runId: createRunId("persistent-diagnose")
    });
    persistCommandTraceEvents(db, result);
    return {
      command: "diagnose",
      mode: "mock-persistent",
      result
    };
  } finally {
    db.close();
  }
}

function runTraceCommand(args: readonly string[]): KlTraceCommandResult {
  const options = parseOptions(args, new Set(["--db", "--run", "--stage"]), "trace");
  const dbPath = requireOne(options, "--db", "trace");
  const runId = parseTraceRunId(requireOne(options, "--run", "trace"));
  const stageValue = optionalOne(options, "--stage", "trace");
  const stage = stageValue === undefined ? undefined : parseTraceStage(stageValue);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const query = {
      runId,
      ...(stage === undefined ? {} : { stage })
    };
    const events = listTraceEvents(db, query);

    return {
      command: "trace",
      mode: "mock-persistent",
      result: {
        runId,
        ...(stage === undefined ? {} : { stage }),
        eventCount: events.length,
        events
      }
    };
  } finally {
    db.close();
  }
}

function runHealthMetricCommand(args: readonly string[]): KlHealthMetricCommandResult {
  const [action, ...actionArgs] = args;

  if (action === "add") {
    return runHealthMetricAddCommand(actionArgs);
  }
  if (action === "list") {
    return runHealthMetricListCommand(actionArgs);
  }
  if (action === "update") {
    return runHealthMetricUpdateCommand(actionArgs);
  }
  if (action === "import-csv") {
    return runHealthMetricImportCsvCommand(actionArgs);
  }

  throw new UsageError(
    `Command health-metric requires one action: add, list, update, or import-csv. Received "${action ?? ""}".`
  );
}

function runHealthMetricAddCommand(args: readonly string[]): KlHealthMetricCommandResult {
  const options = parseOptions(
    args,
    new Set(["--db", "--metric", "--label", "--value", "--unit", "--observed-at", "--note", "--now"]),
    "health-metric add"
  );
  const dbPath = requireOne(options, "--db", "health-metric add");
  const metricKey = requireOne(options, "--metric", "health-metric add");
  const metricLabel = requireOne(options, "--label", "health-metric add");
  const value = parseMetricNumber(requireOne(options, "--value", "health-metric add"), "--value");
  const unit = requireOne(options, "--unit", "health-metric add");
  const observedAt = requireOne(options, "--observed-at", "health-metric add");
  const note = optionalOne(options, "--note", "health-metric add");
  const now = optionalOne(options, "--now", "health-metric add");
  const input = normalizeHealthMetricInput({
    metricKey,
    metricLabel,
    value,
    unit,
    observedAt,
    source: "manual",
    ...(note === undefined ? {} : { note })
  });
  const normalizedNow = now === undefined ? undefined : parseCliIsoInstant(now, "--now");
  const db = new Database(dbPath);

  try {
    applyMigrations(db);
    const result = createHealthMetric(
      db,
      input,
      normalizedNow === undefined ? {} : { now: normalizedNow }
    );

    return {
      command: "health-metric",
      mode: "mock-persistent",
      action: "add",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthMetricListCommand(args: readonly string[]): KlHealthMetricCommandResult {
  const options = parseOptions(args, new Set(["--db", "--metric", "--from", "--to"]), "health-metric list");
  const dbPath = requireOne(options, "--db", "health-metric list");
  const metricValue = optionalOne(options, "--metric", "health-metric list");
  const fromValue = optionalOne(options, "--from", "health-metric list");
  const toValue = optionalOne(options, "--to", "health-metric list");
  const metricKey = metricValue === undefined ? undefined : normalizeMetricKey(metricValue);
  const observedFrom =
    fromValue === undefined ? undefined : parseMetricDateBound(fromValue, "--from", "start-of-day");
  const observedTo = toValue === undefined ? undefined : parseMetricDateBound(toValue, "--to", "end-of-day");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const result = queryHealthMetrics(db, {
      ...(metricKey === undefined ? {} : { metricKey }),
      ...(observedFrom === undefined ? {} : { observedFrom }),
      ...(observedTo === undefined ? {} : { observedTo })
    });

    return {
      command: "health-metric",
      mode: "mock-persistent",
      action: "list",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthMetricUpdateCommand(args: readonly string[]): KlHealthMetricCommandResult {
  const options = parseOptions(
    args,
    new Set(["--db", "--id", "--metric", "--label", "--value", "--unit", "--observed-at", "--note", "--reason", "--now"]),
    "health-metric update"
  );
  const dbPath = requireOne(options, "--db", "health-metric update");
  const id = parsePositiveSafeInteger(requireOne(options, "--id", "health-metric update"), "--id");
  const metricKey = optionalOne(options, "--metric", "health-metric update");
  const metricLabel = optionalOne(options, "--label", "health-metric update");
  const valueText = optionalOne(options, "--value", "health-metric update");
  const unit = optionalOne(options, "--unit", "health-metric update");
  const observedAt = optionalOne(options, "--observed-at", "health-metric update");
  const note = optionalOne(options, "--note", "health-metric update");
  const reason = requireOne(options, "--reason", "health-metric update");
  const now = optionalOne(options, "--now", "health-metric update");
  const value = valueText === undefined ? undefined : parseMetricNumber(valueText, "--value");
  const db = new Database(dbPath, { fileMustExist: true });

  try {
    const result = updateHealthMetric(db, {
      id,
      changes: {
        ...(metricKey === undefined ? {} : { metricKey }),
        ...(metricLabel === undefined ? {} : { metricLabel }),
        ...(value === undefined ? {} : { value }),
        ...(unit === undefined ? {} : { unit }),
        ...(observedAt === undefined ? {} : { observedAt }),
        ...(note === undefined ? {} : { note })
      },
      changedBy: "cli",
      reason,
      ...(now === undefined ? {} : { now })
    });

    return {
      command: "health-metric",
      mode: "mock-persistent",
      action: "update",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthMetricImportCsvCommand(args: readonly string[]): KlHealthMetricCommandResult {
  const options = parseOptions(args, new Set(["--db", "--file", "--imported-at"]), "health-metric import-csv");
  const dbPath = requireOne(options, "--db", "health-metric import-csv");
  const filePath = requireOne(options, "--file", "health-metric import-csv");
  const importedAt = optionalOne(options, "--imported-at", "health-metric import-csv");
  const { csvText, sourceFilename } = readHealthMetricCsvFile(filePath);
  const db = new Database(dbPath, { fileMustExist: true });

  try {
    const result = importHealthMetricsCsv(db, {
      sourceFilename,
      csvText,
      ...(importedAt === undefined ? {} : { importedAt })
    });

    return {
      command: "health-metric",
      mode: "mock-persistent",
      action: "import-csv",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthExerciseCommand(args: readonly string[]): KlHealthExerciseCommandResult {
  const [action, subAction] = args;

  if (action === "template" && subAction === "create") {
    return runHealthExerciseTemplateCreateCommand(args.slice(2));
  }
  if (action === "plan" && subAction === "create") {
    return runHealthExercisePlanCreateCommand(args.slice(2));
  }
  if (action === "complete") {
    return runHealthExerciseCompleteCommand(args.slice(1));
  }
  if (action === "completion") {
    return runHealthExerciseCompletionCommand(args.slice(1));
  }

  throw new UsageError(
    `Command health-exercise requires one action: template create, plan create, complete, or completion. Received "${args.join(" ")}".`
  );
}

function runHealthExerciseTemplateCreateCommand(args: readonly string[]): KlHealthExerciseCommandResult {
  const options = parseOptions(
    args,
    new Set(["--db", "--slug", "--name", "--day"]),
    "health-exercise template create"
  );
  const dbPath = requireOne(options, "--db", "health-exercise template create");
  const slug = assertSafeText(requireOne(options, "--slug", "health-exercise template create"), "slug");
  const name = assertSafeText(requireOne(options, "--name", "health-exercise template create"), "name");
  const defaultDays = requireMany(options, "--day", "health-exercise template create").map(parseExerciseDayOption);
  const db = new Database(dbPath);

  try {
    applyMigrations(db);
    const result = createExerciseTemplate(db, { slug, name, defaultDays });
    return {
      command: "health-exercise",
      mode: "mock-persistent",
      action: "template.create",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthExercisePlanCreateCommand(args: readonly string[]): KlHealthExerciseCommandResult {
  const options = parseOptions(
    args,
    new Set(["--db", "--template", "--week-start"]),
    "health-exercise plan create"
  );
  const dbPath = requireOne(options, "--db", "health-exercise plan create");
  const templateSlug = assertSafeText(
    requireOne(options, "--template", "health-exercise plan create"),
    "templateSlug"
  );
  const weekStart = parseCliMondayIsoDate(
    requireOne(options, "--week-start", "health-exercise plan create"),
    "--week-start"
  );
  const db = openExistingHealthExerciseDatabase(dbPath);

  try {
    const result = createExercisePlanFromTemplate(db, { templateSlug, weekStart });
    return {
      command: "health-exercise",
      mode: "mock-persistent",
      action: "plan.create",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthExerciseCompleteCommand(args: readonly string[]): KlHealthExerciseCommandResult {
  const options = parseOptions(
    args,
    new Set([
      "--db",
      "--session-id",
      "--plan-id",
      "--template-session-key",
      "--completed-at",
      "--duration-minutes",
      "--intensity"
    ]),
    "health-exercise complete"
  );
  const dbPath = requireOne(options, "--db", "health-exercise complete");
  const sessionIdValue = optionalOne(options, "--session-id", "health-exercise complete");
  const planIdValue = optionalOne(options, "--plan-id", "health-exercise complete");
  const templateSessionKeyValue = optionalOne(options, "--template-session-key", "health-exercise complete");
  const completedAt = parseCliIsoInstant(
    requireOne(options, "--completed-at", "health-exercise complete"),
    "--completed-at"
  );
  const durationValue = optionalOne(options, "--duration-minutes", "health-exercise complete");
  const intensityValue = optionalOne(options, "--intensity", "health-exercise complete");
  const sessionId =
    sessionIdValue === undefined ? undefined : parsePositiveSafeInteger(sessionIdValue, "--session-id");
  const planId = planIdValue === undefined ? undefined : parsePositiveSafeInteger(planIdValue, "--plan-id");
  const templateSessionKey =
    templateSessionKeyValue === undefined ? undefined : assertSafeText(templateSessionKeyValue, "templateSessionKey");
  const durationMinutes =
    durationValue === undefined ? undefined : parsePositiveSafeInteger(durationValue, "--duration-minutes");
  const intensity = intensityValue === undefined ? undefined : parseExerciseIntensity(intensityValue);
  assertHealthExerciseCompletionTargetMode(sessionId, planId, templateSessionKey);

  const db = openExistingHealthExerciseDatabase(dbPath);
  try {
    const result = completeExerciseSession(db, {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(planId === undefined ? {} : { planId }),
      ...(templateSessionKey === undefined ? {} : { templateSessionKey }),
      completedAt,
      ...(durationMinutes === undefined ? {} : { durationMinutes }),
      ...(intensity === undefined ? {} : { intensity })
    });
    return {
      command: "health-exercise",
      mode: "mock-persistent",
      action: "complete",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthExerciseCompletionCommand(args: readonly string[]): KlHealthExerciseCommandResult {
  const options = parseOptions(args, new Set(["--db", "--from", "--to"]), "health-exercise completion");
  const dbPath = requireOne(options, "--db", "health-exercise completion");
  const from = parseCliIsoDate(requireOne(options, "--from", "health-exercise completion"), "--from");
  const to = parseCliIsoDate(requireOne(options, "--to", "health-exercise completion"), "--to");
  assertCliDateRange(from, to);
  const db = openExistingHealthExerciseDatabase(dbPath, { readonly: true });

  try {
    const result = queryExerciseCompletion(db, { from, to });
    return {
      command: "health-exercise",
      mode: "mock-persistent",
      action: "completion",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthSedentaryCommand(args: readonly string[]): KlHealthSedentaryCommandResult {
  const [action, ...actionArgs] = args;

  if (action === "ingest-span") {
    return runHealthSedentaryIngestSpanCommand(actionArgs);
  }
  if (action === "summary") {
    return runHealthSedentarySummaryCommand(actionArgs);
  }

  throw new UsageError(
    `Command health-sedentary requires one action: ingest-span or summary. Received "${action ?? ""}".`
  );
}

function runHealthSedentaryIngestSpanCommand(args: readonly string[]): KlHealthSedentaryCommandResult {
  const options = parseOptions(
    args,
    new Set(["--db", "--source-id", "--start", "--end", "--state", "--confidence", "--received-at"]),
    "health-sedentary ingest-span"
  );
  const dbPath = requireOne(options, "--db", "health-sedentary ingest-span");
  const sourceId = assertSafeText(requireOne(options, "--source-id", "health-sedentary ingest-span"), "sourceId");
  const spanStart = parseCliIsoInstant(requireOne(options, "--start", "health-sedentary ingest-span"), "--start");
  const spanEnd = parseCliIsoInstant(requireOne(options, "--end", "health-sedentary ingest-span"), "--end");
  assertCliInstantRange(spanStart, spanEnd, "--end", "--start");
  const state = parseSedentaryState(requireOne(options, "--state", "health-sedentary ingest-span"));
  const confidenceValue = optionalOne(options, "--confidence", "health-sedentary ingest-span");
  const receivedAtValue = optionalOne(options, "--received-at", "health-sedentary ingest-span");
  const confidence = confidenceValue === undefined ? undefined : parseUnitNumber(confidenceValue, "--confidence");
  const receivedAt =
    receivedAtValue === undefined ? undefined : parseCliIsoInstant(receivedAtValue, "--received-at");
  const db = new Database(dbPath);

  try {
    applyMigrations(db);
    const result = ingestSedentarySpan(db, {
      sourceId,
      spanStart,
      spanEnd,
      state,
      ...(confidence === undefined ? {} : { confidence }),
      ...(receivedAt === undefined ? {} : { receivedAt })
    });
    return {
      command: "health-sedentary",
      mode: "mock-persistent",
      action: "ingest-span",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthSedentarySummaryCommand(args: readonly string[]): KlHealthSedentaryCommandResult {
  const options = parseOptions(
    args,
    new Set(["--db", "--from", "--to", "--active-break-minutes", "--merge-unknown-gaps"]),
    "health-sedentary summary"
  );
  const dbPath = requireOne(options, "--db", "health-sedentary summary");
  const from = parseCliIsoInstant(requireOne(options, "--from", "health-sedentary summary"), "--from");
  const to = parseCliIsoInstant(requireOne(options, "--to", "health-sedentary summary"), "--to");
  assertCliInstantRange(from, to, "--to");
  const activeBreakValue = optionalOne(options, "--active-break-minutes", "health-sedentary summary");
  const mergeUnknownValue = optionalOne(options, "--merge-unknown-gaps", "health-sedentary summary");
  const activeBreakMinutes =
    activeBreakValue === undefined ? undefined : parseNonNegativeSafeInteger(activeBreakValue, "--active-break-minutes");
  const mergeUnknownGaps =
    mergeUnknownValue === undefined ? undefined : parseCliBoolean(mergeUnknownValue, "--merge-unknown-gaps");
  const db = openExistingHealthSedentaryDatabase(dbPath, { readonly: true });

  try {
    const result = computeSedentarySummary(db, {
      from,
      to,
      ...(activeBreakMinutes === undefined ? {} : { activeBreakMinutes }),
      ...(mergeUnknownGaps === undefined ? {} : { mergeUnknownGaps })
    });
    return {
      command: "health-sedentary",
      mode: "mock-persistent",
      action: "summary",
      result
    };
  } finally {
    db.close();
  }
}

function runHealthBreakReminderCommand(args: readonly string[]): KlHealthBreakReminderCommandResult {
  const [action, ...actionArgs] = args;
  if (action !== "evaluate") {
    throw new UsageError(`Command health-break-reminder requires action evaluate. Received "${action ?? ""}".`);
  }

  const options = parseOptions(
    actionArgs,
    new Set([
      "--db",
      "--from",
      "--to",
      "--threshold-minutes",
      "--cooldown-minutes",
      "--evaluated-at",
      "--active-break-minutes",
      "--merge-unknown-gaps",
      "--delivery-channel"
    ]),
    "health-break-reminder evaluate"
  );
  const dbPath = requireOne(options, "--db", "health-break-reminder evaluate");
  const from = parseCliIsoInstant(requireOne(options, "--from", "health-break-reminder evaluate"), "--from");
  const to = parseCliIsoInstant(requireOne(options, "--to", "health-break-reminder evaluate"), "--to");
  assertCliInstantRange(from, to, "--to");
  const thresholdValue = optionalOne(options, "--threshold-minutes", "health-break-reminder evaluate");
  const cooldownValue = optionalOne(options, "--cooldown-minutes", "health-break-reminder evaluate");
  const evaluatedAtValue = optionalOne(options, "--evaluated-at", "health-break-reminder evaluate");
  const activeBreakValue = optionalOne(options, "--active-break-minutes", "health-break-reminder evaluate");
  const mergeUnknownValue = optionalOne(options, "--merge-unknown-gaps", "health-break-reminder evaluate");
  const deliveryChannelValue = optionalOne(options, "--delivery-channel", "health-break-reminder evaluate");
  const thresholdMinutes =
    thresholdValue === undefined ? undefined : parsePositiveSafeInteger(thresholdValue, "--threshold-minutes");
  const cooldownMinutes =
    cooldownValue === undefined ? undefined : parseNonNegativeSafeInteger(cooldownValue, "--cooldown-minutes");
  const evaluatedAt =
    evaluatedAtValue === undefined ? undefined : parseCliIsoInstant(evaluatedAtValue, "--evaluated-at");
  const activeBreakMinutes =
    activeBreakValue === undefined ? undefined : parseNonNegativeSafeInteger(activeBreakValue, "--active-break-minutes");
  const mergeUnknownGaps =
    mergeUnknownValue === undefined ? undefined : parseCliBoolean(mergeUnknownValue, "--merge-unknown-gaps");
  const deliveryChannel =
    deliveryChannelValue === undefined ? undefined : assertSafeText(deliveryChannelValue, "deliveryChannel");
  const db = openExistingHealthSedentaryDatabase(dbPath);

  try {
    const result = evaluateBreakReminders(db, {
      from,
      to,
      ...(thresholdMinutes === undefined ? {} : { thresholdMinutes }),
      ...(cooldownMinutes === undefined ? {} : { cooldownMinutes }),
      ...(evaluatedAt === undefined ? {} : { evaluatedAt }),
      ...(activeBreakMinutes === undefined ? {} : { activeBreakMinutes }),
      ...(mergeUnknownGaps === undefined ? {} : { mergeUnknownGaps }),
      ...(deliveryChannel === undefined ? {} : { deliveryChannel })
    });
    return {
      command: "health-break-reminder",
      mode: "mock-persistent",
      action: "evaluate",
      result
    };
  } finally {
    db.close();
  }
}

type ApplicationCliInput =
  | {
      mode: "create";
      dbPath: string;
      conceptSlug: string;
      difficulty?: number;
    }
  | {
      mode: "grade";
      dbPath: string;
      itemId: number;
      response: string;
    };

function runApplicationCommand(args: readonly string[]): KlApplicationCommandResult {
  const options = parseOptions(args, new Set(["--db", "--concept", "--difficulty", "--item", "--response"]), "application");
  const input = parseApplicationInput(options);
  const db = new Database(input.dbPath);

  try {
    applyMigrations(db);
    const result = runPersistentApplication(db, input);
    persistCommandTraceEvents(db, result);
    return {
      command: "application",
      mode: "mock-persistent",
      result
    };
  } finally {
    db.close();
  }
}

function runPersistentApplication(
  db: Database.Database,
  input: ApplicationCliInput
): PersistentApplicationTaskResult | PersistentApplicationGradeResult {
  if (input.mode === "create") {
    return createPersistentApplicationTask(db, {
      conceptSlug: input.conceptSlug,
      ...(input.difficulty === undefined ? {} : { difficulty: input.difficulty }),
      runId: createRunId("persistent-application")
    });
  }

  return gradePersistentApplicationAttempt(db, {
    itemId: input.itemId,
    response: input.response,
    runId: createRunId("persistent-application-attempt")
  });
}

function parseApplicationInput(options: Map<string, string[]>): ApplicationCliInput {
  const dbPath = requireOne(options, "--db", "application");
  const hasCreateOptions = hasOption(options, "--concept") || hasOption(options, "--difficulty");
  const hasGradeOptions = hasOption(options, "--item") || hasOption(options, "--response");

  if (hasCreateOptions && hasGradeOptions) {
    rejectMixedApplicationOptions(options);
  }
  if (hasCreateOptions) {
    return parseApplicationCreateInput(dbPath, options);
  }
  if (hasGradeOptions) {
    return parseApplicationGradeInput(dbPath, options);
  }

  throw new UsageError(
    "Command application requires either create mode (--concept) or grade mode (--item and --response)."
  );
}

function parseApplicationCreateInput(dbPath: string, options: Map<string, string[]>): ApplicationCliInput {
  const difficultyValue = optionalOne(options, "--difficulty", "application");
  const difficulty = difficultyValue === undefined ? undefined : parseApplicationDifficulty(difficultyValue);

  return {
    mode: "create",
    dbPath,
    conceptSlug: requireOne(options, "--concept", "application"),
    ...(difficulty === undefined ? {} : { difficulty })
  };
}

function parseApplicationGradeInput(dbPath: string, options: Map<string, string[]>): ApplicationCliInput {
  const itemValues = options.get("--item") ?? [];
  const responseValues = options.get("--response") ?? [];

  if (itemValues.length !== 1 || responseValues.length !== 1) {
    throw new UsageError("Command application grade mode requires exactly one --item and exactly one --response.");
  }

  return {
    mode: "grade",
    dbPath,
    itemId: parsePositiveSafeInteger(itemValues[0] as string, "--item"),
    response: responseValues[0] as string
  };
}

function rejectMixedApplicationOptions(options: Map<string, string[]>): never {
  if (hasOption(options, "--item") && hasOption(options, "--response")) {
    throw new UsageError("Command application cannot mix grade options with create options.");
  }

  throw new UsageError("Command application cannot mix create options with grade options.");
}

function hasOption(options: Map<string, string[]>, name: string): boolean {
  return (options.get(name) ?? []).length > 0;
}

type ReviewCliInput =
  | {
      mode: "due";
      dbPath: string;
      target: string;
      limit?: number;
    }
  | {
      mode: "attempt";
      dbPath: string;
      conceptSlug: string;
      rating: PersistentReviewRating;
      reviewedAt: string;
    };

function runReviewCommand(args: readonly string[]): KlReviewCommandResult {
  const options = parseOptions(
    args,
    new Set(["--db", "--due", "--limit", "--concept", "--rating", "--reviewed-at"]),
    "review"
  );
  const input = parseReviewInput(options);

  if (input.mode === "due") {
    const db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
    try {
      return {
        command: "review",
        mode: "mock-persistent",
        result: {
          target: input.target,
          reviews: listDuePersistentReviews(db, {
            target: input.target,
            ...(input.limit === undefined ? {} : { limit: input.limit })
          })
        }
      };
    } finally {
      db.close();
    }
  }

  const db = new Database(input.dbPath, { fileMustExist: true });
  try {
    applyMigrations(db);
    const result = recordPersistentReviewAttempt(db, {
      conceptSlug: input.conceptSlug,
      rating: input.rating,
      reviewedAt: input.reviewedAt,
      runId: createRunId("persistent-review")
    });
    persistCommandTraceEvents(db, result);

    return {
      command: "review",
      mode: "mock-persistent",
      result
    };
  } finally {
    db.close();
  }
}

function parseReviewInput(options: Map<string, string[]>): ReviewCliInput {
  const dbPath = requireOne(options, "--db", "review");
  const hasDueOptions = hasOption(options, "--due") || hasOption(options, "--limit");
  const hasAttemptOptions = hasOption(options, "--concept") || hasOption(options, "--rating") || hasOption(options, "--reviewed-at");

  if (hasDueOptions && hasAttemptOptions) {
    throw new UsageError("Command review cannot mix due-list options with attempt options.");
  }
  if (hasDueOptions) {
    return parseReviewDueInput(dbPath, options);
  }
  if (hasAttemptOptions) {
    return parseReviewAttemptInput(dbPath, options);
  }

  throw new UsageError(
    "Command review requires either due-list mode (--due) or attempt mode (--concept, --rating, and --reviewed-at)."
  );
}

function parseReviewDueInput(dbPath: string, options: Map<string, string[]>): ReviewCliInput {
  const target = requireOne(options, "--due", "review due-list mode");
  const limitValue = optionalOne(options, "--limit", "review due-list mode");

  return {
    mode: "due",
    dbPath,
    target,
    ...(limitValue === undefined ? {} : { limit: parsePositiveSafeInteger(limitValue, "--limit") })
  };
}

function parseReviewAttemptInput(dbPath: string, options: Map<string, string[]>): ReviewCliInput {
  const conceptValues = options.get("--concept") ?? [];
  const ratingValues = options.get("--rating") ?? [];
  const reviewedAtValues = options.get("--reviewed-at") ?? [];

  if (conceptValues.length !== 1 || ratingValues.length !== 1 || reviewedAtValues.length !== 1) {
    throw new UsageError(
      "Command review attempt mode requires exactly one --concept, exactly one --rating, and exactly one --reviewed-at."
    );
  }

  return {
    mode: "attempt",
    dbPath,
    conceptSlug: conceptValues[0] as string,
    rating: parseReviewRating(ratingValues[0] as string),
    reviewedAt: reviewedAtValues[0] as string
  };
}

function parseReviewRating(value: string): PersistentReviewRating {
  if (value === "again" || value === "hard" || value === "good" || value === "easy") {
    return value;
  }

  throw new UsageError(`Invalid --rating value "${value}". Expected one of: again, hard, good, easy.`);
}

function runAgentCommand(args: readonly string[]): KlAgentCommandResult {
  const { dryRun, options } = parseAgentOptions(args);
  if (!dryRun) {
    throw new UsageError("Command agent currently supports only --dry-run.");
  }

  const config = loadOptionalAgentConfig(options, "agent");
  const role = parseAgentRole(requireOne(options, "--role", "agent"));
  const phaseValue = optionalOne(options, "--phase", "agent");
  const date = requireOne(options, "--date", "agent");
  const result = createAgentDryRunPlan(agentInputFromConfig({
    config,
    overrides: agentDryRunOverrides(options, "agent"),
    role,
    ...(phaseValue === undefined ? {} : { phase: parseAgentPhase(phaseValue) }),
    date
  }));

  return {
    command: "agent",
    mode: "dry-run",
    result
  };
}

async function runAgentDayCommand(args: readonly string[], io: KlHandlerIO): Promise<KlAgentDayCommandResult> {
  const { dryRun, live, options } = parseAgentDayOptions(args);
  if (dryRun === live) {
    throw new UsageError("Command agent-day requires exactly one of --dry-run or --live.");
  }

  const config = loadOptionalAgentConfig(options, "agent-day");
  const date = requireOne(options, "--date", "agent-day");
  const plan = createAgentDayDryRunPlan(
    agentDayInputFromConfig({
      config,
      overrides: agentDryRunOverrides(options, "agent-day"),
      date
    })
  );

  if (dryRun) {
    return {
      command: "agent-day",
      mode: "dry-run",
      result: plan
    };
  }

  const result = await executeAgentDayLiveFromCli(plan, options, "agent-day", io);

  return {
    command: "agent-day",
    mode: "live",
    result
  };
}

async function executeAgentDayLiveFromCli(
  plan: AgentDayDryRunPlan,
  options: Map<string, string[]>,
  command: "agent-day" | "agent-schedule",
  io: KlHandlerIO
): Promise<AgentDayRunReport> {
  const env = io.env ?? process.env;
  const createTaskEndpointUrl = parseHttpEndpointOption(
    requireOne(options, "--multica-create-task-url", command),
    "--multica-create-task-url"
  );
  const addCommentEndpointUrl = parseHttpEndpointOption(
    requireOne(options, "--multica-add-comment-url", command),
    "--multica-add-comment-url"
  );

  return executeAgentDay(plan, "live", {
    readClient: createFetchAgentReadClient({
      fetch: io.fetch ?? globalThis.fetch,
      bearerToken: optionalEnv(env, "KL_AGENT_READ_BEARER_TOKEN"),
      bearerTokensByOrigin: serviceReadBearerTokensByOrigin(plan, env)
    }),
    boardClient: createHttpBoardClient({
      fetch: io.fetch ?? globalThis.fetch,
      boardId: plan.multicaBoard,
      bearerToken: optionalEnv(env, "KL_MULTICA_BEARER_TOKEN"),
      createTaskEndpointUrl,
      addCommentEndpointUrl
    })
  });
}

async function runAgentScheduleCommand(
  args: readonly string[],
  io: KlHandlerIO
): Promise<KlAgentScheduleCommandResult> {
  const { dryRun, live, options } = parseAgentScheduleOptions(args);
  if (dryRun === live) {
    throw new UsageError("Command agent-schedule requires exactly one of --dry-run or --live.");
  }

  const timing = createAgentScheduleTiming({
    now: requireOne(options, "--now", "agent-schedule"),
    timezone: requireOne(options, "--timezone", "agent-schedule"),
    dailyAt: requireOne(options, "--daily-at", "agent-schedule")
  });
  const config = loadOptionalAgentConfig(options, "agent-schedule");
  const argvOptions = agentScheduleArgvOptions(options, "agent-schedule");
  const plan = createAgentDayDryRunPlan(
    agentDayInputFromConfig({
      config,
      overrides: agentDryRunOverrides(options, "agent-schedule"),
      date: timing.date
    })
  );

  if (dryRun) {
    return {
      command: "agent-schedule",
      mode: "dry-run",
      result: createAgentScheduleReport({
        timing,
        plan,
        argvOptions
      })
    };
  }

  if (!timing.due) {
    return {
      command: "agent-schedule",
      mode: "live",
      result: {
        status: "skipped",
        reason: "not_due",
        schedule: timing
      }
    };
  }

  const dayRunReport = await executeAgentDayLiveFromCli(plan, options, "agent-schedule", io);

  return {
    command: "agent-schedule",
    mode: "live",
    result: {
      status: dayRunReport.status,
      schedule: timing,
      dayRunReport
    }
  };
}

function runAgentLiveSmokeCommand(args: readonly string[]): KlAgentLiveSmokeCommandResult {
  const { dryRun, options } = parseAgentLiveSmokeOptions(args);
  if (!dryRun) {
    throw new UsageError("Command agent-live-smoke supports only --dry-run.");
  }

  const config = loadOptionalAgentConfig(options, "agent-live-smoke");
  const date = requireOne(options, "--date", "agent-live-smoke");
  const plan = createAgentDayDryRunPlan(
    agentDayInputFromConfig({
      config,
      overrides: agentDryRunOverrides(options, "agent-live-smoke"),
      date
    })
  );
  const manifestPath = requireOne(options, "--manifest", "agent-live-smoke");
  const { manifest, relativePath } = loadLiveSmokeManifest(manifestPath);
  const validation = validateLiveSmokeManifest(manifest, plan);
  const valid = validation.errors.length === 0;

  return {
    command: "agent-live-smoke",
    mode: "dry-run",
    result: {
      manifestPath: relativePath,
      date,
      valid,
      validation,
      nonCompletionNotice: valid ? readManifestNotice(manifest) : DEFAULT_LIVE_SMOKE_NON_COMPLETION_NOTICE,
      plan
    }
  };
}

function runAgentPreflightCommand(args: readonly string[]): KlAgentPreflightCommandResult {
  const { dryRun, options } = parseAgentPreflightOptions(args);
  if (!dryRun) {
    throw new UsageError("Command agent-preflight supports only --dry-run.");
  }

  const timing = createAgentScheduleTiming({
    now: requireOne(options, "--now", "agent-preflight"),
    timezone: requireOne(options, "--timezone", "agent-preflight"),
    dailyAt: requireOne(options, "--daily-at", "agent-preflight")
  });
  const config = loadOptionalAgentConfig(options, "agent-preflight");
  const argvOptions = agentScheduleArgvOptions(options, "agent-preflight");
  const plan = createAgentDayDryRunPlan(
    agentDayInputFromConfig({
      config,
      overrides: agentDryRunOverrides(options, "agent-preflight"),
      date: timing.date
    })
  );
  const schedule = createAgentScheduleReport({
    timing,
    plan,
    argvOptions
  });
  const manifestPath = requireOne(options, "--manifest", "agent-preflight");
  const { manifest, relativePath } = loadLiveSmokeManifest(manifestPath);
  const validation = validateLiveSmokeManifest(manifest, plan);
  const manifestEvidenceDays = readManifestEvidenceDays(manifest);
  const boardConfigPath =
    optionalOne(options, "--board-config", "agent-preflight") ?? DEFAULT_BOARD_PUBLISH_CONFIG_PATH;
  const boardConfig = loadBoardPublishConfigValidation(boardConfigPath);
  const offlineChecks = createPreflightChecks({
    timing,
    liveSmokeValid: validation.errors.length === 0,
    manifestEvidenceDays,
    boardConfigValid: boardConfig.valid
  });

  return {
    command: "agent-preflight",
    mode: "dry-run",
    result: {
      date: timing.date,
      status: offlineChecks.every((check) => check.status === "passed") ? "ready_for_live_smoke" : "blocked",
      nonCompletionNotice: DEFAULT_PREFLIGHT_NON_COMPLETION_NOTICE,
      offlineChecks,
      requiredLiveProofs: M2_REQUIRED_LIVE_PROOFS,
      schedule,
      liveSmoke: {
        manifestPath: relativePath,
        valid: validation.errors.length === 0,
        manifestEvidenceDays,
        validation
      },
      boardConfig: {
        configPath: boardConfig.relativePath,
        valid: boardConfig.valid,
        validation: boardConfig.validation
      }
    }
  };
}

function runAgentBoardConfigCommand(args: readonly string[]): KlAgentBoardConfigCommandResult {
  const { dryRun, options } = parseAgentBoardConfigOptions(args);
  if (!dryRun) {
    throw new UsageError("Command agent-board-config supports only --dry-run.");
  }

  const configPath = requireOne(options, "--config", "agent-board-config");
  const boardConfig = loadBoardPublishConfigValidation(configPath);

  return {
    command: "agent-board-config",
    mode: "dry-run",
    result: {
      configPath: boardConfig.relativePath,
      valid: boardConfig.valid,
      validation: boardConfig.validation,
      nonCompletionNotice: DEFAULT_BOARD_CONFIG_NON_COMPLETION_NOTICE
    }
  };
}

function loadBoardPublishConfigValidation(configPath: string): {
  readonly relativePath: string;
  readonly valid: boolean;
  readonly validation: BoardPublishConfigValidationResult;
} {
  const { value, relativePath, errors } = loadCheckoutJsonForValidation(configPath, "Board publish config");
  const validation =
    errors.length === 0
      ? validateBoardPublishConfig(value)
      : {
          errors,
          warnings: [BOARD_PUBLISH_CONFIG_LIVE_CLIENT_WARNING]
        };

  return {
    relativePath,
    valid: validation.errors.length === 0,
    validation
  };
}

function runAgentBoardEvidenceCommand(args: readonly string[]): KlAgentBoardEvidenceCommandResult {
  const { dryRun, options } = parseAgentBoardEvidenceOptions(args);
  if (!dryRun) {
    throw new UsageError("Command agent-board-evidence supports only --dry-run.");
  }

  const evidencePath = requireOne(options, "--evidence", "agent-board-evidence");
  const manifestPath = requireOne(options, "--manifest", "agent-board-evidence");
  const {
    value: manifest,
    relativePath: manifestRelativePath,
    errors: manifestErrors
  } = loadCheckoutJsonForValidation(manifestPath, "Live smoke manifest");
  const { value: evidence, relativePath: evidenceRelativePath, errors } = loadCheckoutJsonForValidation(
    evidencePath,
    "Board-day evidence"
  );
  const loadErrors = [...manifestErrors, ...errors];
  const validation =
    loadErrors.length === 0
      ? validateBoardDayEvidence(evidence, manifest)
      : {
          errors: loadErrors,
          warnings: [BOARD_DAY_EVIDENCE_OFFLINE_WARNING]
        };
  const valid = validation.errors.length === 0;

  return {
    command: "agent-board-evidence",
    mode: "dry-run",
    result: {
      evidencePath: evidenceRelativePath,
      manifestPath: manifestRelativePath,
      status: valid ? "observed_evidence_valid" : "blocked",
      valid,
      validation,
      nonCompletionNotice: DEFAULT_BOARD_EVIDENCE_NON_COMPLETION_NOTICE
    }
  };
}

async function runAgentFailureSmokeCommand(args: readonly string[]): Promise<KlAgentFailureSmokeCommandResult> {
  const { dryRun, options } = parseAgentFailureSmokeOptions(args);
  if (!dryRun) {
    throw new UsageError("Command agent-failure-smoke supports only --dry-run.");
  }

  const config = loadOptionalAgentConfig(options, "agent-failure-smoke");
  const date = requireOne(options, "--date", "agent-failure-smoke");
  const plan = createAgentDayDryRunPlan(
    agentDayInputFromConfig({
      config,
      overrides: agentDryRunOverrides(options, "agent-failure-smoke"),
      date
    })
  );
  const result = await createAgentFailureSmokeReport({
    plan,
    failedEndpoint: agentFailureSmokeSelector(options)
  });

  return {
    command: "agent-failure-smoke",
    mode: "dry-run",
    result
  };
}

async function runAgentHarnessDependencyCommand(
  args: readonly string[],
  io: KlHandlerIO
): Promise<KlAgentHarnessDependencyCommandResult> {
  const { dryRun, options } = parseAgentHarnessDependencyOptions(args);
  if (!dryRun) {
    throw new UsageError("Command agent-harness-dependency supports only --dry-run.");
  }

  const harnessPath = path.resolve(requireOne(options, "--harness-path", "agent-harness-dependency"));
  const runtimePackage = optionalOne(options, "--runtime-package", "agent-harness-dependency");
  const fileSystem = io.fileSystem ?? defaultFileSystem;
  const execFile = io.execFile ?? defaultExecFile;
  const runtimeImport =
    runtimePackage === undefined
      ? undefined
      : await inspectPiHarnessRuntimeImport({
          packageName: parsePiHarnessRuntimePackage(runtimePackage),
          ...(io.importModule === undefined ? {} : { importer: io.importModule })
        });
  const packageJson = readHarnessPackageJson(fileSystem, harnessPath);
  const result = validatePiHarnessDependency({
    packageJson,
    distFiles: {
      main: fileSystem.isFile(path.join(harnessPath, "dist", "index.js")),
      types: fileSystem.isFile(path.join(harnessPath, "dist", "index.d.ts")),
      cli: fileSystem.isFile(path.join(harnessPath, "dist", "cli", "index.js")),
      cliTypes: fileSystem.isFile(path.join(harnessPath, "dist", "cli", "index.d.ts")),
      newAgentScript: fileSystem.isFile(path.join(harnessPath, "scripts", "new-agent.mjs"))
    },
    gitStatusShort: readHarnessGitStatus(execFile, harnessPath),
    ...(runtimeImport === undefined ? {} : { runtimeImport })
  });

  return {
    command: "agent-harness-dependency",
    mode: "dry-run",
    result: {
      harnessPath: "EXTERNAL_PATH_REDACTED",
      ...result
    }
  };
}

const defaultFileSystem: NonNullable<KlHandlerIO["fileSystem"]> = {
  readJson(filePath) {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  },
  isFile(filePath) {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  }
};

function defaultExecFile(file: string, args: readonly string[]): string {
  return execFileSync(file, [...args], { encoding: "utf8" });
}

function readHarnessPackageJson(fileSystem: NonNullable<KlHandlerIO["fileSystem"]>, harnessPath: string): unknown {
  try {
    return fileSystem.readJson(path.join(harnessPath, "package.json"));
  } catch {
    throw new UsageError("Pi-harness dependency preflight could not read package.json from the provided harness path.");
  }
}

function readHarnessGitStatus(execFile: NonNullable<KlHandlerIO["execFile"]>, harnessPath: string): string {
  try {
    return execFile("git", ["--no-optional-locks", "-C", harnessPath, "status", "--short"]);
  } catch {
    throw new UsageError("Pi-harness dependency preflight could not inspect git status for the provided harness path.");
  }
}

function parseOptions(args: readonly string[], allowed: Set<string>, command: string): Map<string, string[]> {
  const options = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];

    if (name === undefined || !name.startsWith("--")) {
      throw new UsageError(`Unexpected positional argument for ${command}: ${name ?? ""}`);
    }

    if (!allowed.has(name)) {
      throw new UsageError(`Unknown option for ${command}: ${name}`);
    }

    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`Option ${name} for ${command} requires a value.`);
    }

    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
    index += 1;
  }

  return options;
}

function parseAgentOptions(args: readonly string[]): { dryRun: boolean; options: Map<string, string[]> } {
  return parseFlaggedOptions(
    args,
    new Set([
      "--role",
      "--phase",
      "--date",
      "--knowledge-loop-url",
      "--compass-health-url",
      "--nutritionist-meal-read-url-template",
      "--adapter",
      "--board",
      "--config"
    ]),
    "agent"
  );
}

function parseAgentDayOptions(args: readonly string[]): {
  dryRun: boolean;
  live: boolean;
  options: Map<string, string[]>;
} {
  return parseFlaggedOptions(
    args,
    new Set([
      "--live",
      "--date",
      "--knowledge-loop-url",
      "--compass-health-url",
      "--nutritionist-meal-read-url-template",
      "--adapter",
      "--board",
      "--config",
      "--multica-create-task-url",
      "--multica-add-comment-url"
    ]),
    "agent-day"
  );
}

function parseAgentScheduleOptions(args: readonly string[]): {
  dryRun: boolean;
  live: boolean;
  options: Map<string, string[]>;
} {
  return parseFlaggedOptions(
    args,
    new Set([
      "--live",
      "--now",
      "--timezone",
      "--daily-at",
      "--knowledge-loop-url",
      "--compass-health-url",
      "--nutritionist-meal-read-url-template",
      "--adapter",
      "--board",
      "--config",
      "--multica-create-task-url",
      "--multica-add-comment-url"
    ]),
    "agent-schedule"
  );
}

function parseAgentLiveSmokeOptions(args: readonly string[]): { dryRun: boolean; options: Map<string, string[]> } {
  return parseFlaggedOptions(
    args,
    new Set([
      "--manifest",
      "--date",
      "--knowledge-loop-url",
      "--compass-health-url",
      "--nutritionist-meal-read-url-template",
      "--adapter",
      "--board",
      "--config"
    ]),
    "agent-live-smoke"
  );
}

function parseAgentPreflightOptions(args: readonly string[]): { dryRun: boolean; options: Map<string, string[]> } {
  return parseFlaggedOptions(
    args,
    new Set([
      "--now",
      "--timezone",
      "--daily-at",
      "--manifest",
      "--knowledge-loop-url",
      "--compass-health-url",
      "--nutritionist-meal-read-url-template",
      "--adapter",
      "--board",
      "--board-config",
      "--config"
    ]),
    "agent-preflight"
  );
}

function parseAgentBoardConfigOptions(args: readonly string[]): { dryRun: boolean; options: Map<string, string[]> } {
  return parseFlaggedOptions(args, new Set(["--config"]), "agent-board-config");
}

function parseAgentBoardEvidenceOptions(args: readonly string[]): { dryRun: boolean; options: Map<string, string[]> } {
  return parseFlaggedOptions(args, new Set(["--evidence", "--manifest"]), "agent-board-evidence");
}

function parseAgentFailureSmokeOptions(args: readonly string[]): { dryRun: boolean; options: Map<string, string[]> } {
  return parseFlaggedOptions(
    args,
    new Set([
      "--role",
      "--phase",
      "--method",
      "--url-includes",
      "--date",
      "--knowledge-loop-url",
      "--compass-health-url",
      "--nutritionist-meal-read-url-template",
      "--adapter",
      "--board",
      "--config"
    ]),
    "agent-failure-smoke"
  );
}

function parseAgentHarnessDependencyOptions(args: readonly string[]): { dryRun: boolean; options: Map<string, string[]> } {
  return parseFlaggedOptions(
    args,
    new Set(["--harness-path", "--runtime-package"]),
    "agent-harness-dependency"
  );
}

function loadOptionalAgentConfig(options: Map<string, string[]>, command: string): AgentRuntimeConfig | undefined {
  const configPath = optionalOne(options, "--config", command);

  return configPath === undefined ? undefined : loadAgentRuntimeConfig(configPath);
}

function agentFailureSmokeSelector(options: Map<string, string[]>): AgentFailureSmokeEndpointSelector | undefined {
  const roleValue = optionalOne(options, "--role", "agent-failure-smoke");
  const phaseValue = optionalOne(options, "--phase", "agent-failure-smoke");
  const methodValue = optionalOne(options, "--method", "agent-failure-smoke");
  const urlIncludes = optionalOne(options, "--url-includes", "agent-failure-smoke");

  if (roleValue === undefined && phaseValue === undefined && methodValue === undefined && urlIncludes === undefined) {
    return undefined;
  }

  return {
    ...(roleValue === undefined ? {} : { role: parseAgentRole(roleValue) }),
    ...(phaseValue === undefined ? {} : { phase: parseAgentPhase(phaseValue) }),
    ...(methodValue === undefined ? {} : { method: parseAgentFailureSmokeMethod(methodValue) }),
    ...(urlIncludes === undefined ? {} : { urlIncludes })
  };
}

function loadLiveSmokeManifest(manifestPath: string): { manifest: unknown; relativePath: string } {
  const loaded = loadCheckoutJson(manifestPath, "Live smoke manifest");

  return {
    manifest: loaded.value,
    relativePath: loaded.relativePath
  };
}

function loadCheckoutJson(filePath: string, label: string): { value: unknown; relativePath: string } {
  const { realPath, relativePath } = resolveCheckoutFile(filePath, label);
  const sourceText = readFileSync(realPath, "utf8");
  assertNoDuplicateJsonKeys(sourceText);

  return {
    value: JSON.parse(sourceText) as unknown,
    relativePath
  };
}

function loadCheckoutJsonForValidation(
  filePath: string,
  label: string
): { value: unknown; relativePath: string; errors: readonly string[] } {
  const { realPath, relativePath } = resolveCheckoutFile(filePath, label);
  const sourceText = readFileSync(realPath, "utf8");
  const errors: string[] = [];

  try {
    assertNoDuplicateJsonKeys(sourceText);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    return {
      value: undefined,
      relativePath,
      errors
    };
  }

  try {
    return {
      value: JSON.parse(sourceText) as unknown,
      relativePath,
      errors
    };
  } catch (error) {
    return {
      value: undefined,
      relativePath,
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }
}

function resolveCheckoutFile(filePath: string, label: string): { realPath: string; relativePath: string } {
  const projectRoot = realpathSync(path.resolve(process.cwd()));
  const resolvedPath = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError(`${label} path must stay inside the knowledge-loop checkout.`);
  }

  if (!existsSync(resolvedPath)) {
    throw new UsageError(`${label} path does not exist: ${filePath}.`);
  }

  const realPath = realpathSync(resolvedPath);
  const realRelative = path.relative(projectRoot, realPath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new UsageError(`${label} path must stay inside the knowledge-loop checkout.`);
  }

  return {
    realPath,
    relativePath: toPosixPath(realRelative)
  };
}

function readManifestNotice(value: unknown): string {
  if (isRecord(value) && typeof value.nonCompletionNotice === "string" && value.nonCompletionNotice.length > 0) {
    return value.nonCompletionNotice;
  }

  return DEFAULT_LIVE_SMOKE_NON_COMPLETION_NOTICE;
}

function readManifestEvidenceDays(value: unknown): readonly string[] {
  if (!isRecord(value) || !isRecord(value.evidence) || !Array.isArray(value.evidence.days)) {
    return [];
  }

  return value.evidence.days.flatMap((day) => (isRecord(day) && typeof day.date === "string" ? [day.date] : []));
}

function createPreflightChecks(input: {
  readonly timing: AgentScheduleTiming;
  readonly liveSmokeValid: boolean;
  readonly manifestEvidenceDays: readonly string[];
  readonly boardConfigValid: boolean;
}): readonly KlAgentPreflightOfflineCheck[] {
  const firstManifestDay = input.manifestEvidenceDays[0];
  const manifestAligned = firstManifestDay === input.timing.date;

  return [
    {
      id: "scheduler_due",
      status: input.timing.due ? "passed" : "blocked",
      detail: input.timing.due
        ? `Scheduler is due for ${input.timing.date}.`
        : `Scheduler is not yet due for ${input.timing.date}.`
    },
    {
      id: "live_smoke_manifest_valid",
      status: input.liveSmokeValid ? "passed" : "blocked",
      detail: input.liveSmokeValid ? "Live-smoke manifest validation passed." : "Live-smoke manifest has errors."
    },
    {
      id: "manifest_starts_on_schedule_date",
      status: manifestAligned ? "passed" : "blocked",
      detail:
        firstManifestDay === undefined
          ? `Manifest has no evidence day to match scheduler date ${input.timing.date}.`
          : manifestAligned
            ? `Manifest first evidence day matches scheduler date ${input.timing.date}.`
            : `Manifest first evidence day ${firstManifestDay} must match scheduler date ${input.timing.date}.`
    },
    {
      id: "board_publish_config_valid",
      status: input.boardConfigValid ? "passed" : "blocked",
      detail: input.boardConfigValid
        ? "Board publish config validation passed."
        : "Board publish config has errors."
    }
  ];
}

function agentDryRunOverrides(options: Map<string, string[]>, command: string): AgentDryRunDefaults {
  const knowledgeLoopBaseUrl = optionalOne(options, "--knowledge-loop-url", command);
  const compassHealthBaseUrl = optionalOne(options, "--compass-health-url", command);
  const nutritionistMealReadUrlTemplate = optionalOne(options, "--nutritionist-meal-read-url-template", command);
  const adapterId = optionalOne(options, "--adapter", command);
  const multicaBoard = optionalOne(options, "--board", command);

  return {
    ...(knowledgeLoopBaseUrl === undefined ? {} : { knowledgeLoopBaseUrl }),
    ...(compassHealthBaseUrl === undefined ? {} : { compassHealthBaseUrl }),
    ...(nutritionistMealReadUrlTemplate === undefined ? {} : { nutritionistMealReadUrlTemplate }),
    ...(adapterId === undefined ? {} : { adapterId }),
    ...(multicaBoard === undefined ? {} : { multicaBoard })
  };
}

function agentScheduleArgvOptions(options: Map<string, string[]>, command: string): AgentScheduleArgvOptions {
  const configPath = optionalOne(options, "--config", command);
  const dryRunOverrides = agentDryRunOverrides(options, command);

  return {
    ...(configPath === undefined ? {} : { configPath }),
    ...(dryRunOverrides.knowledgeLoopBaseUrl === undefined
      ? {}
      : { knowledgeLoopBaseUrl: dryRunOverrides.knowledgeLoopBaseUrl }),
    ...(dryRunOverrides.compassHealthBaseUrl === undefined
      ? {}
      : { compassHealthBaseUrl: dryRunOverrides.compassHealthBaseUrl }),
    ...(dryRunOverrides.nutritionistMealReadUrlTemplate === undefined
      ? {}
      : { nutritionistMealReadUrlTemplate: dryRunOverrides.nutritionistMealReadUrlTemplate }),
    ...(dryRunOverrides.adapterId === undefined ? {} : { adapterId: dryRunOverrides.adapterId }),
    ...(dryRunOverrides.multicaBoard === undefined ? {} : { multicaBoard: dryRunOverrides.multicaBoard })
  };
}

function parseFlaggedOptions(
  args: readonly string[],
  allowed: Set<string>,
  command: string
): { dryRun: boolean; live: boolean; options: Map<string, string[]> } {
  const options = new Map<string, string[]>();
  let dryRun = false;
  let live = false;

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];

    if (name === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (name === "--live" && allowed.has("--live")) {
      live = true;
      continue;
    }

    if (name === undefined || !name.startsWith("--")) {
      throw new UsageError(`Unexpected positional argument for ${command}: ${name ?? ""}`);
    }

    if (!allowed.has(name)) {
      throw new UsageError(`Unknown option for ${command}: ${name}`);
    }

    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`Option ${name} for ${command} requires a value.`);
    }

    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
    index += 1;
  }

  return { dryRun, live, options };
}

function optionalEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name];

  return value === undefined || value.length === 0 ? undefined : value;
}

function serviceReadBearerTokensByOrigin(
  plan: AgentDayDryRunPlan,
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | undefined>> {
  const fallbackBearerToken = optionalEnv(env, "KL_AGENT_READ_BEARER_TOKEN");
  const knowledgeLoopBearerToken = optionalEnv(env, "KL_AGENT_KNOWLEDGE_LOOP_BEARER_TOKEN");
  const compassHealthBearerToken = optionalEnv(env, "KL_AGENT_COMPASS_HEALTH_BEARER_TOKEN");
  const bearerTokensByOrigin: Record<string, string | undefined> = {};

  for (const agentPlan of plan.sequence) {
    const serviceBearerToken = agentPlan.role === "nutritionist" ? compassHealthBearerToken : knowledgeLoopBearerToken;
    const effectiveBearerToken = serviceBearerToken ?? fallbackBearerToken;
    for (const endpoint of agentPlan.externalReads) {
      assignBearerTokenForEndpointOrigin(bearerTokensByOrigin, endpoint.url, effectiveBearerToken);
    }
  }

  return bearerTokensByOrigin;
}

function assignBearerTokenForEndpointOrigin(
  bearerTokensByOrigin: Record<string, string | undefined>,
  endpointUrl: string,
  bearerToken: string | undefined
): void {
  const origin = httpOriginFor(endpointUrl);
  if (origin !== undefined) {
    const hasExistingBearerToken = hasOwnKey(bearerTokensByOrigin, origin);
    const existingBearerToken = bearerTokensByOrigin[origin];
    if (hasExistingBearerToken && existingBearerToken !== bearerToken) {
      throw new UsageError(`Agent read services share origin ${origin} but require different read bearer tokens.`);
    }
    bearerTokensByOrigin[origin] = bearerToken;
  }
}

function httpOriginFor(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function hasOwnKey(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function persistCommandTraceEvents(db: Database.Database, result: { traceEvents: readonly TraceEvent[] }): void {
  if (result.traceEvents.length === 0) {
    return;
  }

  persistTraceEvents(db, result.traceEvents);
}

function parseExerciseDayOption(value: string): ExerciseTemplateDayInput {
  const parts = value.split(":");
  if (parts.length !== 4) {
    throw invalidExerciseDay(value);
  }

  const [dayOffsetValue = "", sessionKeyValue = "", titleValue = "", targetValue = ""] = parts;
  return {
    dayOffset: parseExerciseDayOffset(dayOffsetValue, value),
    sessionKey: parseExerciseDayText(sessionKeyValue, value),
    title: parseExerciseDayText(titleValue, value),
    targetMinutes: parseExerciseDayTarget(targetValue, value)
  };
}

function parseExerciseDayOffset(value: string, fullValue: string): number {
  const text = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw invalidExerciseDay(fullValue);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidExerciseDay(fullValue);
  }

  return parsed;
}

function parseExerciseDayTarget(value: string, fullValue: string): number {
  const text = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw invalidExerciseDay(fullValue);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalidExerciseDay(fullValue);
  }

  return parsed;
}

function parseExerciseDayText(value: string, fullValue: string): string {
  const text = value.trim();
  if (text.length === 0 || hasControlCharacter(text)) {
    throw invalidExerciseDay(fullValue);
  }

  return text;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function invalidExerciseDay(value: string): UsageError {
  return new UsageError(
    `Invalid --day value "${value}". Expected dayOffset:sessionKey:title:targetMinutes with non-negative dayOffset and positive targetMinutes.`
  );
}

function parseCliIsoDate(value: string, optionName: string): string {
  assertCliIsoDate(value, optionName);
  return value;
}

function parseCliMondayIsoDate(value: string, optionName: string): string {
  const date = parseCliIsoDate(value, optionName);
  if (new Date(`${date}T00:00:00.000Z`).getUTCDay() !== 1) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected a Monday ISO date.`);
  }

  return date;
}

function assertCliDateRange(from: string, to: string): void {
  if (`${to}T00:00:00.000Z` <= `${from}T00:00:00.000Z`) {
    throw new UsageError(`Invalid --to value "${to}". Expected an ISO date after --from.`);
  }
}

function parseExerciseIntensity(value: string): ExerciseIntensity {
  if (value === "low" || value === "moderate" || value === "high") {
    return value;
  }

  throw new UsageError(`Invalid --intensity value "${value}". Expected low, moderate, or high.`);
}

function assertHealthExerciseCompletionTargetMode(
  sessionId: number | undefined,
  planId: number | undefined,
  templateSessionKey: string | undefined
): void {
  const hasSessionId = sessionId !== undefined;
  const hasPlanTarget = planId !== undefined || templateSessionKey !== undefined;
  const hasCompletePlanTarget = planId !== undefined && templateSessionKey !== undefined;
  if ((hasSessionId && hasPlanTarget) || (!hasSessionId && hasPlanTarget && !hasCompletePlanTarget)) {
    throw new UsageError("completion target must be sessionId, planId with templateSessionKey, or omitted");
  }
}

function openExistingHealthExerciseDatabase(
  dbPath: string,
  options: { readonly?: boolean } = {}
): Database.Database {
  if (!existsSync(dbPath)) {
    throw new UsageError(`Health exercise database does not exist: ${dbPath}.`);
  }

  return new Database(
    dbPath,
    options.readonly === true ? { readonly: true, fileMustExist: true } : { fileMustExist: true }
  );
}

function openExistingHealthSedentaryDatabase(
  dbPath: string,
  options: { readonly?: boolean } = {}
): Database.Database {
  if (!existsSync(dbPath)) {
    throw new UsageError(`Health sedentary database does not exist: ${dbPath}.`);
  }

  return new Database(
    dbPath,
    options.readonly === true ? { readonly: true, fileMustExist: true } : { fileMustExist: true }
  );
}

function parseSedentaryState(value: string): SedentaryState {
  if (value === "active" || value === "idle" || value === "unknown") {
    return value;
  }

  throw new UsageError(`Invalid --state value "${value}". Expected active, idle, or unknown.`);
}

function parseCliBoolean(value: string, optionName: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new UsageError(`Invalid ${optionName} value "${value}". Expected true or false.`);
}

function assertCliInstantRange(from: string, to: string, toOptionName: string, fromOptionName = "--from"): void {
  if (to <= from) {
    throw new UsageError(`Invalid ${toOptionName} value "${to}". Expected an ISO instant after ${fromOptionName}.`);
  }
}

function parseMetricNumber(value: string, optionName: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);

  if (trimmed.length === 0 || !Number.isFinite(parsed) || Math.abs(parsed) >= 1.0e308) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected a finite metric value.`);
  }

  return parsed;
}

function parseMetricDateBound(
  value: string,
  optionName: string,
  dateOnlyMode: "start-of-day" | "end-of-day"
): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    assertCliIsoDate(value, optionName);
    return dateOnlyMode === "start-of-day" ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
  }

  return parseCliIsoInstant(value, optionName);
}

function parseCliIsoInstant(value: string, optionName: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected an ISO instant.`);
  }

  return value;
}

function assertCliIsoDate(value: string, optionName: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected an ISO date.`);
  }

  const normalized = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toISOString()
    .slice(0, 10);
  if (normalized !== value) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected an ISO date.`);
  }
}

function readHealthMetricCsvFile(filePath: string): { csvText: string; sourceFilename: string } {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const displayName = path.basename(filePath) || "CSV file";

  if (!existsSync(resolvedPath)) {
    throw new UsageError(`Health metric CSV file does not exist: ${displayName}.`);
  }

  const realPath = realpathSync(resolvedPath);

  if (!statSync(realPath).isFile()) {
    throw new UsageError(`Health metric CSV path must point to a regular file: ${displayName}.`);
  }

  if (path.extname(realPath).toLowerCase() !== ".csv") {
    throw new UsageError("Health metric CSV file must use a .csv extension.");
  }

  if (hasCompassHealthPathSegment(realPath)) {
    throw new UsageError("Health metric CSV must not be read from compass-health files.");
  }

  return {
    csvText: readFileSync(realPath, "utf8"),
    sourceFilename: path.basename(realPath)
  };
}

function hasCompassHealthPathSegment(filePath: string): boolean {
  return filePath
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase().startsWith("compass-health"));
}

function parseUnitNumber(value: string, optionName: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);

  if (trimmed.length === 0 || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected a finite number between 0 and 1.`);
  }

  return parsed;
}

function parsePositiveSafeInteger(value: string, optionName: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected a positive safe integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected a positive safe integer.`);
  }

  return parsed;
}

function parseNonNegativeSafeInteger(value: string, optionName: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected a non-negative safe integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageError(`Invalid ${optionName} value "${value}". Expected a non-negative safe integer.`);
  }

  return parsed;
}

function parseApplicationDifficulty(value: string): number {
  if (!/^[1-5]$/.test(value)) {
    throw new UsageError(`Invalid --difficulty value "${value}". Expected a safe integer between 1 and 5.`);
  }

  return Number(value);
}

function parseHttpEndpointOption(value: string, optionName: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`Invalid ${optionName} value. Expected an http or https URL.`);
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new UsageError(`Invalid ${optionName} value. Multica board endpoint must not include URL credentials.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`Invalid ${optionName} value. Expected an http or https URL.`);
  }

  return value;
}

function parseAgentFailureSmokeMethod(value: string): AgentEndpointPlan["method"] {
  if (value === "GET" || value === "POST") {
    return value;
  }

  throw new UsageError(`Invalid --method value "${value}". Expected GET or POST.`);
}

function parseTraceRunId(value: string): string {
  if (value.trim().length === 0) {
    throw new UsageError("Command trace requires a non-empty --run value.");
  }

  return value;
}

function parseTraceStage(value: string): TraceStage {
  if ((TRACE_STAGES as readonly string[]).includes(value)) {
    return value as TraceStage;
  }

  throw new UsageError(`Invalid --stage value "${value}". Expected one of: ${TRACE_STAGES.join(", ")}.`);
}

function parsePiHarnessRuntimePackage(value: string): "pi-harness" {
  if (value === "pi-harness") {
    return value;
  }

  throw new UsageError("Command agent-harness-dependency only supports --runtime-package pi-harness.");
}

function requireOne(options: Map<string, string[]>, name: string, command: string): string {
  const values = options.get(name) ?? [];

  if (values.length !== 1) {
    throw new UsageError(`Command ${command} requires exactly one ${name} value.`);
  }

  return values[0] as string;
}

function optionalOne(options: Map<string, string[]>, name: string, command: string): string | undefined {
  const values = options.get(name) ?? [];

  if (values.length === 0) {
    return undefined;
  }

  if (values.length !== 1) {
    throw new UsageError(`Command ${command} requires exactly one ${name} value.`);
  }

  return values[0] as string;
}

function requireMany(options: Map<string, string[]>, name: string, command: string): string[] {
  const values = options.get(name) ?? [];

  if (values.length === 0) {
    throw new UsageError(`Command ${command} requires at least one ${name} value.`);
  }

  return values;
}

function parseConcept(value: string): PlanConceptInput {
  const separator = value.indexOf(":");

  if (separator === -1) {
    return {
      slug: value,
      name: value
    };
  }

  const slug = value.slice(0, separator).trim();
  const name = value.slice(separator + 1).trim();

  if (slug.length === 0 || name.length === 0) {
    throw new UsageError(`Invalid --concept value "${value}". Use slug:name.`);
  }

  return {
    slug,
    name
  };
}

function assertNoDuplicateJsonKeys(sourceText: string): void {
  const objectKeys: Array<Set<string>> = [];

  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '"') {
      const { value, endIndex } = readJsonString(sourceText, index);
      const nextIndex = skipWhitespace(sourceText, endIndex + 1);
      if (sourceText[nextIndex] === ":" && objectKeys.length > 0) {
        const keys = objectKeys[objectKeys.length - 1];
        if (keys?.has(value)) {
          throw new Error(`Duplicate JSON key ${value}.`);
        }
        keys?.add(value);
      }
      index = endIndex;
      continue;
    }

    if (char === "{") {
      objectKeys.push(new Set<string>());
    } else if (char === "}") {
      objectKeys.pop();
    }
  }
}

function readJsonString(sourceText: string, startIndex: number): { value: string; endIndex: number } {
  let escaped = false;
  for (let index = startIndex + 1; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return {
        value: JSON.parse(sourceText.slice(startIndex, index + 1)) as string,
        endIndex: index
      };
    }
  }

  throw new Error("JSON file contains an unterminated string.");
}

function skipWhitespace(sourceText: string, startIndex: number): number {
  let index = startIndex;
  while (/\s/u.test(sourceText[index] ?? "")) {
    index += 1;
  }

  return index;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];

  if (entrypoint === undefined) {
    return false;
  }

  return path.resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  handleKlCommand(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = error instanceof UsageError ? error.exitCode : 1;

    process.stderr.write(`${message}\n`);
    process.exitCode = exitCode;
  });
}
