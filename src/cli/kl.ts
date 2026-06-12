#!/usr/bin/env -S tsx
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MarkdownVaultAdapter } from "../adapters/markdown-vault.js";
import {
  createDailyPlan,
  gradeQuizAttempt,
  runMockIngest,
  type DailyPlan,
  type MockIngestResult,
  type PlanConceptInput,
  type QuizGradeResult
} from "../engine/mock-commands.js";

export interface WritableSink {
  write(chunk: string | Uint8Array): unknown;
}

export interface KlHandlerIO {
  stdout?: WritableSink;
  stderr?: WritableSink;
}

export interface KlIngestCommandResult {
  command: "ingest";
  mode: "mock";
  result: MockIngestResult;
}

export interface KlPlanCommandResult {
  command: "plan";
  mode: "mock";
  result: DailyPlan;
}

export interface KlQuizCommandResult {
  command: "quiz";
  mode: "mock";
  result: QuizGradeResult;
}

export type KlCommandResult = KlIngestCommandResult | KlPlanCommandResult | KlQuizCommandResult;

class UsageError extends Error {
  readonly exitCode = 2;
}

export async function runKlCommand(argv: readonly string[]): Promise<KlCommandResult> {
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

  throw new UsageError(`Unknown command "${command ?? ""}". Expected one of: ingest, plan, quiz.`);
}

export async function handleKlCommand(argv: readonly string[], io: KlHandlerIO = {}): Promise<KlCommandResult> {
  const result = await runKlCommand(argv);
  io.stdout?.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function runIngestCommand(args: readonly string[]): Promise<KlIngestCommandResult> {
  const options = parseOptions(args, new Set(["--vault"]), "ingest");
  const vault = requireOne(options, "--vault", "ingest");
  const adapter = new MarkdownVaultAdapter({
    id: "cli-vault",
    rootDir: vault
  });

  return {
    command: "ingest",
    mode: "mock",
    result: await runMockIngest(adapter)
  };
}

function runPlanCommand(args: readonly string[]): KlPlanCommandResult {
  const options = parseOptions(args, new Set(["--date", "--concept"]), "plan");
  const date = requireOne(options, "--date", "plan");
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
  const options = parseOptions(args, new Set(["--item", "--concept", "--answer", "--response"]), "quiz");
  const itemId = requireOne(options, "--item", "quiz");
  const conceptSlug = requireOne(options, "--concept", "quiz");
  const response = requireOne(options, "--response", "quiz");
  const answers = requireMany(options, "--answer", "quiz");

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

function requireOne(options: Map<string, string[]>, name: string, command: string): string {
  const values = options.get(name) ?? [];

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
