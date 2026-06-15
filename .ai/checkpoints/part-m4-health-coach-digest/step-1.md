## Step 1

What I did: wired the coach digest dry-run surface through the API manifest, bearer-protected POST handler, Next route wrapper, and `health-coach-digest` CLI command.

Files modified:
- `src/api/contracts.ts`
- `src/api/contracts.test.ts`
- `src/api/handlers.ts`
- `src/api/handlers.test.ts`
- `src/app/api/health/coach-digest/generate/route.ts`
- `src/app/api/_shared/route-adapter.test.ts`
- `src/cli/kl.ts`
- `src/cli/kl.test.ts`
- `.ai/checkpoints/part-m4-health-coach-digest/step-1.md`

Offline digest proof: handler and CLI tests generate a `2026-06-15` offline snapshot with `offline: true`, assert rendered markdown/source hash/trace events, persist one `coach_digest_snapshots` row and one `health_trace_events` row, and prove fetch is not called even when a compass base URL is present.

API proof: `health.coach-digest.generate` is documented as bearer-protected POST `/api/health/coach-digest/generate`; pure handler tests cover success, deterministic `now`, deterministic API runId, compass online fetch, malformed date, non-boolean offline, blank compassBaseUrl, and bad compassBaseUrl without partial writes. Route adapter tests cover module method export, `runtime = "nodejs"`, bearer-authenticated success, unauthenticated rejection, and malformed unauthenticated JSON being rejected before body parsing.

CLI proof: `health-coach-digest --db <path> --date <YYYY-MM-DD> --dry-run [--offline] [--compass-base-url <url>] [--now <ISO instant>]` returns `{ command: "health-coach-digest", mode: "dry-run", result: { snapshot, renderedMarkdown, sourceHash, traceEvents } }`; tests cover new DB migration, offline no-fetch behavior, injected online fetch, missing/duplicate options, invalid date/now, invalid compass URL, accidental `--offline true`, and rejected publish/live/snapshot-id flags.

HTTP-only compass proof: API and CLI online tests use `https://compass.example/root` via fetch, assert `GET /api/meal-plan/daily-context?date=2026-06-15`, and assert no Authorization header or bearer token is attached.

Tests run:
- `npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts` - passing, 4 files / 256 tests.
- `npm run typecheck` - passing.

Non-completion boundary: publishing remains Task 8; live Windows proof remains Task 6; this checkpoint does not close M4.

Test status: passing
Next step: hand off for the next M4 worker or reviewer slice.
