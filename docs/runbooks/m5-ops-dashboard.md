# M5 Ops Dashboard Runbook

## CLI

Run the read-only operational dashboard against a migrated SQLite database:

```powershell
npm run kl -- ops-dashboard --db .ai/tmp/m5/knowledge-loop.db
```

The command opens the database read-only with `fileMustExist`; it does not create a missing database and does not apply migrations.

## API

The API route is:

```http
GET /api/ops/dashboard
```

It requires bearer auth:

```http
Authorization: Bearer <token>
```

The JSON response contains `{ summary }`, where `summary` includes generated time, dashboard table counts, source adapter breakdown, public/private page counts, mastery count, and recent trace event count.

The actual Next route authorizes the bearer token before opening the runtime database. After authorization it opens `KNOWLEDGE_LOOP_DB_PATH` read-only with `fileMustExist` and does not apply migrations.
