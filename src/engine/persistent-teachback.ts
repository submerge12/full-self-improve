import type Database from "better-sqlite3";

import { recordMasteryUpdate, type MasteryRecord } from "../db/content-store.js";
import { createTraceRecorder, type TraceEvent, type TraceRecorder } from "./trace.js";

export interface GradePersistentTeachbackInput {
  conceptSlug: string;
  transcript: string;
  runId?: string;
  trace?: TraceRecorder;
  lastSeenAt?: string;
}

export interface TeachbackRubricPageReference {
  id: number;
  version: number;
  conceptSlug: string;
  citationIds: number[];
}

export interface TeachbackRubricReport {
  score: number;
  gaps: string[];
  page: TeachbackRubricPageReference;
  gradingMethod: "rubric";
  matchedKeywords: string[];
  missingKeywords: string[];
}

export interface PersistentTeachbackGradeResult {
  runId: string;
  teachbackId: number;
  conceptSlug: string;
  transcript: string;
  rubricReport: TeachbackRubricReport;
  masteryDelta: number;
  gradingMethod: "rubric";
  mastery: MasteryRecord;
  traceEvents: TraceEvent[];
}

interface ConceptRow {
  id: number;
  slug: string;
}

interface LatestPageRow {
  id: number;
  version: number;
  markdown: string;
  citations: string;
}

interface MasteryScoreRow {
  score: number;
}

export function gradePersistentTeachback(
  db: Database.Database,
  input: GradePersistentTeachbackInput
): PersistentTeachbackGradeResult {
  const conceptSlug = requiredConceptSlug(input.conceptSlug);
  const runId = input.runId ?? `persistent-teachback-${conceptSlug}`;
  const trace = input.trace ?? createTraceRecorder();
  const transcript = requiredTranscript(input.transcript);
  const grade = db.transaction(() => runTeachbackGrade(db, input, conceptSlug, runId, trace, transcript))();

  return {
    ...grade,
    traceEvents: trace.getEvents({ runId })
  };
}

function runTeachbackGrade(
  db: Database.Database,
  input: GradePersistentTeachbackInput,
  conceptSlug: string,
  runId: string,
  trace: TraceRecorder,
  transcript: string
): Omit<PersistentTeachbackGradeResult, "traceEvents"> {
  const concept = getConceptBySlug(db, conceptSlug);
  const page = getLatestPageForConcept(db, concept);
  const rubricReport = gradeTranscriptAgainstPage(concept, page, transcript);
  const teachbackId = insertTeachback(db, concept.id, transcript, rubricReport);
  const masteryDelta = masteryDeltaForScore(rubricReport.score);
  const nextScore = clampUnitInterval(currentMasteryScore(db, concept.id) + masteryDelta);
  const mastery = updateTeachbackMastery(db, input, runId, trace, concept.id, nextScore, rubricReport.score);

  recordTeachbackTrace(trace, runId, {
    outcome: "accepted",
    teachbackId,
    conceptSlug: concept.slug,
    score: rubricReport.score,
    masteryDelta,
    page: rubricReport.page,
    gaps: rubricReport.gaps
  });

  return createTeachbackResult(runId, teachbackId, concept.slug, transcript, rubricReport, masteryDelta, mastery);
}

function updateTeachbackMastery(
  db: Database.Database,
  input: GradePersistentTeachbackInput,
  runId: string,
  trace: TraceRecorder,
  conceptId: number,
  nextScore: number,
  rubricScore: number
): MasteryRecord {
  return recordMasteryUpdate(
    db,
    {
      conceptId,
      score: nextScore,
      confidence: confidenceForScore(rubricScore),
      lastSeenAt: input.lastSeenAt
    },
    { traceRecorder: trace, runId }
  );
}

function createTeachbackResult(
  runId: string,
  teachbackId: number,
  conceptSlug: string,
  transcript: string,
  rubricReport: TeachbackRubricReport,
  masteryDelta: number,
  mastery: MasteryRecord
): Omit<PersistentTeachbackGradeResult, "traceEvents"> {
  return {
    runId,
    teachbackId,
    conceptSlug,
    transcript,
    rubricReport,
    masteryDelta,
    gradingMethod: "rubric",
    mastery
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

function gradeTranscriptAgainstPage(
  concept: ConceptRow,
  page: LatestPageRow,
  transcript: string
): TeachbackRubricReport {
  const pageKeywords = extractKeywords(page.markdown);
  if (pageKeywords.length === 0) {
    throw new Error(`Page ${page.id} has no extractable rubric keywords.`);
  }

  const transcriptKeywords = new Set(extractKeywords(transcript));
  const matchedKeywords = pageKeywords.filter((keyword) => transcriptKeywords.has(keyword));
  const missingKeywords = pageKeywords.filter((keyword) => !transcriptKeywords.has(keyword));
  const score = roundUnit(matchedKeywords.length / pageKeywords.length);
  const gaps = missingKeywords.map((keyword) => `Missing page idea: ${keyword}`);

  return {
    score,
    gaps,
    page: {
      id: page.id,
      version: page.version,
      conceptSlug: concept.slug,
      citationIds: parseCitationIds(page)
    },
    gradingMethod: "rubric",
    matchedKeywords,
    missingKeywords
  };
}

function insertTeachback(
  db: Database.Database,
  conceptId: number,
  transcript: string,
  rubricReport: TeachbackRubricReport
): number {
  const result = db
    .prepare(
      `INSERT INTO teachbacks (concept_id, transcript, rubric_report)
       VALUES (?, ?, ?)`
    )
    .run(conceptId, transcript, JSON.stringify(rubricReport));

  return toNumberId(result.lastInsertRowid);
}

function requiredTranscript(transcript: string): string {
  if (typeof transcript !== "string") {
    throw new Error("Persistent teach-back grading requires a non-empty transcript.");
  }

  const trimmed = transcript.trim();
  if (trimmed.length === 0) {
    throw new Error("Persistent teach-back grading requires a non-empty transcript.");
  }

  return trimmed;
}

function requiredConceptSlug(conceptSlug: string): string {
  if (typeof conceptSlug !== "string") {
    throw new Error("Persistent teach-back grading requires a non-empty concept slug.");
  }

  const trimmed = conceptSlug.trim();
  if (trimmed.length === 0) {
    throw new Error("Persistent teach-back grading requires a non-empty concept slug.");
  }

  return trimmed;
}

function parseCitationIds(page: LatestPageRow): number[] {
  const parsed = JSON.parse(page.citations) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error(`Page ${page.id} citations must be an array.`);
  }

  return parsed.map((citationId) => {
    if (!isValidCitationId(citationId)) {
      throw new Error(`Page ${page.id} contains an invalid citation id.`);
    }

    return citationId;
  });
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

function masteryDeltaForScore(score: number): number {
  if (score >= 0.8) {
    return 0.12;
  }

  if (score >= 0.6) {
    return 0.06;
  }

  if (score >= 0.4) {
    return 0;
  }

  return -0.05;
}

function confidenceForScore(score: number): number {
  return score >= 0.6 ? 0.8 : 0.4;
}

function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const rawKeyword of text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const keyword of keywordsFromRun(rawKeyword)) {
      if (!isUsableKeyword(keyword) || seen.has(keyword)) {
        continue;
      }

      seen.add(keyword);
      keywords.push(keyword);
    }
  }

  return keywords;
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

function recordTeachbackTrace(
  trace: TraceRecorder,
  runId: string,
  data: Record<string, unknown>
): void {
  trace.record({
    runId,
    stage: "grade",
    level: "info",
    message: "Teachback graded",
    data
  });
}

function clampUnitInterval(value: number): number {
  return roundUnit(Math.min(1, Math.max(0, value)));
}

function roundUnit(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function isValidCitationId(citationId: unknown): citationId is number {
  return typeof citationId === "number" && Number.isSafeInteger(citationId) && citationId > 0;
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
