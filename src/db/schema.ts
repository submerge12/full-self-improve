import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { TRACE_STAGES } from "../engine/trace.js";

export const sourceStatuses = ["pending", "ingested", "error"] as const;
export const conceptStatuses = ["stub", "generated", "reviewed"] as const;
export const conceptEdgeKinds = ["prerequisite", "related", "part_of"] as const;
export const pageVisibilities = ["private", "public"] as const;
export const itemTypes = ["mcq", "fill_in", "free_form"] as const;
export const attemptVerdicts = ["correct", "incorrect", "partial"] as const;
export const gradingMethods = ["exact", "rubric"] as const;
export const studyPlanStatuses = ["planned", "active", "completed", "skipped"] as const;
export const traceStages = TRACE_STAGES;
export const traceLevels = ["info", "warn", "error"] as const;

export const sources = sqliteTable(
  "sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    adapterId: text("adapter_id").notNull(),
    docRef: text("doc_ref").notNull(),
    title: text("title").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: sourceStatuses }).notNull().default("pending"),
    ingestedAt: text("ingested_at").notNull().default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    uniqueIndex("sources_adapter_doc_ref_unique").on(table.adapterId, table.docRef),
    index("sources_status_idx").on(table.status),
    check("sources_status_check", sql`${table.status} IN ('pending', 'ingested', 'error')`)
  ]
);

export const chunks = sqliteTable(
  "chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    meta: text("meta").notNull().default("{}")
  },
  (table) => [
    uniqueIndex("chunks_source_seq_unique").on(table.sourceId, table.seq),
    index("chunks_source_id_idx").on(table.sourceId),
    check("chunks_seq_positive_check", sql`${table.seq} > 0`),
    check("chunks_meta_json_check", sql`json_valid(${table.meta})`)
  ]
);

export const concepts = sqliteTable(
  "concepts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    summary: text("summary"),
    domain: text("domain"),
    status: text("status", { enum: conceptStatuses }).notNull().default("stub")
  },
  (table) => [
    uniqueIndex("concepts_slug_unique").on(table.slug),
    index("concepts_status_idx").on(table.status),
    check("concepts_status_check", sql`${table.status} IN ('stub', 'generated', 'reviewed')`)
  ]
);

export const conceptEdges = sqliteTable(
  "concept_edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromConceptId: integer("from_concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    toConceptId: integer("to_concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: conceptEdgeKinds }).notNull(),
    weight: real("weight").notNull().default(1)
  },
  (table) => [
    uniqueIndex("concept_edges_from_to_kind_unique").on(table.fromConceptId, table.toConceptId, table.kind),
    index("concept_edges_to_concept_id_idx").on(table.toConceptId),
    check("concept_edges_kind_check", sql`${table.kind} IN ('prerequisite', 'related', 'part_of')`),
    check("concept_edges_weight_nonnegative_check", sql`${table.weight} >= 0`)
  ]
);

export const pages = sqliteTable(
  "pages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conceptId: integer("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    markdown: text("markdown").notNull(),
    citations: text("citations").notNull().default("[]"),
    visibility: text("visibility", { enum: pageVisibilities }).notNull().default("private")
  },
  (table) => [
    uniqueIndex("pages_concept_version_unique").on(table.conceptId, table.version),
    index("pages_visibility_idx").on(table.visibility),
    check("pages_version_positive_check", sql`${table.version} > 0`),
    check("pages_visibility_check", sql`${table.visibility} IN ('private', 'public')`),
    check("pages_citations_json_array_check", sql`json_valid(${table.citations}) AND json_type(${table.citations}) = 'array'`),
    check("pages_public_requires_citation_check", sql`${table.visibility} != 'public' OR json_array_length(${table.citations}) > 0`)
  ]
);

export const items = sqliteTable(
  "items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conceptId: integer("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    conceptIds: text("concept_ids").notNull().default("[]"),
    type: text("type", { enum: itemTypes }).notNull(),
    difficulty: integer("difficulty").notNull(),
    statement: text("statement").notNull(),
    answerSpec: text("answer_spec").notNull()
  },
  (table) => [
    index("items_concept_id_idx").on(table.conceptId),
    check("items_type_check", sql`${table.type} IN ('mcq', 'fill_in', 'free_form')`),
    check("items_difficulty_range_check", sql`${table.difficulty} BETWEEN 1 AND 5`),
    check("items_concept_ids_json_array_check", sql`json_valid(${table.conceptIds}) AND json_type(${table.conceptIds}) = 'array'`),
    check("items_answer_spec_json_check", sql`json_valid(${table.answerSpec})`)
  ]
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    response: text("response").notNull(),
    verdict: text("verdict", { enum: attemptVerdicts }).notNull(),
    gradingMethod: text("grading_method", { enum: gradingMethods }).notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    index("attempts_item_id_idx").on(table.itemId),
    check("attempts_verdict_check", sql`${table.verdict} IN ('correct', 'incorrect', 'partial')`),
    check("attempts_grading_method_check", sql`${table.gradingMethod} IN ('exact', 'rubric')`)
  ]
);

export const teachbacks = sqliteTable(
  "teachbacks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conceptId: integer("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    transcript: text("transcript").notNull(),
    rubricReport: text("rubric_report").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`)
  },
  (table) => [
    index("teachbacks_concept_id_idx").on(table.conceptId),
    check("teachbacks_rubric_report_json_check", sql`json_valid(${table.rubricReport})`)
  ]
);

export const mastery = sqliteTable(
  "mastery",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conceptId: integer("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    score: real("score").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    attemptsN: integer("attempts_n").notNull().default(0),
    lastSeenAt: text("last_seen_at")
  },
  (table) => [
    uniqueIndex("mastery_concept_id_unique").on(table.conceptId),
    check("mastery_score_range_check", sql`${table.score} BETWEEN 0 AND 1`),
    check("mastery_confidence_range_check", sql`${table.confidence} BETWEEN 0 AND 1`),
    check("mastery_attempts_n_nonnegative_check", sql`${table.attemptsN} >= 0`)
  ]
);

export const studyPlans = sqliteTable(
  "study_plans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    queue: text("queue").notNull(),
    rationale: text("rationale").notNull(),
    status: text("status", { enum: studyPlanStatuses }).notNull().default("planned")
  },
  (table) => [
    uniqueIndex("study_plans_date_unique").on(table.date),
    check("study_plans_queue_json_check", sql`json_valid(${table.queue})`),
    check("study_plans_status_check", sql`${table.status} IN ('planned', 'active', 'completed', 'skipped')`)
  ]
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conceptId: integer("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    fsrsState: text("fsrs_state").notNull(),
    dueAt: text("due_at").notNull()
  },
  (table) => [
    uniqueIndex("reviews_concept_id_unique").on(table.conceptId),
    index("reviews_due_at_idx").on(table.dueAt),
    check("reviews_fsrs_state_json_check", sql`json_valid(${table.fsrsState})`)
  ]
);

export const traceEvents = sqliteTable(
  "trace_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    stage: text("stage", { enum: traceStages }).notNull(),
    level: text("level", { enum: traceLevels }).notNull(),
    message: text("message").notNull(),
    timestamp: text("timestamp").notNull(),
    data: text("data").notNull().default("null")
  },
  (table) => [
    index("trace_events_run_id_id_idx").on(table.runId, table.id),
    index("trace_events_run_id_stage_id_idx").on(table.runId, table.stage, table.id),
    check("trace_events_stage_check", sql`${table.stage} IN ('chunk', 'extract', 'merge', 'link', 'page-gen', 'plan', 'grade', 'diagnose')`),
    check("trace_events_level_check", sql`${table.level} IN ('info', 'warn', 'error')`),
    check("trace_events_data_json_check", sql`json_valid(${table.data})`)
  ]
);
