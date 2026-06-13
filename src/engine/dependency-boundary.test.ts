import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { describe, expect, test } from "vitest";

interface ImportReference {
  specifier: string;
  line: number;
}

interface BoundaryOffense {
  file: string;
  specifier: string;
  line: number;
}

const projectRoot = process.cwd();
const engineDir = path.join(projectRoot, "src", "engine");
const appDir = path.join(projectRoot, "src", "app");

describe("engine dependency boundary", () => {
  test("extracts only real import specifiers from TypeScript source", () => {
    const source = `
      const nextScore = 1;
      import type { Metadata } from "next";
      import nextLegacy = require("next/legacy");
      import "../app/bootstrap";
      export { value } from "../../app/value";
      async function load() {
        await import("next/server");
        require("../app/legacy");
      }
    `;

    expect(extractImportReferences("sample.ts", source).map((entry) => entry.specifier)).toEqual([
      "next",
      "next/legacy",
      "../app/bootstrap",
      "../../app/value",
      "next/server",
      "../app/legacy"
    ]);
  });

  test("classifies Next.js and src/app import specifiers as boundary offenses", () => {
    const filePath = path.join(projectRoot, "src", "engine", "boundary-sample.ts");

    expect(isForbiddenEngineImport(filePath, "next")).toBe(true);
    expect(isForbiddenEngineImport(filePath, "next/server")).toBe(true);
    expect(isForbiddenEngineImport(filePath, "src/app")).toBe(true);
    expect(isForbiddenEngineImport(filePath, "src/app/api")).toBe(true);
    expect(isForbiddenEngineImport(filePath, "../app/page-data.js")).toBe(true);
    expect(isForbiddenEngineImport(filePath, "../../src/app/page-data.js")).toBe(true);
    expect(isForbiddenEngineImport(filePath, "../db/content-store.js")).toBe(false);
    expect(formatOffenses([{ file: "src/engine/boundary-sample.ts", line: 7, specifier: "next/server" }])).toEqual([
      'src/engine/boundary-sample.ts:7 imports "next/server"'
    ]);
  });

  test("production engine files do not import Next.js or src/app", async () => {
    const sourceFiles = await listProductionEngineFiles(engineDir);
    const offenses = (
      await Promise.all(
        sourceFiles.map(async (filePath) => findBoundaryOffenses(filePath, await readFile(filePath, "utf8")))
      )
    ).flat();

    expect(formatOffenses(offenses), "engine dependency boundary offenses").toEqual([]);
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

async function findBoundaryOffenses(filePath: string, sourceText: string): Promise<BoundaryOffense[]> {
  return extractImportReferences(filePath, sourceText)
    .filter((reference) => isForbiddenEngineImport(filePath, reference.specifier))
    .map((reference) => ({
      file: relativePath(filePath),
      specifier: reference.specifier,
      line: reference.line
    }));
}

function extractImportReferences(filePath: string, sourceText: string): ImportReference[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const references: ImportReference[] = [];

  function visit(node: ts.Node): void {
    const specifier = moduleSpecifierFromNode(node);
    if (specifier !== undefined) {
      references.push({
        specifier,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function moduleSpecifierFromNode(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return stringLiteralText(node.moduleSpecifier);
  }

  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1
  ) {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireIdentifier(node.expression)) {
      return stringLiteralText(node.arguments[0]);
    }
  }

  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined
  ) {
    return stringLiteralText(node.moduleReference.expression);
  }

  return undefined;
}

function isRequireIdentifier(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "require";
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }

  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function isForbiddenEngineImport(filePath: string, specifier: string): boolean {
  if (specifier === "next" || specifier.startsWith("next/")) {
    return true;
  }

  if (specifier === "src/app" || specifier.startsWith("src/app/")) {
    return true;
  }

  if (!specifier.startsWith(".")) {
    return false;
  }

  const resolvedImport = path.resolve(path.dirname(filePath), specifier);
  return resolvedImport === appDir || resolvedImport.startsWith(`${appDir}${path.sep}`);
}

function formatOffenses(offenses: BoundaryOffense[]): string[] {
  return offenses.map((offense) => `${offense.file}:${offense.line} imports ${JSON.stringify(offense.specifier)}`);
}

function relativePath(filePath: string): string {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/");
}
