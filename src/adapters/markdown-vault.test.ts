import { appendFile, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runSourceAdapterConformanceTests } from "../engine/source-adapter.test.js";
import type { DocRef } from "../engine/source-adapter.js";
import { MarkdownVaultAdapter } from "./markdown-vault.js";

const tempFiles: string[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupPaths(tempFiles.splice(0), tempDirs.splice(0));
});

runSourceAdapterConformanceTests("MarkdownVaultAdapter", async () => {
  const rootDir = await createVaultFixture();
  const adapter = new MarkdownVaultAdapter({
    id: "fixture-vault",
    rootDir,
    include: ["**/*.md"],
    exclude: ["private/**", "**/draft-*"]
  });

  return {
    adapter,
    expectedDocumentCount: 2,
    expectedDocument: {
      id: "index.md",
      kind: "markdown-vault",
      textIncludes: "# Index",
      metadata: {
        title: "Index",
        public: true,
        priority: 2
      },
      link: "中文 笔记",
      mediaRef: "notes/assets/diagram.png"
    },
    mutateDocument: async (ref) => {
      await appendFile(path.join(rootDir, ref.path), "\nChanged during conformance test.\n", "utf8");
    }
  };
});

describe("MarkdownVaultAdapter", () => {
  test("lists markdown files recursively with Chinese paths and include/exclude filters", async () => {
    const rootDir = await createVaultFixture();
    const siblingPath = path.join(rootDir, "notes-other.md");
    await writeTrackedFile(siblingPath, "# Sibling\n");
    const adapter = new MarkdownVaultAdapter({
      id: "filtered-vault",
      rootDir,
      include: ["notes/**"],
      exclude: ["**/draft-*", "private/**"]
    });

    const refs = await collectAsync(adapter.listDocuments());

    expect(refs.map((ref) => ref.path)).toEqual(["notes/中文 笔记.md"]);
    expect(refs[0]).toMatchObject({
      adapterId: "filtered-vault",
      id: "notes/中文 笔记.md",
      kind: "markdown-vault",
      title: "中文 笔记"
    });
  });

  test("excludes nested drafts directories with double-star directory globs", async () => {
    const rootDir = await createDraftGlobFixture();
    const adapter = new MarkdownVaultAdapter({
      id: "drafts-directory-vault",
      rootDir,
      include: ["**/*.md"],
      exclude: ["**/drafts/**"]
    });

    const refs = await collectAsync(adapter.listDocuments());

    expect(refs.map((ref) => ref.path)).toEqual(["notes/draft-note.md", "notes/kept.md"]);
  });

  test("does not treat draft-prefixed globs as matching drafts directories", async () => {
    const rootDir = await createDraftGlobFixture();
    const adapter = new MarkdownVaultAdapter({
      id: "draft-prefix-vault",
      rootDir,
      include: ["**/*.md"],
      exclude: ["**/draft-*"]
    });

    const refs = await collectAsync(adapter.listDocuments());

    expect(refs.map((ref) => ref.path)).toEqual(["notes/drafts/foo.md", "notes/kept.md"]);
  });

  test("parses frontmatter, wikilinks, and markdown media references", async () => {
    const rootDir = await createVaultFixture();
    const adapter = new MarkdownVaultAdapter({
      id: "parse-vault",
      rootDir
    });

    const refs = await collectAsync(adapter.listDocuments());
    const ref = refs.find((candidate) => candidate.id === "index.md");

    expect(ref).toBeDefined();

    const doc = await adapter.readDocument(ref as DocRef);

    expect(doc.metadata).toEqual({
      title: "Index",
      public: true,
      priority: 2,
      topic: "knowledge-loop"
    });
    expect(doc.text).toContain("# Index");
    expect(doc.text).not.toContain("title: Index");
    expect(doc.links).toEqual(["中文 笔记", "Nested/Deep Note"]);
    expect(doc.mediaRefs).toEqual(["notes/assets/diagram.png", "notes/assets/scan.pdf"]);
  });

  test("parses and strips CRLF frontmatter from Windows vault files", async () => {
    const rootDir = await createVaultFixture();
    const windowsPath = path.join(rootDir, "windows.md");
    await writeTrackedFile(
      windowsPath,
      ["---", "title: Windows Note", "public: true", "---", "# Windows", "", "Body"].join("\r\n")
    );
    const adapter = new MarkdownVaultAdapter({
      id: "crlf-vault",
      rootDir
    });

    const doc = await adapter.readDocument({
      adapterId: "crlf-vault",
      id: "windows.md",
      kind: "markdown-vault",
      path: "windows.md",
      title: "Windows Note"
    });

    expect(doc.metadata).toEqual({
      title: "Windows Note",
      public: true
    });
    expect(doc.text).toContain("# Windows");
    expect(doc.text).not.toContain("title: Windows Note");
  });

  test("changes only the edited document fingerprint when file content changes", async () => {
    const rootDir = await createVaultFixture();
    const adapter = new MarkdownVaultAdapter({
      id: "fingerprint-vault",
      rootDir,
      exclude: ["private/**", "**/draft-*"]
    });

    const refs = await collectAsync(adapter.listDocuments());
    const indexRef = refs.find((candidate) => candidate.id === "index.md");
    const chineseRef = refs.find((candidate) => candidate.id === "notes/中文 笔记.md");

    expect(indexRef).toBeDefined();
    expect(chineseRef).toBeDefined();

    const beforeIndex = adapter.fingerprint(indexRef as DocRef);
    const beforeChinese = adapter.fingerprint(chineseRef as DocRef);

    await appendFile(path.join(rootDir, "notes", "中文 笔记.md"), "\n追加内容\n", "utf8");

    expect(adapter.fingerprint(indexRef as DocRef)).toBe(beforeIndex);
    expect(adapter.fingerprint(chineseRef as DocRef)).not.toBe(beforeChinese);
  });

  test("rejects document refs that traverse outside the vault root", async () => {
    const rootDir = await createVaultFixture();
    const adapter = new MarkdownVaultAdapter({
      id: "safe-vault",
      rootDir
    });
    const traversalRef: DocRef = {
      adapterId: "safe-vault",
      id: "../outside.md",
      kind: "markdown-vault",
      path: "../outside.md",
      title: "outside"
    };

    await expect(adapter.readDocument(traversalRef)).rejects.toThrow(/outside the vault root/);
    expect(() => adapter.fingerprint(traversalRef)).toThrow(/outside the vault root/);
  });
});

async function createVaultFixture(): Promise<string> {
  const rootDir = await mkdirTempVault();
  const notesDir = trackTempDir(path.join(rootDir, "notes"));
  const assetsDir = trackTempDir(path.join(notesDir, "assets"));
  const privateDir = trackTempDir(path.join(rootDir, "private"));
  tempFiles.push(
    path.join(rootDir, "index.md"),
    path.join(notesDir, "涓枃 绗旇.md"),
    path.join(notesDir, "draft-ignore.md"),
    path.join(privateDir, "hidden.md"),
    path.join(assetsDir, "diagram.png"),
    path.join(assetsDir, "scan.pdf")
  );

  await mkdir(assetsDir, { recursive: true });
  await mkdir(privateDir, { recursive: true });

  await writeTrackedFile(
    path.join(rootDir, "index.md"),
    [
      "---",
      "title: Index",
      "public: true",
      "priority: 2",
      "topic: knowledge-loop",
      "---",
      "# Index",
      "",
      "See [[中文 笔记|Chinese Note]] and [[Nested/Deep Note]].",
      "",
      "![](notes/assets/diagram.png)",
      "![scan](notes/assets/scan.pdf)"
    ].join("\n")
  );

  await writeTrackedFile(
    path.join(rootDir, "notes", "中文 笔记.md"),
    [
      "---",
      "title: 中文 笔记",
      "public: false",
      "---",
      "# 中文 笔记",
      "",
      "Back to [[Index]]."
    ].join("\n")
  );

  await writeTrackedFile(path.join(rootDir, "notes", "draft-ignore.md"), "# Draft\n");
  await writeTrackedFile(path.join(rootDir, "private", "hidden.md"), "# Hidden\n");
  await writeTrackedFile(path.join(rootDir, "notes", "assets", "diagram.png"), "png-bytes");
  await writeTrackedFile(path.join(rootDir, "notes", "assets", "scan.pdf"), "pdf-bytes");

  return rootDir;
}

async function createDraftGlobFixture(): Promise<string> {
  const rootDir = await mkdirTempVault();
  const notesDir = trackTempDir(path.join(rootDir, "notes"));
  const draftsDir = trackTempDir(path.join(notesDir, "drafts"));
  const files = [
    path.join(notesDir, "draft-note.md"),
    path.join(draftsDir, "foo.md"),
    path.join(notesDir, "kept.md")
  ];
  await mkdir(draftsDir, { recursive: true });
  await writeTrackedFile(files[0], "# Draft Note\n");
  await writeTrackedFile(files[1], "# Drafts Directory\n");
  await writeTrackedFile(files[2], "# Kept\n");

  return rootDir;
}

async function mkdirTempVault(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");

  return trackTempDir(await mkdtemp(path.join(tmpdir(), "knowledge-loop-vault-")));
}

async function collectAsync<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const item of items) {
    collected.push(item);
  }

  return collected;
}

async function cleanupPaths(files: string[], dirs: string[]): Promise<void> {
  for (const file of files.reverse()) {
    await ignoreMissing(() => unlink(file));
  }

  for (const dir of dirs.reverse()) {
    await ignoreMissing(() => rmdir(dir));
  }
}

async function ignoreMissing(removePath: () => Promise<void>): Promise<void> {
  try {
    await removePath();
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function trackTempFile(file: string): string {
  tempFiles.push(file);
  return file;
}

async function writeTrackedFile(file: string, content: string): Promise<void> {
  trackTempFile(file);
  await writeFile(file, content, "utf8");
}
