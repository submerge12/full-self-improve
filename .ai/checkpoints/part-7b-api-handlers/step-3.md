# Step 3 - Refactor / Verification

## Change

- Tightened TypeScript response/test helper types after the green implementation.
- Kept the handler pure TypeScript with no Next imports and no HTTP listener.
- Confirmed the local status only includes the permitted Part 7B files.
- Replaced broad substring-based handler error mapping with explicit `ApiBadRequestError` parsing errors plus route-specific client-input patterns for quiz and teachback.
- Wrapped synchronous mutation/read-update handlers and trace persistence in one transaction.
- Removed the handler-level async ingest transaction so adapter/preflight awaits no longer run while `db.inTransaction` is true on the shared connection.
- Persisted ingest trace events only after `runPersistentMockIngest(...)` completes. Ingest content persistence and ingest trace persistence are therefore not atomic yet; the ingest engine owns its internal persistence transaction, and the handler deliberately does not hold a wider transaction across awaited adapter work.
- Added regression coverage for trace persistence failure returning 500 and rolling back `quiz.grade` mutation rows, while preserving 400 responses for malformed bodies and client-side missing quiz/teachback concepts/pages.
- Added regression coverage proving async ingest adapter reads observe `db.inTransaction === false`.

## Evidence

Commands:

```powershell
npm run typecheck
npm run test:unit -- src/api/handlers.test.ts
npm run lint
git status --short
```

Results:

- `npm run test:unit -- src/api/handlers.test.ts`: exit code 0, 1 test file passed, 14 tests passed
- `npm run typecheck`: exit code 0 (`tsc --noEmit`)
- `npm run lint`: exit code 0 (`eslint .`)
- `git status --short -- src/api/handlers.ts src/api/handlers.test.ts .ai/checkpoints/part-7b-api-handlers/step-3.md`: only the three permitted files are present, all untracked in this worktree
