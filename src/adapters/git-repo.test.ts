import { createHash } from "node:crypto";
import { mkdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runSourceAdapterConformanceTests } from "../engine/source-adapter.test.js";
import type { DocRef } from "../engine/source-adapter.js";
import { GitRepoAdapter } from "./git-repo.js";

const tempFiles: string[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const file of tempFiles.splice(0).reverse()) {
    await ignoreMissing(() => unlink(file));
  }

  for (const dir of tempDirs.splice(0).reverse()) {
    await ignoreMissing(() => rmdir(dir));
  }
});

runSourceAdapterConformanceTests("GitRepoAdapter", async () => {
  const rootDir = await createRepoFixture();
  const adapter = new GitRepoAdapter({ id: "fixture-repo", rootDir });

  return {
    adapter,
    expectedDocumentCount: 4,
    expectedDocument: {
      id: "docs/姒傚康.md",
      kind: "git-repo",
      textIncludes: "Graph Learning",
      metadata: { extension: ".md", repositoryPath: "docs/姒傚康.md" },
      link: "Related Concept",
      mediaRef: "../assets/diagram.png"
    },
    mutateDocument: async (ref: DocRef) => {
      await writeFile(path.join(rootDir, ref.path), "# Graph Learning\n\nUpdated body.\n", "utf8");
    }
  };
});

describe("GitRepoAdapter", () => {
  test("applies include and exclude globs without listing .git internals", async () => {
    const rootDir = await createRepoFixture();
    const adapter = new GitRepoAdapter({
      id: "filtered-repo",
      rootDir,
      include: ["docs/**", "README.md"],
      exclude: ["**/draft-*"]
    });

    const refs = await collectAsync(adapter.listDocuments());

    expect(refs.map((ref) => ref.path)).toEqual(["README.md", "docs/notes.txt", "docs/姒傚康.md"]);
    expect(refs.map((ref) => ref.path)).not.toContain(".git/config");
    expect(refs.map((ref) => ref.path)).not.toContain(".git/nested/internal.md");
    expect(refs.map((ref) => ref.path)).not.toContain("docs/draft-secret.md");
    expect(refs.map((ref) => ref.path)).not.toContain("assets/diagram.png");
  });

  test("excludes .git markdown files by default and rejects direct access", async () => {
    const rootDir = await createRepoFixture();
    const adapter = new GitRepoAdapter({ id: "default-safe-repo", rootDir });
    const refs = await collectAsync(adapter.listDocuments());
    const internalRef: DocRef = {
      adapterId: "default-safe-repo",
      id: ".git/nested/internal.md",
      kind: "git-repo",
      path: ".git/nested/internal.md",
      title: "internal"
    };

    expect(refs.map((ref) => ref.path)).not.toContain(".git/nested/internal.md");
    await expect(adapter.readDocument(internalRef)).rejects.toThrow(/excluded from the repository adapter/);
    expect(() => adapter.fingerprint(internalRef)).toThrow(/excluded from the repository adapter/);
  });

  test("rejects case-varied .git refs before reading or fingerprinting", async () => {
    const rootDir = await createRepoFixture();
    const adapter = new GitRepoAdapter({ id: "case-safe-repo", rootDir });
    const internalRef: DocRef = {
      adapterId: "case-safe-repo",
      id: ".GIT/nested/internal.md",
      kind: "git-repo",
      path: ".GIT/nested/internal.md",
      title: "internal"
    };

    await expect(adapter.readDocument(internalRef)).rejects.toThrow(/excluded from the repository adapter/);
    expect(() => adapter.fingerprint(internalRef)).toThrow(/excluded from the repository adapter/);
  });

  test("rejects symlinked paths that resolve outside the repository root", async () => {
    const rootDir = await createRepoFixture();
    const outsideDir = await mkdirTempRepo();
    const outsideFile = path.join(outsideDir, "outside.md");
    const linkDir = path.join(rootDir, "linked-outside");
    tempDirs.push(outsideDir, linkDir);
    tempFiles.push(outsideFile);
    await writeFile(outsideFile, "# Outside Repository\n", "utf8");

    const linkCreated = await createDirectoryLinkOrSkip(outsideDir, linkDir);
    if (!linkCreated) {
      return;
    }

    const adapter = new GitRepoAdapter({ id: "link-safe-repo", rootDir });
    const escapeRef: DocRef = {
      adapterId: "link-safe-repo",
      id: "linked-outside/outside.md",
      kind: "git-repo",
      path: "linked-outside/outside.md",
      title: "outside"
    };

    expect((await collectAsync(adapter.listDocuments())).map((ref) => ref.path)).not.toContain(
      "linked-outside/outside.md"
    );
    await expect(adapter.readDocument(escapeRef)).rejects.toThrow(/outside the repository root/);
    expect(() => adapter.fingerprint(escapeRef)).toThrow(/outside the repository root/);
  });

  test("rejects symlinked aliases that resolve into .git internals", async () => {
    const rootDir = await createRepoFixture();
    const gitDir = path.join(rootDir, ".git");
    const linkDir = path.join(rootDir, "git-alias");
    tempDirs.push(linkDir);

    const linkCreated = await createDirectoryLinkOrSkip(gitDir, linkDir);
    if (!linkCreated) {
      return;
    }

    const adapter = new GitRepoAdapter({ id: "git-alias-safe-repo", rootDir });
    const aliasRef: DocRef = {
      adapterId: "git-alias-safe-repo",
      id: "git-alias/nested/internal.md",
      kind: "git-repo",
      path: "git-alias/nested/internal.md",
      title: "internal"
    };

    expect((await collectAsync(adapter.listDocuments())).map((ref) => ref.path)).not.toContain(
      "git-alias/nested/internal.md"
    );
    await expect(adapter.readDocument(aliasRef)).rejects.toThrow(/excluded from the repository adapter/);
    expect(() => adapter.fingerprint(aliasRef)).toThrow(/excluded from the repository adapter/);
  });

  test("excludes nested drafts directories with double-star directory globs", async () => {
    const rootDir = await createRepoFixture();
    const draftsDir = path.join(rootDir, "docs", "drafts");
    const draftFile = path.join(draftsDir, "internal.md");
    tempDirs.push(draftsDir);
    tempFiles.push(draftFile);
    await mkdir(draftsDir, { recursive: true });
    await writeFile(draftFile, "# Internal Draft\n", "utf8");
    const adapter = new GitRepoAdapter({
      id: "drafts-repo",
      rootDir,
      exclude: ["**/drafts/**"]
    });

    const refs = await collectAsync(adapter.listDocuments());

    const paths = refs.map((ref) => ref.path);

    expect(paths).toContain("README.md");
    expect(paths).toContain("docs/draft-secret.md");
    expect(paths).toContain("docs/notes.txt");
    expect(paths).not.toContain("docs/drafts/internal.md");
  });

  test("rejects traversal refs before reading or fingerprinting", async () => {
    const rootDir = await createRepoFixture();
    const adapter = new GitRepoAdapter({ id: "safe-repo", rootDir });
    const traversalRef: DocRef = {
      adapterId: "safe-repo",
      id: "../outside.md",
      kind: "git-repo",
      path: "../outside.md",
      title: "outside"
    };

    await expect(adapter.readDocument(traversalRef)).rejects.toThrow(/outside the repository root/);
    expect(() => adapter.fingerprint(traversalRef)).toThrow(/outside the repository root/);
  });

  test("rejects unsupported binary refs before reading or fingerprinting", async () => {
    const rootDir = await createRepoFixture();
    const adapter = new GitRepoAdapter({ id: "binary-safe-repo", rootDir });
    const binaryRef: DocRef = {
      adapterId: "binary-safe-repo",
      id: "assets/diagram.png",
      kind: "git-repo",
      path: "assets/diagram.png",
      title: "diagram"
    };

    await expect(adapter.readDocument(binaryRef)).rejects.toThrow(/not a supported text file/);
    expect(() => adapter.fingerprint(binaryRef)).toThrow(/not a supported text file/);
  });

  test("returns empty links and media references for non-markdown text files", async () => {
    const rootDir = await createRepoFixture();
    const adapter = new GitRepoAdapter({ id: "text-repo", rootDir });

    const doc = await adapter.readDocument({
      adapterId: "text-repo",
      id: "docs/notes.txt",
      kind: "git-repo",
      path: "docs/notes.txt",
      title: "notes"
    });

    expect(doc.text).toContain("Plain text concept");
    expect(doc.links).toEqual([]);
    expect(doc.mediaRefs).toEqual([]);
    expect(doc.metadata).toMatchObject({
      extension: ".txt",
      repositoryPath: "docs/notes.txt"
    });
  });

  test("fingerprints the relative path and file bytes", async () => {
    const rootDir = await createRepoFixture();
    const adapter = new GitRepoAdapter({ id: "fingerprint-repo", rootDir });
    const ref: DocRef = {
      adapterId: "fingerprint-repo",
      id: "README.md",
      kind: "git-repo",
      path: "README.md",
      title: "README"
    };

    const expected = createHash("sha256")
      .update("README.md")
      .update("\0")
      .update("# Repo Dataset\n\nRepository overview.")
      .digest("hex");

    expect(adapter.fingerprint(ref)).toBe(expected);
  });
});

async function createRepoFixture(): Promise<string> {
  const rootDir = await mkdirTempRepo();
  const docsDir = path.join(rootDir, "docs");
  const gitDir = path.join(rootDir, ".git");
  const gitNestedDir = path.join(gitDir, "nested");
  const assetsDir = path.join(rootDir, "assets");

  tempDirs.push(rootDir, docsDir, gitDir, gitNestedDir, assetsDir);

  await mkdir(docsDir, { recursive: true });
  await mkdir(gitNestedDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });

  const files: Array<[string, string | Buffer]> = [
    [path.join(rootDir, "README.md"), "# Repo Dataset\n\nRepository overview."],
    [
      path.join(docsDir, "姒傚康.md"),
      "# Graph Learning\n\nSee [[Related Concept]].\n\n![diagram](../assets/diagram.png)\n"
    ],
    [path.join(docsDir, "notes.txt"), "Plain text concept\nrequires: Repo Dataset\n"],
    [path.join(docsDir, "draft-secret.md"), "# Draft Secret\n"],
    [path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\n"],
    [path.join(gitNestedDir, "internal.md"), "# Internal Git Metadata\n"],
    [path.join(assetsDir, "diagram.png"), Buffer.from([0, 1, 2, 3])]
  ];

  tempFiles.push(...files.map(([file]) => file));

  for (const [file, content] of files) {
    await writeFile(file, content);
  }

  return rootDir;
}

async function mkdirTempRepo(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");

  return mkdtemp(path.join(tmpdir(), "knowledge-loop-git-repo-adapter-"));
}

async function createDirectoryLinkOrSkip(targetDir: string, linkDir: string): Promise<boolean> {
  try {
    await symlink(targetDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (
      isNodeError(error) &&
      ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN"].includes(error.code ?? "")
    ) {
      console.warn(`Skipping symlink escape test because directory links are unsupported: ${error.code}`);
      return false;
    }

    throw error;
  }
}

async function collectAsync<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const item of items) {
    collected.push(item);
  }

  return collected;
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
