# M4 Task7 Checkpoint

Date: 2026-06-15

## Scope

- Added the Coach dry-run role and `daily-health` phase.
- Added `knowledge-loop-coach` profile and safe config support for Coach.
- Added the Coach digest report renderer with success-body validation and secret-safe rendering.
- Updated CLI tests so `agent --dry-run --role coach --date 2026-06-13` is valid and defaults to `daily-health`.
- Updated `agent-day` expectations to the five-step sequence:
  Librarian nightly -> Scholar morning -> Nutritionist daily-meals -> Coach daily-health -> Scholar evening.
- Synced live-smoke and board-day evidence examples/tests for the new Coach item.
- Did not change `src/cli/kl.ts`; existing CLI behavior already accepts Coach through the generic dry-run/config path.

## Coach Dry-Run

- Coach dry-run read uses `POST /api/health/coach-digest/generate` with `{ date, offline: true }`.
- Coach intended action title is `Coach health digest for YYYY-MM-DD`.
- Coach keeps `externalWrites: []`.
- Config rejects invalid role/phase combinations and duplicate phases.
- Coach profile says Coach uses health-extensions APIs and must not read or write compass-health files.
- Publish API and Coach report publish wiring remain Task8.

## Verification

- `npm run test:unit -- src/agents/dry-run.test.ts src/agents/profiles.test.ts src/agents/config.test.ts src/agents/coach-report.test.ts src/cli/kl.test.ts` passed with 5 files / 173 tests.
- `npm run test:unit -- src/agents/day-runner.test.ts src/agents/failure-smoke.test.ts src/agents/live-smoke-manifest.test.ts src/cli/agent-config.test.ts` passed with 4 files / 24 tests.
- `npm run test:unit -- src/agents/board-day-evidence.test.ts src/cli/kl.test.ts` passed with 2 files / 144 tests.
- `npm run check` passed outside the sandbox after the sandboxed Vitest config load hit `spawn EPERM`: typecheck, lint, 49 files / 681 tests.
- `git diff --check` passed.

## Reviews

- Dry-run/profile/config review requested config role-phase validation; fixed and re-reviewed.
- Coach renderer review requested fail-closed URL secret handling for malformed path encoding; fixed and re-reviewed.
- CLI/checkpoint, broader test sync, and board-day evidence sync reviews approved.
