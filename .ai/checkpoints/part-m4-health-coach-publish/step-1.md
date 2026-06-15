# M4 Health Coach Publish - Step 1

Worker: 8C
Date: 2026-06-15

## API publish

- Added route id `health.coach-digest.publish`.
- Added manifest entry for `POST /api/health/coach-digest/publish` with bearer auth.
- Added handler body parsing for `{ snapshotId: number; dryRun?: boolean }`.
- Dry-run delegates to `publishCoachDigestSnapshot` with `dryRun: true`, returns `status: "dry_run"` and the intended action, and leaves `published_at` / `publish_result_json` null.
- Live API publish uses injected `ApiHandlerContext.coachDigestPublisher` or adapts an injected `boardClient.publish` to the Coach digest action.
- Publisher failure returns the domain `status: "blocked"` result without writing publish metadata.
- Missing, invalid, and unknown snapshot ids map to `400 invalid_request_body`.
- No API response claims M4 completion.

## Route wrapper

- Added `src/app/api/health/coach-digest/publish/route.ts`.
- The wrapper follows the existing route style and exports Node runtime plus `POST = createApiRouteHandler("POST", "/api/health/coach-digest/publish")`.

## CLI publish

- Added `health-coach-digest publish --db ... --snapshot-id ... --dry-run`.
- The CLI returns `command: "health-coach-digest"`, `mode: "dry-run"`, `action: "publish"`, and the dry-run publish result.
- Existing generate behavior remains compatible and keeps its prior result shape without an `action` field.
- Live standalone CLI publish is rejected via `--live`; publish requires exactly one `--dry-run`.

## Executor Coach rendering reference

- Task8A introduced Coach digest rendering validation in the agent executor path.
- CLI agent-day tests now provide a valid `health.coach-digest.generate` response body for completion-path fixtures.

## Malformed digest blocker behavior

- Failure-smoke still uses its own generic fake source body for Coach digest reads.
- With Task8A rendering validation, that body is malformed for `health.coach-digest.generate`, so Coach daily-health records a blocker.
- CLI failure-smoke expectations now document that the selected simulated blocker and the malformed Coach digest blocker can both appear.

## Tests run

Command:

```text
npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts
```

Result:

```text
Test Files  4 passed (4)
Tests       271 passed (271)
```

Typecheck:

```text
npm run typecheck
tsc --noEmit passed
```
