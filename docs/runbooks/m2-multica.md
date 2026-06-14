# M2 Multica And Agent Profiles Runbook

This runbook records the external Multica and pi-harness boundary for the M2 orchestration spine.

## Frozen Repositories

Do not modify the Multica repository at `G:\multica-ai-multica-https-github-com`.
Do not run pi-harness scaffolding that writes into `G:\pi-harness`.
Agent profiles and dry-run configuration for this project live in this repository.

## Multica Self-Host

Run Multica from its own checkout after preparing that checkout according to Multica's own self-hosting docs:

```powershell
Set-Location G:\multica-ai-multica-https-github-com
docker compose -f docker-compose.selfhost.yml up -d
```

This runbook deliberately does not include file creation or edit commands for the Multica checkout. The documented shortcut in that repository is `make selfhost`. If local images need to be rebuilt, use Multica's documented build compose flow from that checkout.

Expected local endpoints:

- App: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:8080`

## Knowledge-Loop Config

Use `config/multica/selfhost.env.example` as the local variable template. Keep credential values empty in committed files and provide them only through the local shell or untracked environment files.

Use `config/multica/board-publish.example.json` as the declarative publish mapping. Its `contractStatus` is `inferred_live_smoke_pending`, so treat the endpoints as candidates until a running Multica instance confirms them. The current observed Multica board-like surface is issues:

- `create_task`: `POST http://127.0.0.1:8080/api/issues`
- `add_comment`: `POST http://127.0.0.1:8080/api/issues/{issueId}/comments`

The comment endpoint needs a concrete issue id from a prior created task or an existing Multica issue. Do not invent a board id until a running Multica instance proves the workspace or issue-board contract.

## Dry-Run First

Run these from `G:\knowledge-loop`:

```powershell
npm run kl -- agent --dry-run --role librarian --date 2026-06-13
npm run kl -- agent --dry-run --role scholar --phase morning-plan --date 2026-06-13
npm run kl -- agent --dry-run --role nutritionist --date 2026-06-13
npm run kl -- agent-day --dry-run --date 2026-06-13
```

Dry-run mode prints intended Multica actions and keeps `externalWrites` empty.

## Manual Live Agent-Day Smoke (Gated)

The manual trigger is available only with an explicit `--live` flag and explicit Multica publish endpoints. It is the M2 bridge toward the plan's "scheduler firing or manually triggered" criterion, but it does not by itself prove the two-day hands-free scheduler requirement.

Keep bearer values in the local shell only:

```powershell
$env:KL_AGENT_READ_BEARER_TOKEN = "<local knowledge-loop token if required>"
$env:KL_MULTICA_BEARER_TOKEN = "<local Multica token if required>"

npm run kl -- agent-day --live `
  --date 2026-06-13 `
  --knowledge-loop-url http://127.0.0.1:3000 `
  --compass-health-url http://127.0.0.1:8000 `
  --board daily-plan `
  --multica-create-task-url http://127.0.0.1:8080/api/issues `
  --multica-add-comment-url http://127.0.0.1:8080/api/issues/<issue-id>/comments
```

The `--multica-add-comment-url` value must be a concrete endpoint confirmed against a running Multica instance. Because `config/multica/board-publish.example.json` is still `inferred_live_smoke_pending`, treat the issue/comment URLs as candidate wiring until a live smoke confirms the board contract.

## Scheduler Dry-Run

Before installing any daemon, cron job, or Windows scheduled task, verify scheduler intent deterministically:

```powershell
npm run kl -- agent-schedule --dry-run `
  --now 2026-06-14T07:30:00+08:00 `
  --timezone Asia/Shanghai `
  --daily-at 07:30 `
  --config config/agents.example.json
```

This prints whether the daily `agent-day` run is due, the local board-day window, the exact dry-run `agent-day` argv the scheduler would invoke, and the embedded dry-run day plan. It does not start a timer, call Multica, call compass-health, or prove the M2 two-day hands-free requirement.

## Scheduler Live Single-Shot Trigger

`agent-schedule --live` is a single invocation entry point that an external scheduler can call. It is not a daemon, does not install Windows Task Scheduler or cron, and does not make the M2 hands-free proof by itself.

Use the same bearer-token environment variables as `agent-day --live`:

```powershell
$env:KL_AGENT_READ_BEARER_TOKEN = "<fallback source read token if required>"
$env:KL_AGENT_KNOWLEDGE_LOOP_BEARER_TOKEN = "<knowledge-loop read token if different>"
$env:KL_AGENT_COMPASS_HEALTH_BEARER_TOKEN = "<compass-health read token if different>"
$env:KL_MULTICA_BEARER_TOKEN = "<local Multica token if required>"

npm run kl -- agent-schedule --live `
  --now 2026-06-14T07:30:00+08:00 `
  --timezone Asia/Shanghai `
  --daily-at 07:30 `
  --config config/agents.example.json `
  --knowledge-loop-url http://127.0.0.1:3000 `
  --compass-health-url http://127.0.0.1:8000 `
  --board daily-plan `
  --multica-create-task-url http://127.0.0.1:8080/api/issues `
  --multica-add-comment-url http://127.0.0.1:8080/api/issues/<issue-id>/comments
```

When the computed schedule timing is `due: false`, the command returns a `live` result with `status: "skipped"` and `reason: "not_due"` plus the schedule window evidence. That skipped path must not fetch Knowledge-Loop, compass-health, or Multica, and it does not require live Multica endpoint flags.

When the computed timing is `due: true`, the command requires explicit `--multica-create-task-url` and `--multica-add-comment-url` values and then runs the same live execution path as `agent-day --live`. The result embeds the schedule timing and the live day-run report. This proves only that the single trigger can produce a day run at the scheduled time. Real M2 evidence still requires Windows Task Scheduler or cron to invoke this command hands-free, capture two consecutive board days, and preserve the live board evidence.

## Offline Live-Smoke Manifest

Use `config/multica/live-smoke.example.json` as the pre-live board-day contract. It defines the two consecutive board days and the required evidence for each M2 item: Librarian ingest comment, Scholar morning study task, Nutritionist meal task, and Scholar evening mastery comment.

The manifest is offline-only and keeps `contractStatus` at `inferred_live_smoke_pending`. It validates what the future live smoke must prove, but it does not call Multica, install a scheduler, prove live board posting, or close M2.

## Offline Live-Smoke CLI Validation

Before any live publish attempt, validate the manifest through the CLI entry from `G:\knowledge-loop`. The command entry is `kl agent-live-smoke`; from this checkout, run it through the project script:

```powershell
npm run kl -- agent-live-smoke --dry-run `
  --manifest config/multica/live-smoke.example.json `
  --date 2026-06-14 `
  --board daily-plan
```

This is a manifest-validation dry run only. It reads the manifest inside this checkout, compares the selected board day with the dry-run agent-day plan, prints validation status plus the dry-run plan, and keeps `externalWrites` empty. It must not fetch Knowledge-Loop, compass-health, or Multica endpoints, must not use bearer tokens, must not read or write the Multica or pi-harness checkouts, and must not accept `--live`.

A passing result means the checked-in manifest still describes the offline board-day contract for the requested date. It does not execute Multica, install a scheduler, prove live board posting, prove two consecutive hands-free days, or close M2.

## Offline Board-Publish Config Validation

Before the live gate, validate the checked-in Multica publish mapping separately from the live-smoke manifest:

```powershell
npm run kl -- agent-board-config --dry-run `
  --config config/multica/board-publish.example.json
```

This command validates only the offline publish config. It reads the publish config inside this checkout and checks that the issue/comment mappings are HTTP-only, secret-free, filesystem-free, still marked `inferred_live_smoke_pending`, and shaped for the current dry-run action types. It must not fetch Knowledge-Loop, compass-health, or Multica endpoints, must not use bearer tokens, must not publish board items, must not read or write the Multica or pi-harness checkouts, and must not accept `--live`.

A passing result means `config/multica/board-publish.example.json` is internally safe to carry into the live gate. It does not mean the live client renders this payload template yet; `agent-day --live` still uses explicit endpoint flags until the board contract is confirmed. It does not prove the Multica API contract, resolve `{issueId}`, install a scheduler, prove live board posting, prove two consecutive hands-free days, or close M2.

## Offline Preflight Report

Before attempting a live smoke, run the offline preflight report to confirm the scheduler dry-run date and the manifest's first evidence day are aligned:

```powershell
npm run kl -- agent-preflight --dry-run `
  --now 2026-06-14T07:30:00+08:00 `
  --timezone Asia/Shanghai `
  --daily-at 07:30 `
  --manifest config/multica/live-smoke.example.json `
  --board-config config/multica/board-publish.example.json `
  --config config/agents.example.json
```

The report embeds the scheduler dry-run output, the live-smoke manifest validation result, the board publish config validation result, deterministic offline checks, and the M2 live proofs that remain `not_verified_offline`. It is the unified offline report for scheduler intent, live-smoke manifest shape, and board publish config shape. It must not fetch Knowledge-Loop, compass-health, or Multica endpoints, must not use bearer tokens, must not install a scheduler, must not touch the Multica or pi-harness checkouts, and must not accept `--live`.

`ready_for_live_smoke` means only that the offline scheduler intent, manifest contract, and board publish config are internally aligned for the selected board date. It does not execute Multica, prove live board posting, prove two consecutive hands-free days, verify failure blockers, verify evening mastery deltas, surface live daily cost, or close M2.

## Offline Failure-Blocker Smoke

Before the real failure drill, run an offline smoke that simulates one source endpoint failure with in-memory clients:

```powershell
npm run kl -- agent-failure-smoke --dry-run `
  --date 2026-06-14
```

By default, this fails the Scholar morning-plan read for `/api/plan/today`, verifies the day runner publishes a blocker action, and confirms later independent agents still run. To target a different planned read, pass `--role`, `--phase`, `--method`, and `--url-includes`.

This command must not fetch Knowledge-Loop, compass-health, or Multica endpoints, must not use bearer tokens, must not kill a real service, must not publish board items, must not touch the Multica or pi-harness checkouts, and must not accept `--live`. A passing result is only an offline simulation of the blocker path; it does not prove the required live kill-API drill, live board blocker visibility, or M2 completion.

## Evening Mastery Report Rendering

The live Scholar evening phase reads the exact `GET /api/mastery/summary` endpoint and renders the returned `routeId: "mastery.summary"` API success body into the Multica comment body before publishing. The rendered body includes the date, source endpoint, mastery row count, weak-spot count, top weak spot score, diagnosis run id, and row details.

This renderer is deterministic and redaction-safe, but it does not call the API itself and does not prove the live evening board post. If the mastery summary body is malformed, unwrapped, or from a lookalike endpoint, the live runner publishes a blocker instead of a static or mismatched mastery report. The M2 live gate still requires comparing the captured evening Scholar board comment against the live `GET /api/mastery/summary` response.

## Daily Cost Visibility

The day runner report always includes an `llmCost` summary with per-agent entries. Dry-run reports stay `dry-run-no-llm`. Live reports without a pi-harness cost snapshot client are explicit `not_configured` entries with zero cost, so the live smoke cannot accidentally treat dry-run cost metadata as real usage.

When a future pi-harness cost snapshot client is injected, each agent entry can surface the external `pi-harness-live` cost, currency, and detail, and the day report totals those entries. This wiring makes cost visible in the agent-day report, but it does not prove the pi-harness dependency is installed, does not read the pi-harness checkout, and does not close the M2 live cost proof until a real run captures non-placeholder cost data.

## pi-harness Dependency Preflight

Before claiming the pi-harness dependency is ready for the live gate, run the read-only dependency preflight:

```powershell
npm run kl -- agent-harness-dependency --dry-run --harness-path G:\pi-harness
```

This checks the external package metadata, required `dist` entry files, CLI bin target, scaffolding script presence, and `git --no-optional-locks -C <path> status --short` for the pi-harness checkout. Required paths must be files, not directories. It does not install, link, import, run scaffolding, or modify `G:\pi-harness`. A blocked result means the dependency proof is not ready; the default report redacts the external path and reports only the dirty entry count rather than raw filenames, and read/git inspection failures use sanitized errors.

After the live environment has linked or installed `pi-harness`, add the explicit runtime import proof:

```powershell
npm run kl -- agent-harness-dependency --dry-run `
  --harness-path G:\pi-harness `
  --runtime-package pi-harness
```

The runtime proof dynamically imports only the fixed package specifiers `pi-harness` and `pi-harness/cli`, then verifies the public runtime symbols needed by the agent bridge. This keeps `package.json` clean-clone safe: do not commit a local `file:` dependency to `G:\pi-harness`. A passing runtime import still does not close M2 unless the external pi-harness checkout is clean and the remaining live board-day proofs pass.

## Offline Board-Day Evidence Validation

After real board observations are captured, validate the evidence file against the live-smoke manifest:

```powershell
npm run kl -- agent-board-evidence --dry-run `
  --evidence config/multica/board-day-evidence.example.json `
  --manifest config/multica/live-smoke.example.json
```

This command checks only the structure of an observed board-day evidence file. It reads the evidence and manifest inside this checkout, confirms the two observed days and board items align to the manifest, and rejects secret-like values, filesystem paths, fake completion fields, and URL credentials. It must not fetch Multica, read bearer tokens, publish board items, read or write the Multica or pi-harness checkouts, or accept `--live`.

A passing result means the evidence file is shaped for later human/live verification. It does not prove hands-free execution, prove live board posting, verify Multica availability, satisfy the two-day requirement, or close M2.

## Live Gate

Before enabling live publish, require passing `agent-live-smoke --dry-run`, `agent-board-config --dry-run`, and `agent-preflight --dry-run`; then verify a running Multica self-host instance with a bearer-authenticated smoke test and confirm the workspace or issue-board identifiers. The live agent client must use HTTP endpoints only and must not read or write files in the Multica checkout.

After live board observations are captured, run `agent-board-evidence --dry-run` against the captured evidence file. That validation is a post-observation shape check, not a pre-live gate and not an M2 completion claim.
