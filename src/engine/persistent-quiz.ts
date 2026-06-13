import type Database from "better-sqlite3";

import {
  gradeQuizAttempt,
  type ExactAnswerSpec,
  type QuizGradeResult,
  type QuizVerdict
} from "./mock-commands.js";
import { recordPersistentMasteryUpdate, type MasteryRecord } from "./persistent-mastery.js";
import { createTraceRecorder, type TraceEvent, type TraceRecorder } from "./trace.js";

export interface GradePersistentExactQuizAttemptInput {
  conceptSlug: string;
  statement?: string;
  prompt?: string;
  answer?: string | string[];
  answers?: string[];
  answerSpec?: ExactAnswerSpec;
  response: string;
  difficulty?: number;
  runId?: string;
  trace?: TraceRecorder;
  lastSeenAt?: string;
}

export interface PersistentQuizGradeResult {
  runId: string;
  itemId: number;
  attemptId: number;
  conceptSlug: string;
  response: string;
  verdict: QuizVerdict;
  masteryDelta: number;
  gradingMethod: "exact";
  mastery: MasteryRecord;
  traceEvents: TraceEvent[];
}

interface ConceptRow {
  id: number;
  slug: string;
}

interface MasteryScoreRow {
  score: number;
}

export function gradePersistentExactQuizAttempt(
  db: Database.Database,
  input: GradePersistentExactQuizAttemptInput
): PersistentQuizGradeResult {
  const runId = input.runId ?? `persistent-quiz-${input.conceptSlug}`;
  const trace = input.trace ?? createTraceRecorder();

  const grade = db.transaction((): Omit<PersistentQuizGradeResult, "traceEvents"> => {
    const concept = getConceptBySlug(db, input.conceptSlug);
    const statement = requiredStatement(input);
    const difficulty = validDifficulty(input.difficulty ?? 1);
    const answerSpec = exactAnswerSpec(input);
    const itemId = insertItem(db, concept.id, statement, answerSpec, difficulty);
    const quizGrade = gradeQuizAttempt({
      item: {
        id: String(itemId),
        conceptSlug: concept.slug,
        prompt: statement,
        answerSpec
      },
      response: input.response,
      runId,
      trace
    });
    const attemptId = insertAttempt(db, itemId, input.response, quizGrade);
    const nextScore = clampUnitInterval(currentMasteryScore(db, concept.id) + quizGrade.masteryDelta);
    const mastery = recordPersistentMasteryUpdate(db, {
      conceptId: concept.id,
      score: nextScore,
      confidence: 1,
      lastSeenAt: input.lastSeenAt,
      trace,
      runId
    });

    return {
      runId,
      itemId,
      attemptId,
      conceptSlug: concept.slug,
      response: input.response,
      verdict: quizGrade.verdict,
      masteryDelta: quizGrade.masteryDelta,
      gradingMethod: quizGrade.gradingMethod,
      mastery
    };
  })();

  return {
    ...grade,
    traceEvents: trace.getEvents({ runId })
  };
}

function getConceptBySlug(db: Database.Database, slug: string): ConceptRow {
  const row = db
    .prepare(
      `SELECT id, slug
       FROM concepts
       WHERE slug = ?`
    )
    .get(slug) as ConceptRow | undefined;

  if (row === undefined) {
    throw new Error(`Concept ${slug} was not found.`);
  }

  return row;
}

function requiredStatement(input: GradePersistentExactQuizAttemptInput): string {
  const statement = input.statement ?? input.prompt;
  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw new Error("Persistent quiz grading requires a statement.");
  }

  return statement;
}

function validDifficulty(difficulty: number): number {
  if (!Number.isSafeInteger(difficulty) || difficulty < 1 || difficulty > 5) {
    throw new Error("Persistent quiz difficulty must be an integer between 1 and 5.");
  }

  return difficulty;
}

function exactAnswerSpec(input: GradePersistentExactQuizAttemptInput): ExactAnswerSpec {
  if (input.answerSpec !== undefined) {
    if (input.answerSpec.type !== "exact" || input.answerSpec.answers.length === 0) {
      throw new Error("Exact-match grading requires at least one answer.");
    }

    return {
      ...input.answerSpec,
      answers: validateAnswers(input.answerSpec.answers, input.answerSpec.trim)
    };
  }

  const answers = input.answers ?? (Array.isArray(input.answer) ? input.answer : input.answer === undefined ? [] : [input.answer]);
  if (answers.length === 0) {
    throw new Error("Exact-match grading requires at least one answer.");
  }

  return {
    type: "exact",
    answers: validateAnswers(answers)
  };
}

function validateAnswers(answers: string[], trim = true): string[] {
  for (const answer of answers) {
    if (typeof answer !== "string") {
      throw new Error("Exact-match grading requires string answers.");
    }

    const comparable = trim === false ? answer : answer.trim();
    if (comparable.length === 0) {
      throw new Error("Exact-match grading requires each answer to be a non-empty answer.");
    }
  }

  return [...answers];
}

function insertItem(
  db: Database.Database,
  conceptId: number,
  statement: string,
  answerSpec: ExactAnswerSpec,
  difficulty: number
): number {
  const result = db
    .prepare(
      `INSERT INTO items (concept_id, concept_ids, type, difficulty, statement, answer_spec)
       VALUES (?, ?, 'fill_in', ?, ?, ?)`
    )
    .run(conceptId, JSON.stringify([conceptId]), difficulty, statement, JSON.stringify(answerSpec));

  return toNumberId(result.lastInsertRowid);
}

function insertAttempt(
  db: Database.Database,
  itemId: number,
  response: string,
  grade: QuizGradeResult
): number {
  const result = db
    .prepare(
      `INSERT INTO attempts (item_id, response, verdict, grading_method)
       VALUES (?, ?, ?, ?)`
    )
    .run(itemId, response, grade.verdict, grade.gradingMethod);

  return toNumberId(result.lastInsertRowid);
}

function currentMasteryScore(db: Database.Database, conceptId: number): number {
  const row = db
    .prepare(
      `SELECT score
       FROM mastery
       WHERE concept_id = ?`
    )
    .get(conceptId) as MasteryScoreRow | undefined;

  return row?.score ?? 0;
}

function clampUnitInterval(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 1_000_000_000_000) / 1_000_000_000_000;
}

function toNumberId(id: number | bigint): number {
  if (typeof id === "bigint") {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId)) {
      throw new Error(`SQLite row id is outside the safe integer range: ${id.toString()}`);
    }

    return numericId;
  }

  return id;
}
