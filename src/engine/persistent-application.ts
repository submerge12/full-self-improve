import type Database from "better-sqlite3";

import { recordPersistentMasteryUpdate, type MasteryRecord } from "./persistent-mastery.js";
import { createTraceRecorder, type TraceEvent, type TraceRecorder } from "./trace.js";

export type ApplicationVerdict = "correct" | "partial" | "incorrect";

export interface CreatePersistentApplicationTaskInput {
  conceptSlug: string;
  difficulty?: number;
  runId?: string;
  trace?: TraceRecorder;
}

export interface ApplicationRubricPageReference {
  id: number;
  version: number;
  conceptSlug: string;
  citationIds: number[];
}

export interface ApplicationRubricAnswerSpec {
  type: "rubric";
  kind: "application";
  conceptSlug: string;
  pageId: number;
  pageVersion: number;
  citationIds: number[];
  requiredKeywords: string[];
}

export interface PersistentApplicationTaskResult {
  runId: string;
  itemId: number;
  conceptSlug: string;
  statement: string;
  difficulty: number;
  answerSpec: ApplicationRubricAnswerSpec;
  traceEvents: TraceEvent[];
}

export interface GradePersistentApplicationAttemptInput {
  itemId: number;
  response: string;
  runId?: string;
  trace?: TraceRecorder;
  lastSeenAt?: string;
}

export interface ApplicationRubricReport {
  score: number;
  gaps: string[];
  matchedKeywords: string[];
  missingKeywords: string[];
  page: ApplicationRubricPageReference;
}

export interface PersistentApplicationGradeResult {
  runId: string;
  attemptId: number;
  itemId: number;
  conceptSlug: string;
  response: string;
  verdict: ApplicationVerdict;
  gradingMethod: "rubric";
  rubricReport: ApplicationRubricReport;
  masteryDelta: number;
  mastery: MasteryRecord;
  traceEvents: TraceEvent[];
}

interface ConceptRow {
  id: number;
  slug: string;
  name: string;
}

interface LatestPageRow {
  id: number;
  version: number;
  markdown: string;
  citations: string;
}

interface ApplicationItemRow {
  id: number;
  conceptId: number;
  conceptSlug: string;
  type: string;
  answerSpec: string;
}

interface MasteryScoreRow {
  score: number;
}

interface ApplicationGrade {
  verdict: ApplicationVerdict;
  masteryDelta: number;
  confidence: number;
  rubricReport: ApplicationRubricReport;
}

export function createPersistentApplicationTask(
  db: Database.Database,
  input: CreatePersistentApplicationTaskInput
): PersistentApplicationTaskResult {
  const conceptSlug = requiredConceptSlug(input.conceptSlug);
  const runId = input.runId ?? `persistent-application-${conceptSlug}`;
  const trace = input.trace ?? createTraceRecorder();
  const difficulty = validDifficulty(input.difficulty ?? 3);

  const created = db.transaction(() => createApplicationTask(db, conceptSlug, difficulty, runId, trace))();
  return {
    ...created,
    traceEvents: trace.getEvents({ runId })
  };
}

export function gradePersistentApplicationAttempt(
  db: Database.Database,
  input: GradePersistentApplicationAttemptInput
): PersistentApplicationGradeResult {
  const itemId = validItemId(input.itemId);
  const response = requiredResponse(input.response);
  const runId = input.runId ?? `persistent-application-attempt-${itemId}`;
  const trace = input.trace ?? createTraceRecorder();

  const graded = db.transaction(() => gradeApplicationAttempt(db, input, itemId, response, runId, trace))();
  return {
    ...graded,
    traceEvents: trace.getEvents({ runId })
  };
}

function createApplicationTask(
  db: Database.Database,
  conceptSlug: string,
  difficulty: number,
  runId: string,
  trace: TraceRecorder
): Omit<PersistentApplicationTaskResult, "traceEvents"> {
  const concept = getConceptBySlug(db, conceptSlug);
  const page = getLatestPageForConcept(db, concept);
  const answerSpec = createApplicationRubric(concept, page);
  const statement = applicationStatement(concept.name);
  const itemId = insertApplicationItem(db, concept.id, statement, answerSpec, difficulty);

  recordApplicationTrace(trace, runId, "plan", "Application task generated", {
    outcome: "accepted",
    itemId,
    conceptSlug: concept.slug,
    pageId: page.id,
    pageVersion: page.version,
    difficulty,
    requiredKeywords: answerSpec.requiredKeywords
  });

  return { runId, itemId, conceptSlug: concept.slug, statement, difficulty, answerSpec };
}

function gradeApplicationAttempt(
  db: Database.Database,
  input: GradePersistentApplicationAttemptInput,
  itemId: number,
  response: string,
  runId: string,
  trace: TraceRecorder
): Omit<PersistentApplicationGradeResult, "traceEvents"> {
  const item = getApplicationItem(db, itemId);
  const answerSpec = parseApplicationRubric(item);
  const grade = gradeResponse(answerSpec, response);
  const attemptId = insertAttempt(db, item.id, response, grade.verdict);
  const nextScore = clampUnitInterval(currentMasteryScore(db, item.conceptId) + grade.masteryDelta);
  const mastery = updateApplicationMastery(db, input, runId, trace, item.conceptId, nextScore, grade.confidence);

  recordApplicationTrace(trace, runId, "grade", "Application attempt graded", {
    outcome: "accepted",
    attemptId,
    itemId: item.id,
    conceptSlug: item.conceptSlug,
    verdict: grade.verdict,
    masteryDelta: grade.masteryDelta,
    rubricReport: grade.rubricReport
  });

  return createGradeResult(runId, attemptId, item, response, grade, mastery);
}

function createApplicationRubric(concept: ConceptRow, page: LatestPageRow): ApplicationRubricAnswerSpec {
  const requiredKeywords = extractKeywords(page.markdown);
  if (requiredKeywords.length === 0) {
    throw new Error(`Page ${page.id} has no extractable application rubric keywords.`);
  }

  return {
    type: "rubric",
    kind: "application",
    conceptSlug: concept.slug,
    pageId: page.id,
    pageVersion: page.version,
    citationIds: parseCitationIds(page),
    requiredKeywords
  };
}

function createGradeResult(
  runId: string,
  attemptId: number,
  item: ApplicationItemRow,
  response: string,
  grade: ApplicationGrade,
  mastery: MasteryRecord
): Omit<PersistentApplicationGradeResult, "traceEvents"> {
  return {
    runId,
    attemptId,
    itemId: item.id,
    conceptSlug: item.conceptSlug,
    response,
    verdict: grade.verdict,
    gradingMethod: "rubric",
    rubricReport: grade.rubricReport,
    masteryDelta: grade.masteryDelta,
    mastery
  };
}

function updateApplicationMastery(
  db: Database.Database,
  input: GradePersistentApplicationAttemptInput,
  runId: string,
  trace: TraceRecorder,
  conceptId: number,
  nextScore: number,
  confidence: number
): MasteryRecord {
  return recordPersistentMasteryUpdate(db, {
    conceptId,
    score: nextScore,
    confidence,
    lastSeenAt: input.lastSeenAt,
    trace,
    runId
  });
}

function gradeResponse(answerSpec: ApplicationRubricAnswerSpec, response: string): ApplicationGrade {
  const responseKeywords = new Set(extractKeywords(response));
  const matchedKeywords = answerSpec.requiredKeywords.filter((keyword) => responseKeywords.has(keyword));
  const missingKeywords = answerSpec.requiredKeywords.filter((keyword) => !responseKeywords.has(keyword));
  const rubricReport = createRubricReport(answerSpec, matchedKeywords, missingKeywords);

  if (missingKeywords.length === 0) {
    return { verdict: "correct", masteryDelta: 0.12, confidence: 0.85, rubricReport };
  }

  if (matchedKeywords.length > 0) {
    return { verdict: "partial", masteryDelta: 0.03, confidence: 0.6, rubricReport };
  }

  return { verdict: "incorrect", masteryDelta: -0.06, confidence: 0.35, rubricReport };
}

function createRubricReport(
  answerSpec: ApplicationRubricAnswerSpec,
  matchedKeywords: string[],
  missingKeywords: string[]
): ApplicationRubricReport {
  return {
    score: roundUnit(matchedKeywords.length / answerSpec.requiredKeywords.length),
    gaps: missingKeywords.map((keyword) => `Missing application idea: ${keyword}`),
    matchedKeywords,
    missingKeywords,
    page: {
      id: answerSpec.pageId,
      version: answerSpec.pageVersion,
      conceptSlug: answerSpec.conceptSlug,
      citationIds: [...answerSpec.citationIds]
    }
  };
}

function getConceptBySlug(db: Database.Database, slug: string): ConceptRow {
  const row = db
    .prepare(
      `SELECT id, slug, name
       FROM concepts
       WHERE slug = ?`
    )
    .get(slug) as ConceptRow | undefined;

  if (row === undefined) {
    throw new Error(`Concept ${slug} was not found.`);
  }

  return row;
}

function getLatestPageForConcept(db: Database.Database, concept: ConceptRow): LatestPageRow {
  const row = db
    .prepare(
      `SELECT id, version, markdown, citations
       FROM pages
       WHERE concept_id = ?
       ORDER BY version DESC, id DESC
       LIMIT 1`
    )
    .get(concept.id) as LatestPageRow | undefined;

  if (row === undefined) {
    throw new Error(`No page was found for concept ${concept.slug}.`);
  }

  return row;
}

function getApplicationItem(db: Database.Database, itemId: number): ApplicationItemRow {
  const row = db
    .prepare(
      `SELECT
         items.id,
         items.concept_id AS conceptId,
         concepts.slug AS conceptSlug,
         items.type,
         items.answer_spec AS answerSpec
       FROM items
       INNER JOIN concepts ON concepts.id = items.concept_id
       WHERE items.id = ?`
    )
    .get(itemId) as ApplicationItemRow | undefined;

  if (row === undefined) {
    throw new Error(`Item ${itemId} was not found.`);
  }

  if (row.type !== "free_form") {
    throw new Error(`Item ${itemId} is not a free-form application item.`);
  }

  return row;
}

function insertApplicationItem(
  db: Database.Database,
  conceptId: number,
  statement: string,
  answerSpec: ApplicationRubricAnswerSpec,
  difficulty: number
): number {
  const result = db
    .prepare(
      `INSERT INTO items (concept_id, concept_ids, type, difficulty, statement, answer_spec)
       VALUES (?, ?, 'free_form', ?, ?, ?)`
    )
    .run(conceptId, JSON.stringify([conceptId]), difficulty, statement, JSON.stringify(answerSpec));

  return toNumberId(result.lastInsertRowid);
}

function insertAttempt(
  db: Database.Database,
  itemId: number,
  response: string,
  verdict: ApplicationVerdict
): number {
  const result = db
    .prepare(
      `INSERT INTO attempts (item_id, response, verdict, grading_method)
       VALUES (?, ?, ?, 'rubric')`
    )
    .run(itemId, response, verdict);

  return toNumberId(result.lastInsertRowid);
}

function parseApplicationRubric(item: ApplicationItemRow): ApplicationRubricAnswerSpec {
  const parsed = parseJsonObject(item.answerSpec, item.id);
  if (parsed.type !== "rubric" || parsed.kind !== "application") {
    throw new Error(`Item ${item.id} does not contain a valid application rubric.`);
  }

  return validateApplicationRubric(item, parsed);
}

function parseJsonObject(value: string, itemId: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Item ${itemId} does not contain a valid application rubric.`);
    }

    throw error;
  }

  if (!isRecord(parsed)) {
    throw new Error(`Item ${itemId} does not contain a valid application rubric.`);
  }

  return parsed;
}

function validateApplicationRubric(
  item: ApplicationItemRow,
  parsed: Record<string, unknown>
): ApplicationRubricAnswerSpec {
  if (parsed.conceptSlug !== item.conceptSlug) {
    throw new Error(`Item ${item.id} does not contain a valid application rubric.`);
  }

  return {
    type: "rubric",
    kind: "application",
    conceptSlug: item.conceptSlug,
    pageId: requiredPositiveInteger(parsed.pageId, item.id),
    pageVersion: requiredPositiveInteger(parsed.pageVersion, item.id),
    citationIds: requiredPositiveIntegerArray(parsed.citationIds, item.id),
    requiredKeywords: requiredKeywordArray(parsed.requiredKeywords, item.id)
  };
}

function requiredPositiveInteger(value: unknown, itemId: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Item ${itemId} does not contain a valid application rubric.`);
  }

  return value;
}

function requiredPositiveIntegerArray(value: unknown, itemId: number): number[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0)) {
    throw new Error(`Item ${itemId} does not contain a valid application rubric.`);
  }

  return [...value];
}

function requiredKeywordArray(value: unknown, itemId: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    throw new Error(`Item ${itemId} does not contain a valid application rubric.`);
  }

  return value.map((keyword) => keyword.trim());
}

function parseCitationIds(page: LatestPageRow): number[] {
  const parsed = JSON.parse(page.citations) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Page ${page.id} citations must be an array.`);
  }

  return parsed.map((citationId) => validCitationId(page.id, citationId));
}

function validCitationId(pageId: number, citationId: unknown): number {
  if (typeof citationId !== "number" || !Number.isSafeInteger(citationId) || citationId <= 0) {
    throw new Error(`Page ${pageId} contains an invalid citation id.`);
  }

  return citationId;
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

function requiredConceptSlug(conceptSlug: string): string {
  if (typeof conceptSlug !== "string" || conceptSlug.trim().length === 0) {
    throw new Error("Persistent application task requires a non-empty concept slug.");
  }

  return conceptSlug.trim();
}

function requiredResponse(response: string): string {
  if (typeof response !== "string" || response.trim().length === 0) {
    throw new Error("Persistent application grading requires a non-empty response.");
  }

  return response;
}

function validDifficulty(difficulty: number): number {
  if (!Number.isSafeInteger(difficulty) || difficulty < 1 || difficulty > 5) {
    throw new Error("Persistent application difficulty must be an integer between 1 and 5.");
  }

  return difficulty;
}

function validItemId(itemId: number): number {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new Error("Persistent application grading requires a positive item id.");
  }

  return itemId;
}

function applicationStatement(conceptName: string): string {
  const displayName = conceptName.trim().length > 0 ? conceptName.trim() : "this concept";
  return `Apply ${displayName} to a realistic case. Explain how the idea changes decisions, name likely constraints, and describe expected feedback.`;
}

function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const rawKeyword of text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []) {
    appendKeywords(rawKeyword, seen, keywords);
  }

  return keywords;
}

function appendKeywords(rawKeyword: string, seen: Set<string>, keywords: string[]): void {
  for (const keyword of keywordsFromRun(rawKeyword)) {
    if (!isUsableKeyword(keyword) || seen.has(keyword)) {
      continue;
    }

    seen.add(keyword);
    keywords.push(keyword);
  }
}

function keywordsFromRun(rawKeyword: string): string[] {
  if (!containsHan(rawKeyword)) {
    return [normalizeKeyword(rawKeyword)];
  }

  return [
    ...(rawKeyword.match(/[a-z0-9]+/g) ?? []).map(normalizeKeyword),
    ...(rawKeyword.match(/\p{Script=Han}+/gu) ?? []).flatMap(createHanBigrams)
  ];
}

function createHanBigrams(value: string): string[] {
  const characters = Array.from(value);
  if (characters.length <= 2) {
    return [characters.join("")];
  }

  const bigrams: string[] = [];
  for (let index = 0; index < characters.length - 1; index += 1) {
    bigrams.push(characters.slice(index, index + 2).join(""));
  }

  return bigrams;
}

function isUsableKeyword(keyword: string): boolean {
  if (containsHan(keyword)) {
    return Array.from(keyword).length >= 2;
  }

  return keyword.length >= 4 && !STOP_WORDS.has(keyword);
}

function normalizeKeyword(keyword: string): string {
  if (keyword.length > 4 && keyword.endsWith("s")) {
    return keyword.slice(0, -1);
  }

  return keyword;
}

function containsHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function recordApplicationTrace(
  trace: TraceRecorder,
  runId: string,
  stage: "plan" | "grade",
  message: string,
  data: Record<string, unknown>
): void {
  trace.record({
    runId,
    stage,
    level: "info",
    message,
    data
  });
}

function clampUnitInterval(value: number): number {
  return roundUnit(Math.min(1, Math.max(0, value)));
}

function roundUnit(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "before",
  "from",
  "into",
  "over",
  "page",
  "that",
  "their",
  "this",
  "with"
]);
