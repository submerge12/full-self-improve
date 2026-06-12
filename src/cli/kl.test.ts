import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createConcept, type ConceptStatus } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { handleKlCommand, type KlCommandResult, type KlPersistentQuizCommandResult } from "./kl.js";

function createCapture(): { sink: { write(chunk: string | Uint8Array): boolean }; text(): string } {
  let output = "";

  return {
    sink: {
      write(chunk: string | Uint8Array): boolean {
        output += chunk.toString();
        return true;
      }
    },
    text(): string {
      return output;
    }
  };
}

function parseCapturedJson(capture: { text(): string }): KlCommandResult {
  return JSON.parse(capture.text()) as KlCommandResult;
}

type CountableTable = "sources" | "chunks" | "concepts" | "pages" | "study_plans" | "items" | "attempts" | "mastery";

function countRows(dbPath: string, table: CountableTable): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function createPlanDb(concepts: Array<{ slug: string; name: string; status?: ConceptStatus }>): string {
  const dbDir = mkdtempSync(path.join(tmpdir(), "kl-cli-plan-db-"));
  const dbPath = path.join(dbDir, "knowledge-loop.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    for (const concept of concepts) {
      createConcept(db, concept);
    }
  } finally {
    db.close();
  }

  return dbPath;
}

function readQuizRows(dbPath: string): {
  items: Array<{ id: number; conceptSlug: string; statement: string; answerSpec: unknown }>;
  attempts: Array<{ id: number; itemId: number; response: string; verdict: string; gradingMethod: string }>;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const items = db
      .prepare(
        `SELECT
           items.id,
           concepts.slug AS conceptSlug,
           items.statement,
           items.answer_spec AS answerSpec
         FROM items
         INNER JOIN concepts ON concepts.id = items.concept_id
         ORDER BY items.id`
      )
      .all() as Array<{ id: number; conceptSlug: string; statement: string; answerSpec: string }>;
    const attempts = db
      .prepare(
        `SELECT id, item_id AS itemId, response, verdict, grading_method AS gradingMethod
         FROM attempts
         ORDER BY id`
      )
      .all() as Array<{ id: number; itemId: number; response: string; verdict: string; gradingMethod: string }>;

    return {
      items: items.map((item) => ({
        ...item,
        answerSpec: JSON.parse(item.answerSpec) as unknown
      })),
      attempts
    };
  } finally {
    db.close();
  }
}

describe("kl CLI handler", () => {
  test("ingest reads a markdown vault in mock mode and writes JSON", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    writeFileSync(
      path.join(vaultDir, "Learning.md"),
      [
        "---",
        "title: Learning Loop",
        "---",
        "# Alpha Concept",
        "Alpha concept body links to [[Beta Concept]]."
      ].join("\n"),
      "utf8"
    );
    const stdout = createCapture();

    const result = await handleKlCommand(["ingest", "--vault", vaultDir], { stdout: stdout.sink });

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("ingest");
    expect(result.mode).toBe("mock");
    if (result.command !== "ingest" || result.mode !== "mock") {
      throw new Error("Expected mock ingest result.");
    }
    expect(result.result.sources).toHaveLength(1);
    expect(result.result.sources[0]?.title).toBe("Learning Loop");
    expect(result.result.concepts.map((concept) => concept.slug)).toContain("alpha-concept");
  });

  test("ingest with a db persists sources and becomes a no-op on the second run", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    const dbPath = path.join(vaultDir, "knowledge-loop.db");
    writeFileSync(
      path.join(vaultDir, "Learning.md"),
      [
        "---",
        "title: Persistent Learning",
        "---",
        "# Alpha Concept",
        "Alpha concept body links to [[Beta Concept]].",
        "# Beta Concept",
        "Beta concept body."
      ].join("\n"),
      "utf8"
    );
    const firstStdout = createCapture();
    const secondStdout = createCapture();

    const first = await handleKlCommand(["ingest", "--vault", vaultDir, "--db", dbPath], { stdout: firstStdout.sink });
    const second = await handleKlCommand(["ingest", "--vault", vaultDir, "--db", dbPath], { stdout: secondStdout.sink });

    expect(parseCapturedJson(firstStdout)).toEqual(first);
    expect(parseCapturedJson(secondStdout)).toEqual(second);
    expect(first.command).toBe("ingest");
    expect(second.command).toBe("ingest");
    expect(first.mode).toBe("mock-persistent");
    expect(second.mode).toBe("mock-persistent");
    if (
      first.command !== "ingest" ||
      first.mode !== "mock-persistent" ||
      second.command !== "ingest" ||
      second.mode !== "mock-persistent"
    ) {
      throw new Error("Expected persistent ingest results.");
    }
    expect(first.result).toMatchObject({
      sourcesSeen: 1,
      sourcesProcessed: 1,
      sourcesSkipped: 0,
      chunksCreated: 2,
      conceptsCreated: 2,
      pagesCreated: 2
    });
    expect(second.result).toMatchObject({
      sourcesSeen: 1,
      sourcesProcessed: 0,
      sourcesSkipped: 1,
      chunksCreated: 0,
      conceptsCreated: 0,
      pagesCreated: 0
    });
    expect(countRows(dbPath, "sources")).toBe(1);
    expect(countRows(dbPath, "chunks")).toBe(2);
    expect(countRows(dbPath, "concepts")).toBe(2);
    expect(countRows(dbPath, "pages")).toBe(2);
  });

  test("ingest requires exactly one db path when db is provided", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    const firstDbPath = path.join(vaultDir, "first.db");
    const secondDbPath = path.join(vaultDir, "second.db");
    writeFileSync(path.join(vaultDir, "Learning.md"), "# Alpha Concept\nAlpha concept body.", "utf8");

    await expect(
      handleKlCommand(["ingest", "--vault", vaultDir, "--db", firstDbPath, "--db", secondDbPath])
    ).rejects.toThrow(/requires exactly one --db/);
  });

  test("ingest requires a db value when db is provided", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    writeFileSync(path.join(vaultDir, "Learning.md"), "# Alpha Concept\nAlpha concept body.", "utf8");

    await expect(handleKlCommand(["ingest", "--vault", vaultDir, "--db"])).rejects.toThrow(
      /Option --db for ingest requires a value/
    );
  });

  test("ingest rejects unknown options", async () => {
    const vaultDir = mkdtempSync(path.join(tmpdir(), "kl-cli-vault-"));
    writeFileSync(path.join(vaultDir, "Learning.md"), "# Alpha Concept\nAlpha concept body.", "utf8");

    await expect(handleKlCommand(["ingest", "--vault", vaultDir, "--bogus", "1"])).rejects.toThrow(
      /Unknown option for ingest: --bogus/
    );
  });

  test("plan returns deterministic mock output for a date and repeated concepts", async () => {
    const argv = [
      "plan",
      "--date",
      "2026-06-12",
      "--concept",
      "alpha:Alpha Concept",
      "--concept",
      "beta:Beta Concept"
    ];
    const firstStdout = createCapture();
    const secondStdout = createCapture();

    const first = await handleKlCommand(argv, { stdout: firstStdout.sink });
    const second = await handleKlCommand(argv, { stdout: secondStdout.sink });

    expect(parseCapturedJson(firstStdout)).toEqual(first);
    expect(first).toEqual(second);
    expect(first.command).toBe("plan");
    expect(second.command).toBe("plan");
    expect(first.mode).toBe("mock");
    expect(second.mode).toBe("mock");
    if (first.command !== "plan" || second.command !== "plan") {
      throw new Error("Expected plan results.");
    }
    expect(first.result.date).toBe("2026-06-12");
    expect(first.result.queue).toHaveLength(6);
    expect(first.result.queue.map((activity) => activity.id)).toEqual(second.result.queue.map((activity) => activity.id));
  });

  test("plan with a db creates a persistent study plan and writes JSON", async () => {
    const dbPath = createPlanDb([
      { slug: "algebra", name: "Algebra", status: "generated" },
      { slug: "geometry", name: "Geometry", status: "reviewed" }
    ]);
    const stdout = createCapture();

    const result = await handleKlCommand(["plan", "--date", "2026-06-12", "--db", dbPath], { stdout: stdout.sink });

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("plan");
    expect(result.mode).toBe("mock-persistent");
    if (result.command !== "plan" || result.mode !== "mock-persistent") {
      throw new Error("Expected persistent plan result.");
    }
    expect(result.result.date).toBe("2026-06-12");
    expect(result.result.status).toBe("planned");
    expect(result.result.queue).toHaveLength(6);
    expect(result.result.queue.map((activity) => activity.conceptSlug)).toEqual(
      expect.arrayContaining(["algebra", "geometry"])
    );
    expect(countRows(dbPath, "study_plans")).toBe(1);
  });

  test("plan with a db reuses the existing study plan for the same date", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);

    const first = await handleKlCommand(["plan", "--date", "2026-06-13", "--db", dbPath]);
    const second = await handleKlCommand(["plan", "--date", "2026-06-13", "--db", dbPath]);

    expect(first.command).toBe("plan");
    expect(second.command).toBe("plan");
    if (
      first.command !== "plan" ||
      first.mode !== "mock-persistent" ||
      second.command !== "plan" ||
      second.mode !== "mock-persistent"
    ) {
      throw new Error("Expected persistent plan results.");
    }
    expect(second.result.queue).toEqual(first.result.queue);
    expect(countRows(dbPath, "study_plans")).toBe(1);
  });

  test("plan rejects db and manual concepts together", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);

    await expect(
      handleKlCommand(["plan", "--date", "2026-06-12", "--db", dbPath, "--concept", "algebra:Algebra"])
    ).rejects.toThrow(/cannot combine --db and --concept/);
  });

  test("plan requires exactly one db path when db is provided", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(
      handleKlCommand(["plan", "--date", "2026-06-12", "--db", dbPath, "--db", otherDbPath])
    ).rejects.toThrow(/requires exactly one --db/);
  });

  test("plan requires a db value when db is provided", async () => {
    await expect(handleKlCommand(["plan", "--date", "2026-06-12", "--db"])).rejects.toThrow(
      /Option --db for plan requires a value/
    );
  });

  test("plan rejects unknown options after db options", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);

    await expect(
      handleKlCommand(["plan", "--date", "2026-06-12", "--db", dbPath, "--bogus", "1"])
    ).rejects.toThrow(/Unknown option for plan: --bogus/);
  });

  test("plan requires at least one concept", async () => {
    await expect(handleKlCommand(["plan", "--date", "2026-06-12"])).rejects.toThrow(
      /requires at least one --concept/
    );
  });

  test("quiz grades exact answers and returns verdict plus mastery delta", async () => {
    const stdout = createCapture();

    const result = await handleKlCommand(
      [
        "quiz",
        "--item",
        "capital-france",
        "--concept",
        "paris",
        "--answer",
        "Paris",
        "--response",
        " paris "
      ],
      { stdout: stdout.sink }
    );

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("quiz");
    expect(result.mode).toBe("mock");
    if (result.command !== "quiz") {
      throw new Error("Expected quiz result.");
    }
    expect(result.result.itemId).toBe("capital-france");
    expect(result.result.conceptSlug).toBe("paris");
    expect(result.result.verdict).toBe("correct");
    expect(result.result.masteryDelta).toBe(0.1);
  });

  test("quiz rejects blank exact answers in mock mode", async () => {
    await expect(
      handleKlCommand([
        "quiz",
        "--item",
        "blank-answer",
        "--concept",
        "validation",
        "--answer",
        "",
        "--response",
        ""
      ])
    ).rejects.toThrow(/non-empty answer/);
  });

  test("quiz with a db persists a correct answer attempt and returns persistent mode", async () => {
    const dbPath = createPlanDb([{ slug: "mitochondria", name: "Mitochondria", status: "generated" }]);
    const stdout = createCapture();

    const result = (await handleKlCommand(
      [
        "quiz",
        "--db",
        dbPath,
        "--item",
        "Which organelle is the powerhouse of the cell?",
        "--concept",
        "mitochondria",
        "--answer",
        "mitochondria",
        "--response",
        " mitochondria "
      ],
      { stdout: stdout.sink }
    )) as KlPersistentQuizCommandResult;

    expect(parseCapturedJson(stdout)).toEqual(result);
    expect(result.command).toBe("quiz");
    expect(result.mode).toBe("mock-persistent");
    expect(result.result).toMatchObject({
      conceptSlug: "mitochondria",
      verdict: "correct",
      masteryDelta: 0.1,
      mastery: {
        score: 0.1,
        attemptsN: 1
      }
    });
    expect(result.result.itemId).toBeGreaterThan(0);
    expect(result.result.attemptId).toBeGreaterThan(0);
    expect(readQuizRows(dbPath)).toMatchObject({
      items: [
        {
          id: result.result.itemId,
          conceptSlug: "mitochondria",
          statement: "Which organelle is the powerhouse of the cell?",
          answerSpec: { type: "exact", answers: ["mitochondria"] }
        }
      ],
      attempts: [
        {
          id: result.result.attemptId,
          itemId: result.result.itemId,
          response: " mitochondria ",
          verdict: "correct",
          gradingMethod: "exact"
        }
      ]
    });
    expect(countRows(dbPath, "mastery")).toBe(1);
  });

  test("second quiz with a db on the same concept increments mastery attempts and changes score", async () => {
    const dbPath = createPlanDb([{ slug: "photosynthesis", name: "Photosynthesis", status: "generated" }]);

    const first = (await handleKlCommand([
      "quiz",
      "--db",
      dbPath,
      "--item",
      "What gas do plants release during photosynthesis?",
      "--concept",
      "photosynthesis",
      "--answer",
      "oxygen",
      "--answer",
      "O2",
      "--response",
      "oxygen"
    ])) as KlPersistentQuizCommandResult;
    const second = (await handleKlCommand([
      "quiz",
      "--db",
      dbPath,
      "--item",
      "What gas do plants release during photosynthesis?",
      "--concept",
      "photosynthesis",
      "--answer",
      "oxygen",
      "--answer",
      "O2",
      "--response",
      "carbon dioxide"
    ])) as KlPersistentQuizCommandResult;

    expect(first.mode).toBe("mock-persistent");
    expect(second.mode).toBe("mock-persistent");
    expect(first.result.mastery).toMatchObject({ score: 0.1, attemptsN: 1 });
    expect(second.result).toMatchObject({
      verdict: "incorrect",
      masteryDelta: -0.05,
      mastery: {
        score: 0.05,
        attemptsN: 2
      }
    });
    expect(countRows(dbPath, "items")).toBe(2);
    expect(countRows(dbPath, "attempts")).toBe(2);
    expect(countRows(dbPath, "mastery")).toBe(1);
  });

  test("quiz with a db rejects a missing concept without partial quiz writes", async () => {
    const dbPath = createPlanDb([]);

    await expect(
      handleKlCommand([
        "quiz",
        "--db",
        dbPath,
        "--item",
        "Missing concept prompt",
        "--concept",
        "missing",
        "--answer",
        "yes",
        "--response",
        "yes"
      ])
    ).rejects.toThrow(/Concept missing was not found/);

    expect(countRows(dbPath, "items")).toBe(0);
    expect(countRows(dbPath, "attempts")).toBe(0);
    expect(countRows(dbPath, "mastery")).toBe(0);
  });

  test("quiz requires exactly one db path when db is provided", async () => {
    const dbPath = createPlanDb([{ slug: "algebra", name: "Algebra", status: "generated" }]);
    const otherDbPath = path.join(path.dirname(dbPath), "other.db");

    await expect(
      handleKlCommand([
        "quiz",
        "--db",
        dbPath,
        "--db",
        otherDbPath,
        "--item",
        "Algebra prompt",
        "--concept",
        "algebra",
        "--answer",
        "x",
        "--response",
        "x"
      ])
    ).rejects.toThrow(/requires exactly one --db/);
  });

  test("quiz requires a db value when db is provided", async () => {
    await expect(handleKlCommand(["quiz", "--db"])).rejects.toThrow(/Option --db for quiz requires a value/);
  });

  test("quiz rejects unknown options", async () => {
    await expect(
      handleKlCommand([
        "quiz",
        "--item",
        "capital-france",
        "--concept",
        "paris",
        "--answer",
        "Paris",
        "--response",
        "Paris",
        "--bogus",
        "1"
      ])
    ).rejects.toThrow(/Unknown option for quiz: --bogus/);
  });
});
