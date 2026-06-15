# M5 Second Adapter Genericity Proof - Step 1

Worker: M5-1B
Date: 2026-06-15

## What changed

- Registered optional git-repo adapters through adapter runtime config.
- Added runtime config tests for git-repo registration, dual adapter registration, and include/exclude env glob forwarding.
- Added a non-secret example config for a second dataset.
- Created the pending M5 review note.
- Ran a second dataset persistent ingest proof with the existing `GitRepoAdapter` and no `src/engine/` changes.

## Verification

- RED config test: `npm run test:unit -- src/adapters/config.test.ts` failed with 3 failed and 6 passed. The failures showed `createConfiguredSourceAdapters` did not register `KNOWLEDGE_LOOP_GIT_REPO_ROOT`, did not return the git-repo adapter with the markdown adapter, and returned no git-repo refs for include/exclude env globs.
- GREEN adapter/config tests: `npm run test:unit -- src/adapters/git-repo.test.ts src/adapters/config.test.ts` passed with 2 test files and 23 tests passing after reviewer hardening for case-insensitive `.git` direct access, symlink escape rejection, and symlink-to-`.git` alias rejection.
- Second dataset ingest proof: `npx tsx .ai/tmp/part-m5-second-adapter-genericity-proof/run-proof.ts` was blocked in-sandbox by `spawn EPERM`, then passed outside the sandbox. Summary: sourcesSeen 4, sourcesProcessed 4, sourcesSkipped 0, sourcesFailed 0, chunksCreated 5, conceptsCreated 4, pagesCreated 4. Table counts: sources 4, chunks 5, concepts 4, pages 4.
- Engine diff proof: `git diff -- src/engine` produced no output.
- Diff scope proof: `git diff --name-only` listed only `src/adapters/config.test.ts` and `src/adapters/config.ts` among tracked modifications at the time of the proof. `git status --short` also showed untracked `config/adapters/`, `docs/reviews/M5.md`, Worker 1A's untracked `src/adapters/git-repo.test.ts` and `src/adapters/git-repo.ts`, and untracked `docs/AUDIT-MANUAL.md`.
- Broader unit tests: `npm run test:unit -- src/adapters/git-repo.test.ts src/adapters/config.test.ts src/engine/source-adapter.test.ts` passed with 3 test files and 25 tests passing.
- Check command: `npm run check` passed outside the sandbox after the in-sandbox full Vitest run was blocked by `spawn EPERM`. The successful run completed typecheck, lint, and 50 unit test files with 727 tests passing.

## Remaining M5 work

- Backup/restore drill.
- Read-only operational dashboard.
- Final M5 review update after all evidence is recorded.
