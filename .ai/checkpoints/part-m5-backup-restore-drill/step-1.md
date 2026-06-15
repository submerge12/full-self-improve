# M5 Backup Restore Drill - Step 1

Worker: M5-2B
Date: 2026-06-15

## What changed

- Added `db-backup create` and `db-backup restore-drill` coverage to the `kl` CLI tests.
- Wired the `kl` CLI to the existing `createSqliteBackup` and `runSqliteRestoreDrill` helpers.
- Added the M5 backup/restore runbook.
- Updated only the backup/restore section of the M5 review note.

## RED

Command:

```powershell
npm run test:unit -- src/cli/kl.test.ts
```

Observed result:

- Failed as expected.
- `src/cli/kl.test.ts`: 142 tests, 5 failed, 137 passed.
- Failure summary: `db-backup` was reported as an unknown command, and the unknown-command help text did not list `db-backup`.

## GREEN

Command:

```powershell
npm run test:unit -- src/db/backup.test.ts src/cli/kl.test.ts
```

Observed result:

- Passed.
- 2 test files passed.
- 149 tests passed.

Final rerun:

- `npm run test:unit -- src/db/backup.test.ts src/cli/kl.test.ts` passed again after adding `mode: "maintenance"` to the new `db-backup` CLI result type.
- 2 test files passed.
- 149 tests passed.

Broader check:

- `npm run check` passed `tsc --noEmit`.
- `npm run check` passed `eslint .`.
- `npm run check` failed when the full `vitest run` loaded `vitest.config.ts`; Vite reported `Error: spawn EPERM` from `[plugin externalize-deps]`.
- Controller rerun with escalation passed `npm run check`.
- Escalated result: 51 test files passed and 738 tests passed.

## CLI Smoke

Requested prep command:

```powershell
npx tsx -e "import Database from 'better-sqlite3'; import { mkdirSync } from 'node:fs'; import { dirname } from 'node:path'; import { applyMigrations } from './src/db/migrations.ts'; const dbPath = '.ai/tmp/m5/knowledge-loop.db'; mkdirSync(dirname(dbPath), { recursive: true }); const db = new Database(dbPath); try { applyMigrations(db); db.prepare('INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status) VALUES (?, ?, ?, ?, ?)').run('m5-drill', 'README.md', 'M5 Drill', 'sha256-demo', 'ingested'); } finally { db.close(); }"
```

Observed result:

- Blocked in this sandbox with `Error: spawn EPERM` while `tsx`/esbuild attempted to spawn its service worker.
- Controller rerun with escalation used the same prep command shape with a fresh scratch DB path and succeeded at `.ai/tmp/m5/controller-m5-2-smoke-20260615-2203/knowledge-loop.db`.

CLI smoke command:

```powershell
npm run kl -- db-backup create --db .ai/tmp/m5/controller-m5-2-smoke-20260615-2203/knowledge-loop.db --out .ai/tmp/m5/controller-m5-2-smoke-20260615-2203/backups/knowledge-loop.backup.db
```

Observed result:

- Initial sandbox run was blocked with `Error: spawn EPERM`, `code: 'EPERM'`, `syscall: 'spawn'`, `name: 'TransformError'` from `tsx`/esbuild.
- Controller rerun with escalation succeeded.
- Manifest `byteSize`: 303104.
- Manifest SHA-256: `9842acc35ebeb181cf6833aa365fb300223a12222a3a6c6a3e3dcc287ba6cba7`.
- Manifest table count evidence: `schema_migrations: 3`, `sources: 1`.

Restore drill command:

```powershell
npm run kl -- db-backup restore-drill --backup .ai/tmp/m5/controller-m5-2-smoke-20260615-2203/backups/knowledge-loop.backup.db
```

Observed result:

- Passed.
- Restore SHA-256: `9842acc35ebeb181cf6833aa365fb300223a12222a3a6c6a3e3dcc287ba6cba7`.
- `integrityOk`: `true`.
- Restore table count evidence: `schema_migrations: 3`, `sources: 1`.

## Remaining M5 Work

- Complete read-only operational dashboard evidence.
- Final M5 review update after all M5 deterministic evidence is recorded.
- Earlier M1-M4 live gates remain outside this M5 backup/restore slice.
