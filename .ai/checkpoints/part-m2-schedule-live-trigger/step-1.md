# part-m2-schedule-live-trigger step 1

## Scope

- Add `agent-schedule --live` as a safe single-shot wrapper around the existing `agent-day --live` path.
- Keep `agent-schedule --dry-run` as an offline scheduler-intent report: no source fetches and no Multica publishes.
- Do not install Windows Task Scheduler, create a daemon, touch Multica, touch pi-harness, stage, commit, or push.

## RED

Command:

```powershell
npm run test:unit -- src/cli/kl.test.ts
```

Observed expected failures before implementation:

- `agent-schedule live mode executes the existing live agent-day path when due` failed with `Unknown option for agent-schedule: --live`.
- `agent-schedule live mode skips without fetching when not due` failed with `Unknown option for agent-schedule: --live`.
- `agent-schedule command validates exactly one mode, live endpoints, and schedule inputs` failed because the old CLI returned `Command agent-schedule supports only --dry-run.`

## GREEN

Command:

```powershell
npm run test:unit -- src/cli/kl.test.ts
```

Observed result after implementation:

- `src/cli/kl.test.ts`: 96 tests passed.

Final targeted verification:

```powershell
npm run test:unit -- src/cli/kl.test.ts src/agents/schedule.test.ts src/agents/day-runner.test.ts src/agents/http-clients.test.ts
npm run typecheck
npm run lint
git diff --check
```

Observed results:

- Targeted tests: 4 files passed, 126 tests passed.
- Typecheck: passed.
- Lint: passed.
- `git diff --check`: passed with only Git LF/CRLF working-copy warnings.

## Behavior Covered

- `agent-schedule` now requires exactly one of `--dry-run` or `--live`.
- `--dry-run` still emits the existing schedule dry-run report and does not fetch.
- `--live` computes schedule timing from `--now`, `--timezone`, `--daily-at`, config, and overrides.
- If timing is not due, `--live` returns `status: "skipped"` with `reason: "not_due"` and schedule evidence, without requiring Multica endpoints or calling fetch.
- If timing is due, `--live` requires explicit Multica create-task and add-comment endpoint flags, then reuses the same live day execution helper as `agent-day --live`.
- The due live path is covered with mocked fetch calls showing 5 source reads and 4 Multica publishes, including service-specific bearer-token behavior.

## Boundary Notes

- This is not a scheduler install and not a background service.
- This does not prove two hands-free board days.
- This does not close M2; external Windows Task Scheduler or cron evidence is still required.
