import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createConcept } from "../db/graph-store.js";
import { applyMigrations } from "../db/migrations.js";
import { recordPersistentMasteryUpdate } from "./persistent-mastery.js";
import { createTraceRecorder } from "./trace.js";

interface MasteryWriterOffense {
  file: string;
  line: number;
  kind: "store-writer" | "sql-write";
  detail: string;
}

const projectRoot = process.cwd();
const engineDir = path.join(projectRoot, "src", "engine");
const allowedWriterFile = "src/engine/persistent-mastery.ts";

describe("persistent mastery updates", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("upserts mastery through the engine writer facade and records trace context", () => {
    const concept = createConcept(db, { slug: "mastery-facade", name: "Mastery Facade", status: "generated" });
    const trace = createTraceRecorder({ now: () => new Date("2026-06-13T00:00:00.000Z") });

    const first = recordPersistentMasteryUpdate(db, {
      conceptId: concept.id,
      score: 0.25,
      confidence: 0.6,
      lastSeenAt: "2026-06-13T01:00:00.000Z",
      trace,
      runId: "persistent-mastery-facade"
    });
    const second = recordPersistentMasteryUpdate(db, {
      conceptId: concept.id,
      score: 0.5,
      confidence: 0.8,
      lastSeenAt: "2026-06-13T02:00:00.000Z",
      trace,
      runId: "persistent-mastery-facade"
    });

    expect(first).toMatchObject({
      conceptId: concept.id,
      score: 0.25,
      confidence: 0.6,
      attemptsN: 1,
      lastSeenAt: "2026-06-13T01:00:00.000Z"
    });
    expect(second).toMatchObject({
      id: first.id,
      conceptId: concept.id,
      score: 0.5,
      confidence: 0.8,
      attemptsN: 2,
      lastSeenAt: "2026-06-13T02:00:00.000Z"
    });
    expect(trace.getEvents({ runId: "persistent-mastery-facade", stage: "grade" })).toHaveLength(2);
    expect(readMastery()).toEqual([
      {
        conceptId: concept.id,
        score: 0.5,
        confidence: 0.8,
        attemptsN: 2,
        lastSeenAt: "2026-06-13T02:00:00.000Z"
      }
    ]);
  });

  function readMastery(): Array<{
    conceptId: number;
    score: number;
    confidence: number;
    attemptsN: number;
    lastSeenAt: string | null;
  }> {
    return db
      .prepare(
        `SELECT
           concept_id AS conceptId,
           score,
           confidence,
           attempts_n AS attemptsN,
           last_seen_at AS lastSeenAt
         FROM mastery
         ORDER BY concept_id`
      )
      .all() as Array<{
      conceptId: number;
      score: number;
      confidence: number;
      attemptsN: number;
      lastSeenAt: string | null;
    }>;
  }
});

describe("persistent mastery writer boundary", () => {
  test("only persistent-mastery directly calls the DB mastery writer", async () => {
    const sourceFiles = await listProductionEngineFiles(engineDir);
    const offenses = (
      await Promise.all(
        sourceFiles.map(async (filePath) => findMasteryWriterOffenses(filePath, await readFile(filePath, "utf8")))
      )
    ).flat();

    expect(formatOffenses(offenses), "direct recordMasteryUpdate usage outside persistent-mastery").toEqual([]);
  });

  test("detects direct mastery SQL writes while allowing reads", () => {
    const filePath = path.join(engineDir, "sample.ts");
    const sourceText = `
      const score = db.prepare("SELECT score FROM mastery WHERE concept_id = ?").get(id);
      db.prepare("INSERT INTO mastery (concept_id, score) VALUES (?, ?)");
      db.prepare(\`UPDATE mastery SET score = ? WHERE concept_id = ?\`);
      db.prepare("DELETE FROM mastery WHERE concept_id = ?");
      db.prepare("REPLACE INTO mastery (concept_id, score) VALUES (?, ?)");
      db.prepare(\`INSERT INTO mastery (\${columns}) VALUES (?, ?)\`);
    `;

    expect(formatOffenses(findMasteryWriterOffenses(filePath, sourceText))).toEqual([
      'src/engine/sample.ts:3 writes mastery via SQL "INSERT INTO mastery"',
      'src/engine/sample.ts:4 writes mastery via SQL "UPDATE mastery"',
      'src/engine/sample.ts:5 writes mastery via SQL "DELETE FROM mastery"',
      'src/engine/sample.ts:6 writes mastery via SQL "REPLACE INTO mastery"',
      'src/engine/sample.ts:7 writes mastery via SQL "INSERT INTO mastery"'
    ]);
  });
});

async function listProductionEngineFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listProductionEngineFiles(entryPath);
      }

      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        return [];
      }

      return [entryPath];
    })
  );

  return files.flat().sort((left, right) => relativePath(left).localeCompare(relativePath(right), "en"));
}

function findMasteryWriterOffenses(filePath: string, sourceText: string): MasteryWriterOffense[] {
  const relative = relativePath(filePath);
  if (relative === allowedWriterFile) {
    return [];
  }

  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenses: MasteryWriterOffense[] = [];

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === "recordMasteryUpdate") {
      offenses.push({
        file: relative,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        kind: "store-writer",
        detail: "recordMasteryUpdate"
      });
    }

    const masterySqlWrite = masterySqlWriteFromNode(node);
    if (masterySqlWrite !== undefined) {
      offenses.push({
        file: relative,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        kind: "sql-write",
        detail: masterySqlWrite
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return offenses;
}

function masterySqlWriteFromNode(node: ts.Node): string | undefined {
  const sourceText = stringLikeText(node);
  if (sourceText === undefined) {
    return undefined;
  }

  const normalized = sourceText.replace(/\s+/g, " ").trim();
  const match = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+mastery\b/i.exec(normalized);
  return match?.[0];
}

function stringLikeText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("");
  }

  return undefined;
}

function formatOffenses(offenses: MasteryWriterOffense[]): string[] {
  return offenses.map((offense) => {
    if (offense.kind === "sql-write") {
      return `${offense.file}:${offense.line} writes mastery via SQL ${JSON.stringify(offense.detail)}`;
    }

    return `${offense.file}:${offense.line} references ${offense.detail}`;
  });
}

function relativePath(filePath: string): string {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/");
}
