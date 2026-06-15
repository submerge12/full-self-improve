# M5 Backup Restore Runbook

This runbook creates a migrated scratch SQLite database, writes a deterministic source row, creates a backup, and runs a read-only restore drill.

## Prep scratch database

```powershell
npx tsx -e "import Database from 'better-sqlite3'; import { mkdirSync } from 'node:fs'; import { dirname } from 'node:path'; import { applyMigrations } from './src/db/migrations.ts'; const dbPath = '.ai/tmp/m5/knowledge-loop.db'; mkdirSync(dirname(dbPath), { recursive: true }); const db = new Database(dbPath); try { applyMigrations(db); db.prepare('INSERT INTO sources (adapter_id, doc_ref, title, fingerprint, status) VALUES (?, ?, ?, ?, ?)').run('m5-drill', 'README.md', 'M5 Drill', 'sha256-demo', 'ingested'); } finally { db.close(); }"
```

## Create backup

```powershell
npm run kl -- db-backup create --db .ai/tmp/m5/knowledge-loop.db --out .ai/tmp/m5/backups/knowledge-loop.backup.db
```

The backup command rejects an existing destination by default. For a rerun, choose a new `--out` path or remove one explicit file manually before rerunning.

## Restore drill

```powershell
npm run kl -- db-backup restore-drill --backup .ai/tmp/m5/backups/knowledge-loop.backup.db
```

Expected result: the JSON output reports `command: "db-backup"`, `action: "restore-drill"`, and `result.integrityOk: true`.
