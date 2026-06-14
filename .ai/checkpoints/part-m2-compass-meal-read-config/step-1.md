# part-m2-compass-meal-read-config step 1

## Status

completed_with_concerns

## Scope

Investigated the Nutritionist meal-read dry-run path for M2 and implemented the smallest config/CLI override that avoids treating `/api/meal-plan/today` as the only possible compass-health contract.

## Findings

- `src/agents/dry-run.ts` was the direct URL construction site for `GET {compassHealthBaseUrl}/api/meal-plan/today?date=...`.
- Tests that locked the old default existed in `src/agents/dry-run.test.ts`, `src/cli/agent-config.test.ts`, `src/agents/day-runner.test.ts`, and broader `src/cli/kl.test.ts`.
- The agent config/defaults path is centralized in `src/agents/config.ts`; CLI overrides flow through `agentDryRunOverrides()` in `src/cli/kl.ts`.

## Change

- Added optional `nutritionistMealReadUrlTemplate` to agent runtime config and dry-run defaults.
- Template must include `{date}` and must be either an absolute `http(s)` URL or a root-relative URL path.
- Root-relative templates are resolved against `compassHealthBaseUrl`.
- Default behavior remains `/api/meal-plan/today?date={date}`, preserving existing dry-run output.
- Added CLI flag `--nutritionist-meal-read-url-template` to agent dry-run commands that already accept service URL overrides.

## Verification

- RED: `npm run test:unit -- src/agents/dry-run.test.ts src/agents/config.test.ts src/cli/agent-config.test.ts` failed before implementation for the new tests.
- GREEN: `npm run test:unit -- src/agents/dry-run.test.ts src/agents/config.test.ts src/cli/agent-config.test.ts` passed, 22 tests.
- Related tests: `npm run test:unit -- src/agents/dry-run.test.ts src/agents/config.test.ts src/cli/agent-config.test.ts src/agents/day-runner.test.ts src/cli/kl.test.ts` passed, 118 tests.
- Typecheck: `npm run typecheck` passed.
- Lint: `npm run lint` passed.

## Review Fix

- Quality review found root-relative templates with backslashes could escape `compassHealthBaseUrl` through URL normalization.
- RED: `npm run test:unit -- src/agents/dry-run.test.ts src/agents/config.test.ts` failed with 2 expected failures for `/\evil.example/...` templates.
- GREEN: `npm run test:unit -- src/agents/dry-run.test.ts src/agents/config.test.ts` passed, 17 tests, after rejecting backslashes in Nutritionist meal-read templates.

## Concerns

- This is still a dry-run/config contract change. It does not prove live compass-health auth or response shape.
- Known live facts remain unresolved here: `/api/meal-plan/today?date=2026-06-14` returned 404 and `/api/meal-plan/week?date=2026-06-14` returned 401.
- `docs/AUDIT-MANUAL.md` was already untracked and was not modified.
