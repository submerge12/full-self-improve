import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

interface FrozenRepoOffense {
  file: string;
  line: number;
  label: string;
  match: string;
}

const projectRoot = process.cwd();
const srcDir = path.join(projectRoot, "src");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const frozenRepoPatterns = [
  { label: "MathPilot", paths: ["C:\\Users\\Holly\\Documents\\数学项目", "C:\\Users\\Holly\\Documents\\鏁板椤圭洰"] },
  { label: "knowledge-showcase", paths: ["G:\\knowledge-showcase"] },
  { label: "compass-health", paths: ["C:\\Users\\Holly\\compass-health"] },
  { label: "Multica", paths: ["G:\\multica-ai-multica-https-github-com"] },
  { label: "pi-harness", paths: ["G:\\pi-harness"] }
] as const;

describe("project frozen repo boundary", () => {
  test("reports frozen repo references with file and line context", () => {
    const filePath = path.join(projectRoot, "src", "sample.ts");
    const sourceText = String.raw`
      const showcase = "G:\\knowledge-showcase";
      const math = "C:\\Users\\Holly\\Documents\\数学项目";
      const mathLegacy = "C:\\Users\\Holly\\Documents\\鏁板椤圭洰";
      const compass = "C:/Users/Holly/compass-health";
      const multica = "G:/multica-ai-multica-https-github-com";
      const harness = "G:\\pi-harness";
      const rawShowcase = "G:\knowledge-showcase";
    `;

    expect(formatOffenses(findFrozenRepoOffenses(filePath, sourceText))).toEqual([
      'src/sample.ts:2 references frozen repo knowledge-showcase via "G:\\\\\\\\knowledge-showcase"',
      'src/sample.ts:3 references frozen repo MathPilot via "C:\\\\\\\\Users\\\\\\\\Holly\\\\\\\\Documents\\\\\\\\数学项目"',
      'src/sample.ts:4 references frozen repo MathPilot via "C:\\\\\\\\Users\\\\\\\\Holly\\\\\\\\Documents\\\\\\\\鏁板椤圭洰"',
      'src/sample.ts:5 references frozen repo compass-health via "C:/Users/Holly/compass-health"',
      'src/sample.ts:6 references frozen repo Multica via "G:/multica-ai-multica-https-github-com"',
      'src/sample.ts:7 references frozen repo pi-harness via "G:\\\\\\\\pi-harness"',
      'src/sample.ts:8 references frozen repo knowledge-showcase via "G:\\\\knowledge-showcase"'
    ]);
  });

  test("production source files do not contain frozen repo directory references", async () => {
    const sourceFiles = await listProductionSourceFiles(srcDir);
    const offenses = (
      await Promise.all(
        sourceFiles.map(async (filePath) => findFrozenRepoOffenses(filePath, await readFile(filePath, "utf8")))
      )
    ).flat();

    expect(formatOffenses(offenses), "frozen repo source-boundary offenses").toEqual([]);
  });
});

async function listProductionSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isTestDirectory(entry.name)) {
          return [];
        }

        return listProductionSourceFiles(entryPath);
      }

      if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name)) || isTestFile(entry.name)) {
        return [];
      }

      return [entryPath];
    })
  );

  return files.flat().sort((left, right) => relativePath(left).localeCompare(relativePath(right), "en"));
}

function isTestFile(fileName: string): boolean {
  return /\.(test|spec)\.[cm]?[tj]sx?$/.test(fileName);
}

function isTestDirectory(dirName: string): boolean {
  return dirName === "__fixtures__" || dirName === "__tests__" || dirName === "test-utils";
}

function findFrozenRepoOffenses(filePath: string, sourceText: string): FrozenRepoOffense[] {
  const offenses: FrozenRepoOffense[] = [];
  const lines = sourceText.split(/\r?\n/);

  lines.forEach((lineText, index) => {
    for (const pattern of frozenRepoPatterns) {
      for (const candidate of expandedPathCandidates(pattern.paths)) {
        if (lineText.includes(candidate)) {
          offenses.push({
            file: relativePath(filePath),
            line: index + 1,
            label: pattern.label,
            match: candidate
          });
        }
      }
    }
  });

  return offenses;
}

function expandedPathCandidates(paths: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const repoPath of paths) {
    candidates.add(repoPath);
    candidates.add(repoPath.replaceAll("\\", "\\\\"));
    candidates.add(repoPath.replaceAll("\\", "/"));
  }

  return [...candidates];
}

function formatOffenses(offenses: FrozenRepoOffense[]): string[] {
  return offenses.map(
    (offense) =>
      `${offense.file}:${offense.line} references frozen repo ${offense.label} via ${JSON.stringify(offense.match)}`
  );
}

function relativePath(filePath: string): string {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/");
}
