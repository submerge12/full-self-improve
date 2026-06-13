#!/usr/bin/env -S tsx
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
  type AgentScheduleArgvOptions
} from "../agents/schedule.js";
import { MarkdownVaultAdapter } from "../adapters/markdown-vault.js";
import { applyMigrations } from "../db/migrations.js";
import { listTraceEvents, persistTraceEvents, type StoredTraceEvent } from "../db/trace-store.js";
import {
  diagnosePersistentWeakSpots,
  type PersistentDiagnoseResult
} from "../engine/persistent-diagnose.js";
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
  gradePersistentTeachback,
  type PersistentTeachbackGradeResult
} from "../engine/persistent-teachback.js";

export interface WritableSink {
  write(chunk: string | Uint8Array): unknown;
}

export interface KlHandlerIO {
  stdout?: WritableSink;
  stderr?: WritableSink;
  fetch?: AgentFetch;
  env?: Readonly<Record<string, string | undefined>>;
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

export interface KlPersistentDiagnoseCommandResult {
  command: "diagnose";
  mode: "mock-persistent";
  result: PersistentDiagnoseResult;
}

export type KlDiagnoseCommandResult = KlPersistentDiagnoseCommandResult;

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

export type KlAgentScheduleCommandResult = KlAgentScheduleDryRunCommandResult;

export type KlCommandResult =
  | KlIngestCommandResult
  | KlPlanCommandResult
  | KlQuizCommandResult
  | KlTeachbackCommandResult
  | KlDiagnoseCommandResult
  | KlTraceCommandResult
  | KlAgentCommandResult
  | KlAgentDayCommandResult
  | KlAgentScheduleCommandResult;

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

  if (command === "agent") {
    return runAgentCommand(args);
  }

  if (command === "agent-day") {
    return runAgentDayCommand(args, io);
  }

  if (command === "agent-schedule") {
    return runAgentScheduleCommand(args);
  }

  throw new UsageError(
    `Unknown command "${command ?? ""}". Expected one of: ingest, plan, quiz, teachback, diagnose, trace, agent, agent-day, agent-schedule.`
  );
}

export async function handleKlCommand(argv: readonly string[], io: KlHandlerIO = {}): Promise<KlCommandResult> {
  const result = await runKlCommand(argv, io);
  io.stdout?.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

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

  const env = io.env ?? process.env;
  const result = await executeAgentDay(plan, "live", {
    readClient: createFetchAgentReadClient({
      fetch: io.fetch ?? globalThis.fetch,
      bearerToken: optionalEnv(env, "KL_AGENT_READ_BEARER_TOKEN")
    }),
    boardClient: createHttpBoardClient({
      fetch: io.fetch ?? globalThis.fetch,
      boardId: plan.multicaBoard,
      bearerToken: optionalEnv(env, "KL_MULTICA_BEARER_TOKEN"),
      createTaskEndpointUrl: requireOne(options, "--multica-create-task-url", "agent-day"),
      addCommentEndpointUrl: requireOne(options, "--multica-add-comment-url", "agent-day")
    })
  });

  return {
    command: "agent-day",
    mode: "live",
    result
  };
}

function runAgentScheduleCommand(args: readonly string[]): KlAgentScheduleCommandResult {
  const { dryRun, options } = parseAgentScheduleOptions(args);
  if (!dryRun) {
    throw new UsageError("Command agent-schedule supports only --dry-run.");
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
      "--adapter",
      "--board",
      "--config",
      "--multica-create-task-url",
      "--multica-add-comment-url"
    ]),
    "agent-day"
  );
}

function parseAgentScheduleOptions(args: readonly string[]): { dryRun: boolean; options: Map<string, string[]> } {
  return parseFlaggedOptions(
    args,
    new Set([
      "--now",
      "--timezone",
      "--daily-at",
      "--knowledge-loop-url",
      "--compass-health-url",
      "--adapter",
      "--board",
      "--config"
    ]),
    "agent-schedule"
  );
}

function loadOptionalAgentConfig(options: Map<string, string[]>, command: string): AgentRuntimeConfig | undefined {
  const configPath = optionalOne(options, "--config", command);

  return configPath === undefined ? undefined : loadAgentRuntimeConfig(configPath);
}

function agentDryRunOverrides(options: Map<string, string[]>, command: string): AgentDryRunDefaults {
  const knowledgeLoopBaseUrl = optionalOne(options, "--knowledge-loop-url", command);
  const compassHealthBaseUrl = optionalOne(options, "--compass-health-url", command);
  const adapterId = optionalOne(options, "--adapter", command);
  const multicaBoard = optionalOne(options, "--board", command);

  return {
    ...(knowledgeLoopBaseUrl === undefined ? {} : { knowledgeLoopBaseUrl }),
    ...(compassHealthBaseUrl === undefined ? {} : { compassHealthBaseUrl }),
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

function persistCommandTraceEvents(db: Database.Database, result: { traceEvents: readonly TraceEvent[] }): void {
  if (result.traceEvents.length === 0) {
    return;
  }

  persistTraceEvents(db, result.traceEvents);
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
