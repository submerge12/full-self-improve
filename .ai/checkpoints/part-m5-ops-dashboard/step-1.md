# M5 Ops Dashboard - Step 1

Worker: M5-3B
Date: 2026-06-15

## What changed

- Added the read-only `GET /api/ops/dashboard` API contract, handler, and Next route wrapper.
- Added `ops-dashboard --db` CLI wiring using a read-only SQLite connection with `fileMustExist`.
- Added integration coverage for route manifest lookup, bearer auth, handler response shape, route wrapper export/runtime/auth, and CLI output/error behavior.
- Added `docs/runbooks/m5-ops-dashboard.md` and updated the dashboard section of `docs/reviews/M5.md`.

## RED

Command:

```powershell
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Observed result: failed as expected with 4 failed files and 7 failed tests. Failures showed the missing manifest entry/count, `findApiRoute("GET", "/api/ops/dashboard")` returning `undefined`, handler requests returning 404, missing `../ops/dashboard/route.js`, and `ops-dashboard` being an unknown CLI command.

## GREEN

Command:

```powershell
npm run test:unit -- src/ops/dashboard.test.ts src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Observed result: 5 test files passed, 288 tests passed.

## Post-Review C1 Fix

Reviewer C1 found that the actual `GET /api/ops/dashboard` Next route could create a runtime DB context before authentication, and that the normal runtime context opened the DB read/write and applied migrations. The fix added a read-only route path for this endpoint:

- `createReadOnlyApiRouteHandler()` pre-authorizes from the request headers before opening any DB connection.
- `createReadOnlyRuntimeApiContext()` opens `KNOWLEDGE_LOOP_DB_PATH` read-only with `fileMustExist` and applies no migrations.
- `src/app/api/ops/dashboard/route.ts` now uses the read-only route handler.

Regression RED command:

```powershell
npm run test:unit -- src/app/api/_shared/route-adapter.test.ts
```

Observed RED result: failed as expected before the fix because an unauthenticated actual ops-dashboard request against a missing DB path returned 401 but still created the DB file.

Regression GREEN command:

```powershell
npm run test:unit -- src/app/api/_shared/route-adapter.test.ts
```

Observed GREEN result: 1 test file passed, 25 tests passed.

## Coverage

- Contract: manifest contains `ops.dashboard`; route count is 25; mutation count remains 17; GET matches and POST does not.
- Handler: authenticated request returns `{ summary }` with routeId `ops.dashboard`; unauthenticated request returns 401 with routeId `ops.dashboard`; dashboard-counted tables are unchanged after the handler call.
- Route: module exports `GET`, uses `runtime = "nodejs"`, authenticated web requests return routeId `ops.dashboard`, unauthenticated actual route requests do not create a missing DB, and authenticated actual route requests do not mutate dashboard-counted rows.
- CLI: `ops-dashboard --db` returns/writes JSON with command `ops-dashboard`, mode `mock-persistent`, and dashboard summary shape; missing DB is not created; missing/duplicate `--db` and unknown options are rejected; unknown-command help includes `ops-dashboard`.

## CLI Smoke

- Scratch DB prep with `npx tsx -e ...` was blocked by sandbox `spawn EPERM`.
- Controller rerun with escalation prepared a repo-local scratch DB at `.ai/tmp/m5/controller-m5-3-dashboard-smoke-20260615-2240/knowledge-loop.db`.
- Exact smoke command:

```powershell
npm run kl -- ops-dashboard --db .ai/tmp/m5/controller-m5-3-dashboard-smoke-20260615-2240/knowledge-loop.db
```

Observed result:

- Initial sandbox run was blocked by `tsx`/esbuild `spawn EPERM`.
- Controller rerun with escalation succeeded.
- Returned `command: "ops-dashboard"` and `mode: "mock-persistent"`.
- Table counts: `sources: 1`, `chunks: 1`, `concepts: 0`, `pages: 0`, `mastery: 0`, `trace_events: 1`.
- Source adapter breakdown: `ops-smoke` with `sourceCount: 1`, `failedCount: 0`.
- `recentTraceEventCount`: 1.

## Broader Check

Command:

```powershell
npm run check
```

Observed sandbox result: `tsc --noEmit` and `eslint .` completed, then full Vitest startup failed while loading `vitest.config.ts` because Vite/rolldown hit sandbox `spawn EPERM`.

Controller rerun with escalation passed:

- 52 test files passed.
- 748 tests passed.

## Remaining M5 Closure Items

- Reviewer approval for this Task 3 integration/API/route/CLI/docs slice.
- Final M5 review note and deterministic verification slice.
- Earlier live gates from M2 and M4 remain outside M5 and are not closed by this work.
