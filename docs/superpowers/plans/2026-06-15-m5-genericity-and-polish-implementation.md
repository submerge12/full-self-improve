# M5 Genericity And Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the M5 development work by proving knowledge-loop can ingest a non-Holly dataset through a second adapter with zero `src/engine/` changes, then add backup/restore drill support and a small operational dashboard.

**Architecture:** Keep the genericity proof at the adapter boundary: implement a read-only `GitRepoAdapter` under `src/adapters/`, register it through adapter runtime config, and prove persistent ingest works without touching `src/engine/`. Keep backup logic in `src/db/backup.ts` and expose it through the existing `kl` CLI. Keep the dashboard read-only and backed by existing stores/handlers so it reports system health without adding new write paths.

**Tech Stack:** TypeScript, Node `fs/path/crypto`, better-sqlite3, Vitest, existing `npm run kl -- ...` CLI, existing Next App Router route adapter patterns.

---

## Team Mode Rules

- Split implementation by task. Do not assign more than one task to a worker at a time.
- Each worker must receive the relevant task text, exact files it may edit, exact tests to run, and the worker template constraints from `G:/multica-ai-multica-https-github-com/server/pkg/roles/templates/worker.md`.
- Each completed task needs at least one reviewer using the reviewer template from `G:/multica-ai-multica-https-github-com/server/pkg/roles/templates/reviewer.md`.
- Reviewers do not edit files. They inspect the diff, contract, tests, failure modes, and boundary rules.
- Commit and push after each approved task slice.
- Do not claim M4 complete while M4 live evidence remains pending.
- Do not touch or stage `docs/AUDIT-MANUAL.md` unless Holly explicitly asks.
- Do not use forbidden delete commands from `AGENTS.md`; if cleanup requires recursive deletion, stop and ask Holly.

---

## M5 Scope Boundary

M5 in `PLAN.md` covers:

- A second source adapter and second dataset ingest with zero core-code changes in `src/engine/`.
- A backup strategy and restore drill.
- Dashboards/polish.

M5 does not close earlier live gates:

- M1/M3 Section 0 strict closure remains a closure-time check.
- M2 still needs live Multica/scheduler proof.
- M4 still needs live Windows logger, Coach Multica publish, and one-week compass-health hash proof.

---

## File Structure

- Create `src/adapters/git-repo.ts`: read-only second source adapter for a local repository or folder. It lists text-like files, excludes `.git` and configured globs, reads file content, extracts markdown links/media refs when present, and fingerprints relative path plus bytes.
- Create `src/adapters/git-repo.test.ts`: adapter conformance tests plus boundary, include/exclude, binary-skip, and fingerprint tests.
- Modify `src/adapters/config.ts`: register optional git-repo adapters from env without changing markdown vault behavior.
- Modify `src/adapters/config.test.ts`: cover git-repo env registration and no-registration when blank.
- Create `config/adapters/git-repo.example.json`: non-secret example of an M5 second dataset adapter config.
- Create `docs/reviews/M5.md`: pending review note with M5 evidence sections.
- Create `.ai/checkpoints/part-m5-second-adapter-genericity-proof/step-1.md`: checkpoint for Task 1.
- Create `src/db/backup.ts`: SQLite backup manifest, copy, hash, and restore drill helpers.
- Create `src/db/backup.test.ts`: backup/restore drill tests against a migrated scratch DB.
- Modify `src/cli/kl.ts`: add `db-backup create` and `db-backup restore-drill` commands.
- Modify `src/cli/kl.test.ts`: CLI coverage for backup create/restore drill and unsafe paths.
- Create `docs/runbooks/m5-backup-restore.md`: backup strategy and drill runbook.
- Create `.ai/checkpoints/part-m5-backup-restore-drill/step-1.md`: checkpoint for Task 2.
- Create `src/ops/dashboard.ts`: read-only dashboard summary builder.
- Create `src/ops/dashboard.test.ts`: summary tests with migrated scratch DB and known rows.
- Modify `src/api/contracts.ts`: add a read-only dashboard contract.
- Modify `src/api/contracts.test.ts`: route manifest/contract test for dashboard.
- Modify `src/api/handlers.ts`: add dashboard handler that reads current DB state only.
- Modify `src/api/handlers.test.ts`: bearer-authenticated dashboard response and unauthenticated rejection test.
- Create `src/app/api/ops/dashboard/route.ts`: thin Next route wrapper.
- Modify `src/app/api/_shared/route-adapter.test.ts`: route wrapper export/runtime/auth test.
- Modify `src/cli/kl.ts`: add an `ops-dashboard --db` command that reads a caller-provided SQLite path.
- Modify `src/cli/kl.test.ts`: CLI dashboard smoke coverage.
- Create `docs/runbooks/m5-ops-dashboard.md`: dashboard runbook.
- Create `.ai/checkpoints/part-m5-ops-dashboard/step-1.md`: checkpoint for Task 3.
- Modify `docs/reviews/M5.md`: final development evidence and remaining live/polish status.
- Create `.ai/checkpoints/part-m5-review-note/step-1.md`: checkpoint for Task 4.

---

## Task 1: Second Adapter Genericity Proof

**Task id:** `part-m5-second-adapter-genericity-proof`

**Files:**
- Create: `src/adapters/git-repo.ts`
- Create: `src/adapters/git-repo.test.ts`
- Modify: `src/adapters/config.ts`
- Modify: `src/adapters/config.test.ts`
- Create: `config/adapters/git-repo.example.json`
- Create: `docs/reviews/M5.md`
- Create: `.ai/checkpoints/part-m5-second-adapter-genericity-proof/step-1.md`

- [ ] **Step 1: Write failing GitRepoAdapter conformance tests**

Add `src/adapters/git-repo.test.ts` with this shape:

```ts
import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
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
      id: "docs/概念.md",
      kind: "git-repo",
      textIncludes: "Graph Learning",
      metadata: { extension: ".md", repositoryPath: "docs/概念.md" },
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

    expect(refs.map((ref) => ref.path)).toEqual(["README.md", "docs/概念.md"]);
    expect(refs.map((ref) => ref.path)).not.toContain(".git/config");
    expect(refs.map((ref) => ref.path)).not.toContain("docs/draft-secret.md");
    expect(refs.map((ref) => ref.path)).not.toContain("assets/diagram.png");
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
});
```

Include local helpers in the same test file:

```ts
async function createRepoFixture(): Promise<string> {
  const rootDir = await mkdirTempRepo();
  const docsDir = path.join(rootDir, "docs");
  const gitDir = path.join(rootDir, ".git");
  const assetsDir = path.join(rootDir, "assets");
  tempDirs.push(rootDir, docsDir, gitDir, assetsDir);
  await mkdir(docsDir, { recursive: true });
  await mkdir(gitDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });

  const files: Array<[string, string | Buffer]> = [
    [path.join(rootDir, "README.md"), "# Repo Dataset\n\nRepository overview."],
    [path.join(docsDir, "概念.md"), "# Graph Learning\n\nSee [[Related Concept]].\n\n![diagram](../assets/diagram.png)\n"],
    [path.join(docsDir, "notes.txt"), "Plain text concept\nrequires: Repo Dataset\n"],
    [path.join(docsDir, "draft-secret.md"), "# Draft Secret\n"],
    [path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\n"],
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
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}
```

- [ ] **Step 2: Run RED test**

Run:

```powershell
npm run test:unit -- src/adapters/git-repo.test.ts
```

Expected: FAIL because `src/adapters/git-repo.ts` does not exist or does not export `GitRepoAdapter`.

- [ ] **Step 3: Implement GitRepoAdapter**

Create `src/adapters/git-repo.ts`. It must:

- implement `SourceAdapter`;
- use `kind = "git-repo"`;
- resolve `rootDir` once in the constructor;
- list only text-like extensions: `.md`, `.txt`, `.mdx`, `.json`, `.yaml`, `.yml`, `.ts`, `.tsx`, `.js`, `.jsx`, `.py`;
- exclude `.git/**` by default;
- support the same small glob subset as `MarkdownVaultAdapter`;
- reject traversal refs in `readDocument()` and `fingerprint()`;
- parse markdown links/media refs for markdown-like files and return empty link/media arrays for non-markdown text;
- fingerprint `relativePath + "\0" + file bytes` with SHA-256.

Use these exported types:

```ts
export interface GitRepoAdapterOptions {
  id: string;
  rootDir: string;
  include?: string[];
  exclude?: string[];
}
```

- [ ] **Step 4: Run GREEN adapter tests**

Run:

```powershell
npm run test:unit -- src/adapters/git-repo.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing runtime config tests**

Extend `src/adapters/config.test.ts` with tests for `KNOWLEDGE_LOOP_GIT_REPO_ROOT`:

```ts
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

  expect(refs.map((ref) => ref.path)).toEqual(["notes/kept.md", "published.md"]);
});
```

- [ ] **Step 6: Run RED config tests**

Run:

```powershell
npm run test:unit -- src/adapters/config.test.ts
```

Expected: FAIL because git repo env registration is not implemented.

- [ ] **Step 7: Implement adapter runtime config**

Modify `src/adapters/config.ts`:

- import `GitRepoAdapter`;
- add default id `git-repo`;
- parse `KNOWLEDGE_LOOP_GIT_REPO_ROOT`;
- parse optional `KNOWLEDGE_LOOP_GIT_REPO_ADAPTER_ID`;
- parse optional `KNOWLEDGE_LOOP_GIT_REPO_INCLUDE`;
- parse optional `KNOWLEDGE_LOOP_GIT_REPO_EXCLUDE`;
- return both configured adapters when both roots are present;
- preserve `undefined` when no adapter roots are configured.

Do not modify any file in `src/engine/`.

- [ ] **Step 8: Run GREEN adapter/config tests**

Run:

```powershell
npm run test:unit -- src/adapters/git-repo.test.ts src/adapters/config.test.ts
```

Expected: PASS.

- [ ] **Step 9: Add example config and M5 pending review note**

Create `config/adapters/git-repo.example.json`:

```json
{
  "adapterId": "second-dataset",
  "kind": "git-repo",
  "rootEnv": "KNOWLEDGE_LOOP_GIT_REPO_ROOT",
  "include": ["README.md", "docs/**", "src/**"],
  "exclude": [".git/**", "**/node_modules/**", "**/dist/**", "**/.env*", "**/*secret*"],
  "nonCompletionNotice": "This example documents the second adapter config shape. M5 genericity is only proven after a real or fixture second dataset ingest runs with zero src/engine diffs."
}
```

Create `docs/reviews/M5.md`:

```md
# M5 Review

## Status: pending M5 evidence

M5 development is in progress. This note must not mark M5 complete until the second-adapter ingest proof, backup restore drill, dashboard evidence, and Section 0 recheck are recorded.

## Genericity proof

- Pending: second adapter implementation and conformance tests.
- Pending: second dataset persistent ingest proof.
- Pending: `src/engine/` zero-diff proof for the genericity slice.

## Backup and restore

- Pending: SQLite backup strategy.
- Pending: restore drill evidence.

## Dashboards and polish

- Pending: read-only operational dashboard evidence.

## Earlier live gates not closed by M5

- M2 live Multica/scheduler proof remains outside this note until recorded in `docs/reviews/M2.md`.
- M4 live Windows logger, Coach publish, and one-week compass-health hash proof remain outside this note until recorded in `docs/reviews/M4.md`.
```

- [ ] **Step 10: Run second dataset persistent ingest proof**

Use a scratch second dataset under `.ai/tmp/part-m5-second-adapter-genericity-proof/second-dataset`. Create files one at a time with normal file writes from the worker, not recursive delete commands.

Run a small TypeScript proof script through `npx tsx -e` or an equivalent temporary script under `.ai/tmp/part-m5-second-adapter-genericity-proof/` that:

- creates a scratch SQLite DB under `.ai/tmp/part-m5-second-adapter-genericity-proof/genericity.db`;
- applies migrations;
- constructs `createConfiguredSourceAdapters({ KNOWLEDGE_LOOP_GIT_REPO_ROOT: ".ai/tmp/part-m5-second-adapter-genericity-proof/second-dataset", KNOWLEDGE_LOOP_GIT_REPO_ADAPTER_ID: "second-dataset" })` after resolving the dataset path to an absolute path;
- calls `runPersistentMockIngest(db, adapters["second-dataset"], { runId: "m5-second-dataset-proof" })`;
- prints the summary and row counts for `sources`, `chunks`, `concepts`, and `pages`;
- closes the DB.

Expected: at least one source processed, zero source failures, at least one concept, at least one page.

- [ ] **Step 11: Record zero engine diff proof**

Run:

```powershell
git diff -- src/engine
```

Expected: no output.

Run:

```powershell
git diff --name-only
```

Expected code proof: the only code/config files needed for the genericity proof are under `src/adapters/*` and `config/adapters/*`.

Expected documentation/checkpoint proof: `docs/reviews/M5.md` and `.ai/checkpoints/part-m5-second-adapter-genericity-proof/step-1.md` may also appear in the task diff, but they are evidence records, not part of the strict genericity code proof.

- [ ] **Step 12: Write checkpoint**

Create `.ai/checkpoints/part-m5-second-adapter-genericity-proof/step-1.md` with:

```md
# M5 Second Adapter Genericity Proof - Step 1

Worker: M5-1
Date: 2026-06-15

## What changed

- Added `GitRepoAdapter` as the second SourceAdapter implementation.
- Registered optional git-repo adapters through adapter runtime config.
- Added a non-secret example config for a second dataset.
- Created the pending M5 review note.

## Verification

- RED adapter test: record the actual command and failure summary from Step 2.
- GREEN adapter/config tests: record the actual command and pass count from Steps 4 and 8.
- Second dataset ingest proof: record the actual source, chunk, concept, and page counts from Step 10.
- Engine diff proof: `git diff -- src/engine` produced no output.

## Remaining M5 work

- Backup/restore drill.
- Read-only operational dashboard.
- Final M5 review update after all evidence is recorded.
```

Do not write synthetic or expected values in this checkpoint; record only the observed command output summaries from this task run.

- [ ] **Step 13: Run broader checks**

Run:

```powershell
npm run test:unit -- src/adapters/git-repo.test.ts src/adapters/config.test.ts src/engine/source-adapter.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 14: Commit and push this slice**

After reviewers approve:

```powershell
git add src/adapters/git-repo.ts src/adapters/git-repo.test.ts src/adapters/config.ts src/adapters/config.test.ts config/adapters/git-repo.example.json docs/reviews/M5.md .ai/checkpoints/part-m5-second-adapter-genericity-proof/step-1.md
git commit -m "feat: add m5 second adapter proof"
git push -u origin HEAD
```

Expected: commit and push succeed.

---

## Task 2: Backup Strategy And Restore Drill

**Task id:** `part-m5-backup-restore-drill`

**Files:**
- Create: `src/db/backup.ts`
- Create: `src/db/backup.test.ts`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create: `docs/runbooks/m5-backup-restore.md`
- Modify: `docs/reviews/M5.md`
- Create: `.ai/checkpoints/part-m5-backup-restore-drill/step-1.md`

- [ ] **Step 1: Write failing backup domain tests**

Create `src/db/backup.test.ts` covering:

- `createSqliteBackup` copies a migrated DB to an explicit backup file path;
- result includes source path, backup path, byte size, SHA-256 hash, createdAt, and table counts;
- backup refuses a missing source DB;
- backup refuses source and destination resolving to the same path;
- `runSqliteRestoreDrill` opens a backup read-only, applies no migrations, and reports table counts and integrity status.

Use scratch files under `tmpdir()` and clean up one explicit file path at a time with `unlink`/`rmdir`, not recursive deletion.

- [ ] **Step 2: Run RED backup tests**

Run:

```powershell
npm run test:unit -- src/db/backup.test.ts
```

Expected: FAIL because `src/db/backup.ts` does not exist.

- [ ] **Step 3: Implement backup helpers**

Create `src/db/backup.ts` with:

```ts
export interface SqliteBackupManifest {
  readonly sourcePath: string;
  readonly backupPath: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly tableCounts: Record<string, number>;
}

export interface SqliteRestoreDrillResult {
  readonly backupPath: string;
  readonly sha256: string;
  readonly integrityOk: boolean;
  readonly tableCounts: Record<string, number>;
}
```

Implementation rules:

- use SQLite's online backup path through `better-sqlite3` `db.backup(destinationPath)`;
- create the destination parent directory if it does not exist;
- hash the produced backup with `readFileSync`, `statSync`, and `createHash`;
- open the produced backup with `better-sqlite3`;
- query `PRAGMA integrity_check`;
- count known application tables only;
- close every DB in `finally`;
- do not modify source DB during restore drill.
- include a WAL-mode regression test where a committed row survives backup and restore drill.

- [ ] **Step 4: Run GREEN backup tests**

Run:

```powershell
npm run test:unit -- src/db/backup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing CLI tests**

Extend `src/cli/kl.test.ts`:

- `db-backup create --db .ai/tmp/m5/knowledge-loop.db --out .ai/tmp/m5/backups/knowledge-loop.backup.db` returns `command: "db-backup"`, `action: "create"`, and manifest hash;
- `db-backup restore-drill --backup .ai/tmp/m5/backups/knowledge-loop.backup.db` returns `integrityOk: true`;
- unknown action and missing values throw `UsageError`;
- source and destination same path is rejected.

- [ ] **Step 6: Run RED CLI tests**

Run:

```powershell
npm run test:unit -- src/cli/kl.test.ts
```

Expected: FAIL because `db-backup` command is not implemented.

- [ ] **Step 7: Implement CLI command**

Modify `src/cli/kl.ts`:

- import backup helpers;
- add result interfaces for `KlDbBackupCommandResult`;
- include `db-backup` in `KlCommandResult`;
- add `db-backup` to unknown-command help text;
- implement `db-backup create --db` with a caller-provided source SQLite path and `--out` with a caller-provided backup path;
- implement `db-backup restore-drill --backup` with a caller-provided backup path.

- [ ] **Step 8: Add runbook and update M5 review**

Create `docs/runbooks/m5-backup-restore.md` with exact commands. The runbook must include a prep step that creates and migrates the scratch DB before backup. Use a repo-local helper command or an `npx tsx -e` command equivalent to:

```powershell
npx tsx -e "import Database from 'better-sqlite3'; import { mkdirSync } from 'node:fs'; import { dirname } from 'node:path'; import { applyMigrations } from './src/db/migrations.ts'; const dbPath = '.ai/tmp/m5/knowledge-loop.db'; mkdirSync(dirname(dbPath), { recursive: true }); const db = new Database(dbPath); try { applyMigrations(db); db.prepare('INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status) VALUES (?, ?, ?, ?, ?)').run('m5-drill', 'README.md', 'M5 Drill', 'sha256-demo', 'ingested'); } finally { db.close(); }"
```

Then document:

```powershell
npm run kl -- db-backup create --db .ai/tmp/m5/knowledge-loop.db --out .ai/tmp/m5/backups/knowledge-loop.backup.db
npm run kl -- db-backup restore-drill --backup .ai/tmp/m5/backups/knowledge-loop.backup.db
```

Update `docs/reviews/M5.md` backup section from pending implementation to deterministic evidence once tests and a scratch restore drill pass.

- [ ] **Step 9: Write checkpoint**

Create `.ai/checkpoints/part-m5-backup-restore-drill/step-1.md` recording RED/GREEN tests, CLI smoke, backup manifest hash, restore drill integrity, and remaining M5 work.

- [ ] **Step 10: Run checks**

Run:

```powershell
npm run test:unit -- src/db/backup.test.ts src/cli/kl.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 11: Commit and push this slice**

After reviewers approve:

```powershell
git add src/db/backup.ts src/db/backup.test.ts src/cli/kl.ts src/cli/kl.test.ts docs/runbooks/m5-backup-restore.md docs/reviews/M5.md .ai/checkpoints/part-m5-backup-restore-drill/step-1.md
git commit -m "feat: add m5 backup restore drill"
git push -u origin HEAD
```

Expected: commit and push succeed.

---

## Task 3: Read-Only Operational Dashboard

**Task id:** `part-m5-ops-dashboard`

**Files:**
- Create: `src/ops/dashboard.ts`
- Create: `src/ops/dashboard.test.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/api/contracts.test.ts`
- Modify: `src/api/handlers.ts`
- Modify: `src/api/handlers.test.ts`
- Create: `src/app/api/ops/dashboard/route.ts`
- Modify: `src/app/api/_shared/route-adapter.test.ts`
- Modify: `src/cli/kl.ts`
- Modify: `src/cli/kl.test.ts`
- Create: `docs/runbooks/m5-ops-dashboard.md`
- Modify: `docs/reviews/M5.md`
- Create: `.ai/checkpoints/part-m5-ops-dashboard/step-1.md`

- [ ] **Step 1: Write failing dashboard domain tests**

Create `src/ops/dashboard.test.ts` proving a migrated scratch DB returns:

- counts for `sources`, `chunks`, `concepts`, `pages`, `mastery`, and `trace_events`;
- recent trace event count;
- adapter breakdown from `sources.adapter_id`;
- `generatedAt` from injected clock;
- no writes by checking counts before and after.

- [ ] **Step 2: Run RED dashboard tests**

Run:

```powershell
npm run test:unit -- src/ops/dashboard.test.ts
```

Expected: FAIL because `src/ops/dashboard.ts` does not exist.

- [ ] **Step 3: Implement dashboard summary builder**

Create `src/ops/dashboard.ts` with:

```ts
export interface OpsDashboardSummary {
  readonly generatedAt: string;
  readonly tableCounts: Record<string, number>;
  readonly sourceAdapters: Array<{ adapterId: string; sourceCount: number; failedCount: number }>;
  readonly publicPageCount: number;
  readonly privatePageCount: number;
  readonly masteryCount: number;
  readonly recentTraceEventCount: number;
}

export function buildOpsDashboardSummary(
  db: Database.Database,
  options?: { now?: () => Date }
): OpsDashboardSummary;
```

Implementation must use read-only `SELECT` statements and no mutations.

- [ ] **Step 4: Run GREEN dashboard domain tests**

Run:

```powershell
npm run test:unit -- src/ops/dashboard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing API/CLI/route tests**

Add tests for:

- `GET /api/ops/dashboard` in `src/api/contracts.test.ts`;
- pure handler authenticated success and unauthenticated rejection in `src/api/handlers.test.ts`;
- route wrapper in `src/app/api/_shared/route-adapter.test.ts`;
- `npm run kl -- ops-dashboard --db .ai/tmp/m5/knowledge-loop.db` result shape in `src/cli/kl.test.ts`.

- [ ] **Step 6: Run RED integration tests**

Run:

```powershell
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Expected: FAIL because dashboard API/CLI wiring is not implemented.

- [ ] **Step 7: Implement API, route, and CLI wiring**

Modify:

- `src/api/contracts.ts`: add read-only `ops.dashboard` route for `GET /api/ops/dashboard`.
- `src/api/handlers.ts`: dispatch route to `buildOpsDashboardSummary(context.db)`.
- `src/app/api/ops/dashboard/route.ts`: export `GET` through `createApiRouteHandler("GET", "/api/ops/dashboard")`, `runtime = "nodejs"`.
- `src/cli/kl.ts`: add `ops-dashboard --db` with a caller-provided SQLite path.

- [ ] **Step 8: Add dashboard runbook and update M5 review**

Create `docs/runbooks/m5-ops-dashboard.md` with:

```powershell
npm run kl -- ops-dashboard --db .ai/tmp/m5/knowledge-loop.db
```

Update `docs/reviews/M5.md` dashboard section with deterministic API/CLI evidence.

- [ ] **Step 9: Write checkpoint**

Create `.ai/checkpoints/part-m5-ops-dashboard/step-1.md` with RED/GREEN tests, handler/route/CLI coverage, and remaining M5 closure items.

- [ ] **Step 10: Run checks**

Run:

```powershell
npm run test:unit -- src/ops/dashboard.test.ts src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 11: Commit and push this slice**

After reviewers approve:

```powershell
git add src/ops/dashboard.ts src/ops/dashboard.test.ts src/api/contracts.ts src/api/contracts.test.ts src/api/handlers.ts src/api/handlers.test.ts src/app/api/ops/dashboard/route.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.ts src/cli/kl.test.ts docs/runbooks/m5-ops-dashboard.md docs/reviews/M5.md .ai/checkpoints/part-m5-ops-dashboard/step-1.md
git commit -m "feat: add m5 ops dashboard"
git push -u origin HEAD
```

Expected: commit and push succeed.

---

## Task 4: M5 Review Note And Final Deterministic Verification

**Task id:** `part-m5-review-note`

**Files:**
- Modify: `docs/reviews/M5.md`
- Create: `.ai/checkpoints/part-m5-review-note/step-1.md`

- [ ] **Step 1: Run final deterministic verification**

Run:

```powershell
npm run test:unit -- src/adapters/git-repo.test.ts src/adapters/config.test.ts src/db/backup.test.ts src/ops/dashboard.test.ts
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
npm run check
git diff -- src/engine
```

Expected:

- all test commands pass;
- `git diff -- src/engine` has no output for M5 genericity proof;
- no `docs/AUDIT-MANUAL.md` changes are staged.

- [ ] **Step 2: Update M5 review note**

Modify `docs/reviews/M5.md`:

- set status to deterministic M5 development evidence recorded;
- list second adapter proof and zero engine diff;
- list backup restore drill proof;
- list dashboard API/CLI proof;
- explicitly state any remaining live/human gates from M1-M4 are not closed by M5.

- [ ] **Step 3: Write checkpoint**

Create `.ai/checkpoints/part-m5-review-note/step-1.md` recording final deterministic verification commands and results.

- [ ] **Step 4: Commit and push this slice**

After reviewers approve:

```powershell
git add docs/reviews/M5.md .ai/checkpoints/part-m5-review-note/step-1.md
git commit -m "docs: record m5 deterministic review"
git push -u origin HEAD
```

Expected: commit and push succeed.

---

## Final Verification Before M5 Closure

Run from `G:\knowledge-loop` after all four tasks land:

```powershell
npm run check
git status --short --branch
git diff -- src/engine
```

Expected:

- typecheck, lint, and unit tests pass;
- current branch is synced after push except user-owned untracked files;
- `git diff -- src/engine` has no output for the genericity proof;
- `docs/reviews/M5.md` clearly separates M5 deterministic completion from earlier live gates that remain pending.
