import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_MARKDOWN_VAULT_EXCLUDE, createConfiguredSourceAdapters } from "./config.js";

const tempFiles: string[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupPaths(tempFiles.splice(0), tempDirs.splice(0));
});

describe("adapter runtime config", () => {
  test("does not register adapters when the vault root is missing or blank", () => {
    expect(createConfiguredSourceAdapters({})).toBeUndefined();
    expect(createConfiguredSourceAdapters({ KNOWLEDGE_LOOP_VAULT_ROOT: "   " })).toBeUndefined();
  });

  test("registers the Holly vault adapter by default", async () => {
    const rootDir = await createVaultFixture();

    const adapters = createConfiguredSourceAdapters({ KNOWLEDGE_LOOP_VAULT_ROOT: rootDir });

    expect(adapters).toBeDefined();
    expect(Object.keys(adapters ?? {})).toEqual(["holly-vault"]);
    expect(adapters?.["holly-vault"]?.id).toBe("holly-vault");
    expect(adapters?.["holly-vault"]?.kind).toBe("markdown-vault");
  });

  test("uses a non-blank env adapter id when configured", () => {
    const adapters = createConfiguredSourceAdapters({
      KNOWLEDGE_LOOP_VAULT_ROOT: "fixture-root",
      KNOWLEDGE_LOOP_ADAPTER_ID: " custom-vault "
    });

    expect(Object.keys(adapters ?? {})).toEqual(["custom-vault"]);
    expect(adapters?.["custom-vault"]?.id).toBe("custom-vault");
  });

  test("applies default markdown include and conservative excludes to a fixture vault", async () => {
    const rootDir = await createVaultFixture();

    const adapters = createConfiguredSourceAdapters({ KNOWLEDGE_LOOP_VAULT_ROOT: rootDir });
    const refs = await collectAsync(adapters?.["holly-vault"]?.listDocuments());

    expect(refs.map((ref) => ref.path)).toEqual(["notes/kept.md", "published.md"]);
    expect(refs.map((ref) => ref.path)).not.toContain("90_待确认/hidden.md");
    expect(refs.map((ref) => ref.path)).not.toContain("private/secret.md");
    expect(refs.map((ref) => ref.path)).not.toContain("draft/foo.md");
    expect(refs.map((ref) => ref.path)).not.toContain("notes/drafts/foo.md");
    expect(refs.map((ref) => ref.path)).not.toContain("notes/draft-note.md");
  });

  test("documents Holly pending and common draft directory patterns in the default excludes", () => {
    expect(DEFAULT_MARKDOWN_VAULT_EXCLUDE).toEqual(
      expect.arrayContaining(["90_待确认/**", "draft/**", "**/drafts/**", "**/draft-*"])
    );
  });

  test("trims comma-separated include and exclude glob lists", async () => {
    const rootDir = await createVaultFixture();

    const adapters = createConfiguredSourceAdapters({
      KNOWLEDGE_LOOP_VAULT_ROOT: rootDir,
      KNOWLEDGE_LOOP_VAULT_INCLUDE: " notes/**, , published.md ",
      KNOWLEDGE_LOOP_VAULT_EXCLUDE: " **/draft-*, **/drafts/**, private/**, "
    });
    const refs = await collectAsync(adapters?.["holly-vault"]?.listDocuments());

    expect(refs.map((ref) => ref.path)).toEqual(["notes/kept.md", "published.md"]);
  });

  test("registers a git repo adapter when configured", async () => {
    const rootDir = await createVaultFixture();

    const adapters = createConfiguredSourceAdapters({
      KNOWLEDGE_LOOP_GIT_REPO_ROOT: rootDir
    });

    expect(adapters).toBeDefined();
    expect(Object.keys(adapters ?? {})).toEqual(["git-repo"]);
    expect(adapters?.["git-repo"]?.id).toBe("git-repo");
    expect(adapters?.["git-repo"]?.kind).toBe("git-repo");
  });

  test("can register markdown and git repo adapters together", async () => {
    const vaultRoot = await createVaultFixture();
    const repoRoot = await createVaultFixture();

    const adapters = createConfiguredSourceAdapters({
      KNOWLEDGE_LOOP_VAULT_ROOT: vaultRoot,
      KNOWLEDGE_LOOP_GIT_REPO_ROOT: repoRoot,
      KNOWLEDGE_LOOP_GIT_REPO_ADAPTER_ID: "second-dataset"
    });

    expect(Object.keys(adapters ?? {}).sort()).toEqual(["holly-vault", "second-dataset"]);
  });

  test("passes git repo include and exclude env globs into the adapter", async () => {
    const repoRoot = await createVaultFixture();

    const adapters = createConfiguredSourceAdapters({
      KNOWLEDGE_LOOP_GIT_REPO_ROOT: repoRoot,
      KNOWLEDGE_LOOP_GIT_REPO_INCLUDE: " notes/**, published.md ",
      KNOWLEDGE_LOOP_GIT_REPO_EXCLUDE: " **/draft-*, **/drafts/**, private/** "
    });
    const refs = await collectAsync(adapters?.["git-repo"]?.listDocuments());

    expect(refs.map((ref) => ref.path)).toEqual(["published.md", "notes/kept.md"]);
  });
});

async function createVaultFixture(): Promise<string> {
  const rootDir = await mkdirTempVault();
  const pendingDir = path.join(rootDir, "90_待确认");
  const draftDir = path.join(rootDir, "draft");
  const notesDir = path.join(rootDir, "notes");
  const notesDraftsDir = path.join(notesDir, "drafts");
  const privateDir = path.join(rootDir, "private");
  tempDirs.push(rootDir, pendingDir, draftDir, notesDir, notesDraftsDir, privateDir);

  await mkdir(pendingDir, { recursive: true });
  await mkdir(draftDir, { recursive: true });
  await mkdir(notesDraftsDir, { recursive: true });
  await mkdir(privateDir, { recursive: true });

  const files: Array<[string, string]> = [
    [path.join(rootDir, "published.md"), "# Published\n"],
    [path.join(rootDir, "published.txt"), "Not markdown\n"],
    [path.join(pendingDir, "hidden.md"), "# Hidden\n"],
    [path.join(draftDir, "foo.md"), "# Draft Directory\n"],
    [path.join(notesDir, "kept.md"), "# Kept\n"],
    [path.join(notesDir, "draft-note.md"), "# Draft\n"],
    [path.join(notesDraftsDir, "foo.md"), "# Nested Drafts Directory\n"],
    [path.join(privateDir, "secret.md"), "# Secret\n"]
  ];

  tempFiles.push(...files.map(([file]) => file));
  for (const [file, content] of files) {
    await writeFile(file, content, "utf8");
  }

  return rootDir;
}

async function mkdirTempVault(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");

  return mkdtemp(path.join(tmpdir(), "knowledge-loop-config-vault-"));
}

async function collectAsync<T>(items: AsyncIterable<T> | undefined): Promise<T[]> {
  const collected: T[] = [];

  if (items === undefined) {
    return collected;
  }

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
