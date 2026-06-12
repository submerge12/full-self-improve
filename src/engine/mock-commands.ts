import type { DocRef, RawDoc, SourceAdapter } from "./source-adapter.js";
import {
  createTraceRecorder,
  type TraceEvent,
  type TraceLevel,
  type TraceRecorder,
  type TraceStage
} from "./trace.js";

export type MockPageVisibility = "private" | "public";
export type ConceptEdgeKind = "prerequisite" | "related" | "part_of";
export type PlanActivityType = "learn" | "quiz" | "teachback";
export type QuizVerdict = "correct" | "incorrect";

export interface MockIngestOptions {
  runId?: string;
  trace?: TraceRecorder;
}

export interface MockIngestSource {
  id: string;
  adapterId: string;
  kind: string;
  path: string;
  title: string;
  fingerprint: string;
  metadata: Record<string, unknown>;
}

export interface MockChunk {
  id: string;
  sourceId: string;
  seq: number;
  heading: string;
  level: number;
  text: string;
}

export interface MockConcept {
  slug: string;
  name: string;
  summary: string;
  sourceIds: string[];
  chunkIds: string[];
  prerequisites: string[];
}

export interface MockConceptEdge {
  from: string;
  to: string;
  kind: ConceptEdgeKind;
  weight?: number;
}

export interface MockPage {
  slug: string;
  title: string;
  markdown: string;
  citations: string[];
  visibility: MockPageVisibility;
}

export interface MockIngestResult {
  runId: string;
  sources: MockIngestSource[];
  chunks: MockChunk[];
  concepts: MockConcept[];
  edges: MockConceptEdge[];
  pages: MockPage[];
  traceEvents: TraceEvent[];
}

export interface PlanConceptInput {
  slug: string;
  name: string;
  summary?: string;
  prerequisites?: string[];
  mastery?: number;
}

export interface DailyPlanInput {
  concepts: PlanConceptInput[];
  date: string | Date;
  edges?: MockConceptEdge[];
  runId?: string;
  trace?: TraceRecorder;
}

export interface DailyPlanActivity {
  id: string;
  order: number;
  type: PlanActivityType;
  conceptSlug: string;
  conceptName: string;
}

export interface DailyPlan {
  runId: string;
  date: string;
  queue: DailyPlanActivity[];
  rationale: string;
  traceEvents: TraceEvent[];
}

export interface ExactAnswerSpec {
  type: "exact";
  answers: string[];
  caseSensitive?: boolean;
  trim?: boolean;
}

export interface QuizItemInput {
  id: string;
  conceptSlug: string;
  prompt?: string;
  answer?: string | string[];
  answerSpec?: ExactAnswerSpec;
}

export interface GradeQuizAttemptInput {
  item: QuizItemInput;
  response: string;
  runId?: string;
  trace?: TraceRecorder;
}

export interface QuizGradeResult {
  runId: string;
  itemId: string;
  conceptSlug: string;
  response: string;
  verdict: QuizVerdict;
  masteryDelta: number;
  gradingMethod: "exact";
  traceEvents: TraceEvent[];
}

interface HeadingSection {
  heading: string;
  level: number;
  text: string;
}

interface TraceContext {
  runId: string;
  recorder: TraceRecorder;
}

export async function runMockIngest(adapter: SourceAdapter, options: MockIngestOptions = {}): Promise<MockIngestResult> {
  const trace = createTraceContext(options.runId ?? `mock-ingest-${slugify(adapter.id)}`, options.trace);
  const sources: MockIngestSource[] = [];
  const chunks: MockChunk[] = [];
  const conceptsBySlug = new Map<string, MockConcept>();
  const pendingEdges: MockConceptEdge[] = [];

  for await (const ref of adapter.listDocuments()) {
    const rawDoc = await adapter.readDocument(ref);
    const source = createMockSource(adapter, rawDoc, ref);
    sources.push(source);

    const sections = splitHeadingSections(rawDoc);
    for (const [sectionIndex, section] of sections.entries()) {
      const chunk: MockChunk = {
        id: `${source.id}#chunk-${sectionIndex + 1}`,
        sourceId: source.id,
        seq: sectionIndex + 1,
        heading: section.heading,
        level: section.level,
        text: section.text
      };
      chunks.push(chunk);
      record(trace, "chunk", "Created mock heading chunk.", {
        sourceId: source.id,
        chunkId: chunk.id,
        heading: chunk.heading
      });

      const candidate = createConceptCandidate(rawDoc, source, chunk);
      record(trace, "extract", "Extracted mock concept candidate from heading.", {
        sourceId: source.id,
        chunkId: chunk.id,
        slug: candidate.slug,
        name: candidate.name
      });

      const existingConcept = conceptsBySlug.get(candidate.slug);
      if (existingConcept === undefined) {
        conceptsBySlug.set(candidate.slug, candidate);
        record(trace, "merge", "Created mock concept.", {
          slug: candidate.slug,
          chunkId: chunk.id
        });
      } else {
        mergeConcept(existingConcept, candidate);
        record(trace, "merge", "Merged mock concept candidate.", {
          slug: candidate.slug,
          chunkId: chunk.id
        });
      }

      for (const prerequisite of candidate.prerequisites) {
        pendingEdges.push({
          from: prerequisite,
          to: candidate.slug,
          kind: "prerequisite",
          weight: 1
        });
      }
    }

    for (const link of rawDoc.links) {
      const linkedSlug = slugify(link);
      for (const concept of conceptsBySlug.values()) {
        if (concept.sourceIds.includes(source.id) && concept.slug !== linkedSlug) {
          pendingEdges.push({
            from: concept.slug,
            to: linkedSlug,
            kind: "related",
            weight: 0.5
          });
        }
      }
    }
  }

  const concepts = [...conceptsBySlug.values()].sort(compareConcepts);
  const conceptSlugs = new Set(concepts.map((concept) => concept.slug));
  const edges = uniqueEdges(pendingEdges).filter((edge) => conceptSlugs.has(edge.from) && conceptSlugs.has(edge.to));

  if (edges.length === 0) {
    record(trace, "link", "No mock concept links were available.", {
      conceptCount: concepts.length
    });
  } else {
    for (const edge of edges) {
      record(trace, "link", "Linked mock concepts.", edge);
    }
  }

  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const pages = concepts.map((concept) => {
    const page = createMockPage(concept, chunkById);
    record(trace, "page-gen", "Generated mock page from concept chunks.", {
      slug: page.slug,
      citations: page.citations
    });
    return page;
  });

  return {
    runId: trace.runId,
    sources,
    chunks,
    concepts,
    edges,
    pages,
    traceEvents: trace.recorder.getEvents({ runId: trace.runId })
  };
}

export function createDailyPlan(input: DailyPlanInput): DailyPlan {
  const date = normalizeDate(input.date);
  const trace = createTraceContext(input.runId ?? `mock-plan-${date}`, input.trace, `${date}T00:00:00.000Z`);
  const concepts = dedupePlanConcepts(input.concepts);
  const prerequisitesBySlug = buildPrerequisiteMap(concepts, input.edges ?? []);
  const orderedConcepts = orderConcepts(concepts, prerequisitesBySlug, date);
  const queue = createPlanQueue(orderedConcepts, date);

  record(trace, "plan", "Created deterministic mock daily plan.", {
    date,
    conceptCount: orderedConcepts.length,
    activityCount: queue.length
  });

  return {
    runId: trace.runId,
    date,
    queue,
    rationale: `Mock plan for ${date}: learn, quiz, and teach back ${orderedConcepts.length} concepts in prerequisite order.`,
    traceEvents: trace.recorder.getEvents({ runId: trace.runId })
  };
}

export function gradeQuizAttempt(input: GradeQuizAttemptInput): QuizGradeResult {
  const trace = createTraceContext(input.runId ?? `mock-grade-${slugify(input.item.id)}`, input.trace);
  const answerSpec = toExactAnswerSpec(input.item);
  const normalizedResponse = normalizeAnswer(input.response, answerSpec);
  const verdict = answerSpec.answers.some((answer) => normalizeAnswer(answer, answerSpec) === normalizedResponse)
    ? "correct"
    : "incorrect";
  const masteryDelta = verdict === "correct" ? 0.1 : -0.05;

  record(trace, "grade", "Graded mock exact-match quiz attempt.", {
    itemId: input.item.id,
    conceptSlug: input.item.conceptSlug,
    verdict,
    masteryDelta,
    gradingMethod: "exact"
  });

  return {
    runId: trace.runId,
    itemId: input.item.id,
    conceptSlug: input.item.conceptSlug,
    response: input.response,
    verdict,
    masteryDelta,
    gradingMethod: "exact",
    traceEvents: trace.recorder.getEvents({ runId: trace.runId })
  };
}

function createTraceContext(runId: string, recorder?: TraceRecorder, timestamp = "1970-01-01T00:00:00.000Z"): TraceContext {
  return {
    runId,
    recorder: recorder ?? createTraceRecorder({ now: () => new Date(timestamp) })
  };
}

function record(context: TraceContext, stage: TraceStage, message: string, data: unknown, level: TraceLevel = "info"): void {
  context.recorder.record({
    runId: context.runId,
    stage,
    level,
    message,
    data
  });
}

function createMockSource(adapter: SourceAdapter, rawDoc: RawDoc, ref: DocRef): MockIngestSource {
  return {
    id: rawDoc.ref.id,
    adapterId: adapter.id,
    kind: adapter.kind,
    path: rawDoc.ref.path,
    title: rawDoc.ref.title,
    fingerprint: adapter.fingerprint(ref),
    metadata: cloneRecord(rawDoc.metadata)
  };
}

function splitHeadingSections(rawDoc: RawDoc): HeadingSection[] {
  const normalized = rawDoc.text.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return [
      {
        heading: rawDoc.ref.title,
        level: 1,
        text: ""
      }
    ];
  }

  const sections: HeadingSection[] = [];
  let current: { heading: string; level: number; lines: string[] } | undefined;

  for (const line of normalized.split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      if (current !== undefined) {
        sections.push(toHeadingSection(current));
      }

      current = {
        heading: heading[2].trim(),
        level: heading[1].length,
        lines: []
      };
      continue;
    }

    if (current !== undefined) {
      current.lines.push(line);
    }
  }

  if (current !== undefined) {
    sections.push(toHeadingSection(current));
  }

  if (sections.length > 0) {
    return sections;
  }

  return [
    {
      heading: rawDoc.ref.title,
      level: 1,
      text: normalized
    }
  ];
}

function toHeadingSection(section: { heading: string; level: number; lines: string[] }): HeadingSection {
  return {
    heading: section.heading,
    level: section.level,
    text: section.lines.join("\n").trim()
  };
}

function createConceptCandidate(rawDoc: RawDoc, source: MockIngestSource, chunk: MockChunk): MockConcept {
  const prerequisiteSlugs = [
    ...metadataPrerequisites(rawDoc.metadata),
    ...summaryPrerequisites(chunk.text)
  ];

  return {
    slug: slugify(chunk.heading),
    name: chunk.heading,
    summary: createSummary(chunk),
    sourceIds: [source.id],
    chunkIds: [chunk.id],
    prerequisites: uniqueStrings(prerequisiteSlugs)
  };
}

function createSummary(chunk: MockChunk): string {
  const sentence = firstSentence(chunk.text);
  return sentence.length > 0 ? `${chunk.heading}: ${sentence}` : `Mock concept extracted from heading "${chunk.heading}".`;
}

function firstSentence(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return "";
  }

  const sentence = /^[^.?!]+[.?!]/.exec(compact);
  return sentence === null ? compact : sentence[0];
}

function mergeConcept(target: MockConcept, candidate: MockConcept): void {
  target.sourceIds = uniqueStrings([...target.sourceIds, ...candidate.sourceIds]);
  target.chunkIds = uniqueStrings([...target.chunkIds, ...candidate.chunkIds]);
  target.prerequisites = uniqueStrings([...target.prerequisites, ...candidate.prerequisites]);
}

function createMockPage(concept: MockConcept, chunkById: Map<string, MockChunk>): MockPage {
  const citedChunks = concept.chunkIds.map((chunkId) => chunkById.get(chunkId)).filter(isDefined);
  const body = citedChunks.map((chunk) => chunk.text).filter((text) => text.length > 0).join("\n\n");

  return {
    slug: concept.slug,
    title: concept.name,
    markdown: [`# ${concept.name}`, "", concept.summary, "", body, "", `Citations: ${concept.chunkIds.join(", ")}`]
      .filter((part) => part.length > 0)
      .join("\n"),
    citations: [...concept.chunkIds],
    visibility: "private"
  };
}

function dedupePlanConcepts(concepts: PlanConceptInput[]): PlanConceptInput[] {
  const bySlug = new Map<string, PlanConceptInput>();

  for (const concept of concepts) {
    if (!bySlug.has(concept.slug)) {
      bySlug.set(concept.slug, {
        ...concept,
        prerequisites: concept.prerequisites === undefined ? undefined : [...concept.prerequisites]
      });
    }
  }

  return [...bySlug.values()];
}

function buildPrerequisiteMap(concepts: PlanConceptInput[], edges: MockConceptEdge[]): Map<string, Set<string>> {
  const conceptSlugs = new Set(concepts.map((concept) => concept.slug));
  const prerequisitesBySlug = new Map<string, Set<string>>();

  for (const concept of concepts) {
    prerequisitesBySlug.set(concept.slug, new Set<string>());

    for (const prerequisite of concept.prerequisites ?? []) {
      addPrerequisite(prerequisitesBySlug, concept.slug, slugify(prerequisite), conceptSlugs);
    }

    for (const prerequisite of summaryPrerequisites(concept.summary ?? "")) {
      addPrerequisite(prerequisitesBySlug, concept.slug, prerequisite, conceptSlugs);
    }
  }

  for (const edge of edges) {
    if (edge.kind === "prerequisite") {
      addPrerequisite(prerequisitesBySlug, edge.to, edge.from, conceptSlugs);
    }
  }

  return prerequisitesBySlug;
}

function addPrerequisite(
  prerequisitesBySlug: Map<string, Set<string>>,
  conceptSlug: string,
  prerequisiteSlug: string,
  knownConceptSlugs: Set<string>
): void {
  if (knownConceptSlugs.has(conceptSlug) && knownConceptSlugs.has(prerequisiteSlug) && prerequisiteSlug !== conceptSlug) {
    prerequisitesBySlug.get(conceptSlug)?.add(prerequisiteSlug);
  }
}

function orderConcepts(
  concepts: PlanConceptInput[],
  prerequisitesBySlug: Map<string, Set<string>>,
  date: string
): PlanConceptInput[] {
  const bySlug = new Map(concepts.map((concept) => [concept.slug, concept]));
  const remaining = new Set(bySlug.keys());
  const ordered: PlanConceptInput[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((slug) => [...(prerequisitesBySlug.get(slug) ?? [])].every((prerequisite) => !remaining.has(prerequisite)))
      .sort((left, right) => compareByDateRank(date, left, right));

    if (ready.length === 0) {
      const cycleRemainder = [...remaining].sort((left, right) => left.localeCompare(right, "en"));
      for (const slug of cycleRemainder) {
        const concept = bySlug.get(slug);
        if (concept !== undefined) {
          ordered.push(concept);
        }
        remaining.delete(slug);
      }
      continue;
    }

    for (const slug of ready) {
      const concept = bySlug.get(slug);
      if (concept !== undefined) {
        ordered.push(concept);
      }
      remaining.delete(slug);
    }
  }

  return ordered;
}

function createPlanQueue(concepts: PlanConceptInput[], date: string): DailyPlanActivity[] {
  const activityTypes: PlanActivityType[] = ["learn", "quiz", "teachback"];
  const queue: DailyPlanActivity[] = [];

  for (const concept of concepts) {
    for (const type of activityTypes) {
      queue.push({
        id: `${date}-${type}-${concept.slug}`,
        order: queue.length + 1,
        type,
        conceptSlug: concept.slug,
        conceptName: concept.name
      });
    }
  }

  return queue;
}

function toExactAnswerSpec(item: QuizItemInput): ExactAnswerSpec {
  if (item.answerSpec !== undefined) {
    if (item.answerSpec.answers.length === 0) {
      throw new Error(`Exact-match grading requires at least one answer for item ${item.id}.`);
    }

    return {
      ...item.answerSpec,
      answers: validateExactAnswers(item.id, item.answerSpec.answers, item.answerSpec.trim)
    };
  }

  const answers = Array.isArray(item.answer) ? item.answer : item.answer === undefined ? [] : [item.answer];
  if (answers.length === 0) {
    throw new Error(`Exact-match grading requires at least one answer for item ${item.id}.`);
  }

  return {
    type: "exact",
    answers: validateExactAnswers(item.id, answers)
  };
}

function validateExactAnswers(itemId: string, answers: string[], trim = true): string[] {
  for (const answer of answers) {
    const comparable = trim === false ? answer : answer.trim();
    if (comparable.length === 0) {
      throw new Error(`Exact-match grading requires each answer to be a non-empty answer for item ${itemId}.`);
    }
  }

  return [...answers];
}

function normalizeAnswer(answer: string, spec: ExactAnswerSpec): string {
  const trimmed = spec.trim === false ? answer : answer.trim();
  return spec.caseSensitive === true ? trimmed : trimmed.toLocaleLowerCase("en-US");
}

function metadataPrerequisites(metadata: Record<string, unknown>): string[] {
  return ["prerequisite", "prerequisites"]
    .flatMap((key) => stringsFromUnknown(metadata[key]))
    .map((value) => slugify(value));
}

function summaryPrerequisites(summary: string): string[] {
  const match = /(?:prerequisites?|requires):\s*([^.;\n]+)/i.exec(summary);
  if (match === null) {
    return [];
  }

  return splitList(match[1]).map((value) => slugify(value));
}

function stringsFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return splitList(value);
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").flatMap(splitList);
  }

  return [];
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueEdges(edges: MockConceptEdge[]): MockConceptEdge[] {
  const byKey = new Map<string, MockConceptEdge>();

  for (const edge of edges) {
    byKey.set(`${edge.kind}:${edge.from}:${edge.to}`, edge);
  }

  return [...byKey.values()].sort((left, right) => {
    const kindOrder = left.kind.localeCompare(right.kind, "en");
    if (kindOrder !== 0) {
      return kindOrder;
    }

    const fromOrder = left.from.localeCompare(right.from, "en");
    return fromOrder !== 0 ? fromOrder : left.to.localeCompare(right.to, "en");
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function compareConcepts(left: MockConcept, right: MockConcept): number {
  return left.slug.localeCompare(right.slug, "en");
}

function compareByDateRank(date: string, left: string, right: string): number {
  const leftRank = stableHash(`${date}:${left}`);
  const rightRank = stableHash(`${date}:${right}`);
  return leftRank === rightRank ? left.localeCompare(right, "en") : leftRank - rightRank;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function normalizeDate(date: string | Date): string {
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid plan date.");
    }

    return date.toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid plan date: ${date}.`);
    }

    return date;
  }

  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid plan date: ${date}.`);
  }

  return parsed.toISOString().slice(0, 10);
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "concept";
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return globalThis.structuredClone(record);
}
