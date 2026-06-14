# M4 Health Extensions Design

Date: 2026-06-14.

This specification covers PLAN Section 4, health-extensions, and the Coach agent slice for M4. The user approved TypeScript inside the existing `knowledge-loop` repository on 2026-06-14. The approved direction is a repo-local TypeScript service/module integrated with the existing CLI, API, and agent patterns. `compass-health` remains frozen and read-only; health-extensions may access it only through its public HTTP API.

This is the design specification, not the implementation plan. After spec review, the next step is to use the writing-plans workflow to produce the future team-mode implementation plan.

## Scope

Health-extensions adds deterministic health tracking around the existing knowledge-loop runtime:

- Health data log: weight, sleep, and custom metrics, with manual create/read/update plus CSV import first. UI can come later; the first implementation path should expose CLI/API update behavior.
- Exercise planning and logging: reusable plan templates, generated plans, completed sessions, and completion-rate queries for the Coach agent.
- Sedentary detection: a Windows logger posts active/idle spans; the service computes sedentary streaks and break reminder eligibility. A real >=60-minute sedentary streak remains a live-use gate.
- `compass-health` read-only integration: fetch meals or related health context only through public HTTP API calls; do not read or write its repo, database, exported files, or filesystem.
- Coach agent: produce a daily health digest and post it to the Multica board through the existing M2 board client path.
- Offline/mock mode: deterministic health logic, CSV import, exercise completion, sedentary streaks, and digest rendering work with no LLM key and no external network.

## Non-Goals

- No modification to the `compass-health` repo, database, migrations, or files.
- No filesystem access to `compass-health`; hash proof is recorded by comparing its database or repo state outside the health-extensions write path, not by writing into it.
- No new LLM dependency for deterministic health logic.
- No native Windows tray installation in the first implementation slice; start with adapter contracts and CLI ingestion.
- No M4 completion claim until the real-use gates in this spec are observed and recorded.

## Architecture

Health-extensions should follow the current repo shape: deterministic core modules are pure TypeScript and do not import Next route wrappers; stores use the same knowledge-loop SQLite database and migration flow as the existing runtime; API route metadata lives in `src/api/contracts.ts`; pure handlers live in `src/api/handlers.ts`; Next App Router files delegate through the existing route adapter style; CLI commands are added through `src/cli/kl.ts`; Coach agent behavior follows the M2 dry-run/live board discipline.

Proposed future files are grouped by responsibility:

| Responsibility | Proposed modules/files | Notes |
| --- | --- | --- |
| Schema and validation | `src/health-extensions/schema.ts` | Domain types, status enums, value validation, CSV row shape, date parsing, and public DTOs. |
| Persistence | `src/health-extensions/store.ts` plus a new SQLite migration | CRUD/query helpers over the knowledge-loop DB. Keep SQL and transactions here, not in route wrappers. |
| Health metrics | `src/health-extensions/metrics.ts` | Manual metric entry, conservative update/read rules, unit handling, date-window queries, and CSV import/export round-trip logic. |
| Exercise | `src/health-extensions/exercise.ts` | Template creation, plan creation from templates, session logging, completion-rate query, and Coach summary projection. |
| Sedentary engine | `src/health-extensions/sedentary.ts` | Active/idle span normalization, streak calculation, break reminder eligibility, duplicate-span handling, and deterministic reminder records. |
| Coach digest | `src/health-extensions/coach-digest.ts` | Deterministic digest snapshot generation from metrics, exercise, sedentary, and optional compass-health API read results. |
| Compass API adapter | `src/health-extensions/compass-client.ts` | HTTP-only read client for public `compass-health` endpoints; no path inputs, no local file reads, no mutation methods. |
| Windows logger contract | `src/health-extensions/windows-logger-contract.ts` | JSON contract for active/idle span posts and logger heartbeat; tray/startup installer is a separate live slice. |
| API manifest and handlers | `src/api/contracts.ts`, `src/api/handlers.ts` | Add route IDs, auth modes, request validation, and pure handler dispatch following existing M1-M3 routes. |
| Next route wrappers | `src/app/api/health/.../route.ts` | Thin `runtime = "nodejs"` wrappers using `createApiRouteHandler`. |
| CLI | `src/cli/kl.ts` | Add `health-*` commands with existing option parser style and JSON command result envelopes. |
| Agent integration | `src/agents/dry-run.ts`, `src/agents/profiles.ts`, `src/agents/day-runner.ts` | Add Coach role and dry-run digest phase first; live publish reuses M2 board clients. |
| Config examples | `config/agents.example.json` | Add Coach defaults only when implementation reaches agent integration. |

Storage should stay inside the knowledge-loop SQLite database. PLAN says SQLite/Drizzle; current runtime evidence uses the repo's existing SQLite migration and store pattern. The implementation plan should choose the concrete migration mechanism that matches the checkout at that time, but the tables belong to `knowledge-loop.db`, not a `compass-health` database and not a separate external service database.

## Data Model

All tables include `created_at` and `updated_at` ISO timestamps unless noted. Use integer primary keys consistent with existing SQLite patterns. Store dates as `YYYY-MM-DD` strings and instants as ISO timestamps.

| Table | Key fields | Purpose and constraints |
| --- | --- | --- |
| `health_metrics` | `id`, `metric_key`, `metric_label`, `value`, `unit`, `observed_at`, `source`, `note` | Stores weight, sleep, and custom metric observations. `metric_key` is normalized lowercase kebab-case. `source` is `manual`, `csv`, or `mock`. Values must be finite numbers. Updates preserve the row id and refresh `updated_at`. |
| `health_metric_audit_events` | `id`, `metric_id`, `changed_at`, `changed_by`, `previous_json`, `next_json`, `reason` | Records conservative metric updates. Each update stores the previous and next observation payloads and should be paired with a trace event. Creates and CSV imports can rely on import records plus trace events. |
| `health_metric_imports` | `id`, `source_filename`, `row_count`, `accepted_count`, `rejected_count`, `imported_at`, `content_hash` | Records CSV import runs for audit and idempotency. Hash is over normalized CSV content; duplicate imports should be detected before inserting duplicate observations. |
| `exercise_templates` | `id`, `slug`, `name`, `description`, `default_days`, `active` | Reusable plan templates. `default_days` is JSON with planned sessions and target minutes/reps. |
| `exercise_plans` | `id`, `template_id`, `week_start`, `status`, `generated_from` | Weekly plans created from templates. One active plan per `week_start` unless explicitly archived. |
| `exercise_sessions` | `id`, `plan_id`, `template_session_key`, `scheduled_for`, `completed_at`, `status`, `duration_minutes`, `intensity`, `note` | Tracks planned and ad hoc sessions. Completion rate counts completed sessions over planned sessions for a date window. |
| `sedentary_spans` | `id`, `source_id`, `span_start`, `span_end`, `state`, `confidence`, `received_at` | Logger-ingested spans. `state` is `active`, `idle`, or `unknown`. Reject negative or zero-length spans. Deduplicate by `source_id` when present. |
| `sedentary_streaks` | `id`, `window_start`, `window_end`, `duration_minutes`, `source_span_ids`, `computed_at` | Deterministic streak projections computed from idle spans and active-break boundaries. Streaks >=60 minutes are eligible for break reminders. |
| `break_reminders` | `id`, `streak_id`, `eligible_at`, `status`, `reason`, `delivered_at`, `delivery_channel` | Records reminder eligibility before native notifications. `status` is `eligible`, `suppressed`, `delivered`, or `expired`. Native notifications are live evidence, not required for deterministic engine tests. |
| `coach_digest_snapshots` | `id`, `date`, `metrics_summary_json`, `exercise_summary_json`, `sedentary_summary_json`, `compass_context_json`, `rendered_markdown`, `source_hash`, `published_at`, `publish_result_json` | Immutable daily digest inputs and rendered output. `published_at` is set only after a live Multica publish succeeds. |

## API And CLI Surface

Protected mutation and private read routes use bearer auth, matching existing API auth. Public-read auth is not needed for health data because health records are private.

| Route or command | Auth/mode | Purpose | Validation notes |
| --- | --- | --- | --- |
| `POST /api/health/metrics` / `kl health-metric add` | Bearer / mock-persistent | Add one manual metric observation. | Require metric key, finite value, unit, and ISO observed time. Reject blank labels and unsafe units. |
| `GET /api/health/metrics?metric=...&from=...&to=...` / `kl health-metric list` | Bearer / mock-persistent | Query metric observations for a metric or date window. | Validate date window and limit. Return stable ordering. |
| `PATCH /api/health/metrics/:id` / `kl health-metric update --id <id>` | Bearer / mock-persistent | Update fields on one existing metric observation. | Require an existing id and at least one changed field. Revalidate `metric_key`, `metric_label`, `value`, `unit`, `observed_at`, and `note` with the same rules as create/import. Reject updates that change nothing. Emit a trace event and write a metric audit event with previous and next payloads. |
| `POST /api/health/metrics/import` / `kl health-metric import-csv --file <path>` | Bearer / mock-persistent | Import CSV rows for metrics. | CLI may read the provided CSV path; API accepts uploaded/JSON CSV text. Reject malformed rows with row-level errors and no partial transaction unless explicitly using accepted/rejected import mode. |
| `POST /api/health/exercise/templates` / `kl health-exercise template create` | Bearer / mock-persistent | Create or update an exercise template. | Template slug is unique; default sessions must have valid day offsets and positive target durations. |
| `POST /api/health/exercise/plans` / `kl health-exercise plan create` | Bearer / mock-persistent | Create a weekly plan from a template. | Validate `week_start` as Monday or document chosen week-start rule; prevent accidental duplicate active plans. |
| `POST /api/health/exercise/sessions/complete` / `kl health-exercise complete` | Bearer / mock-persistent | Mark a planned session complete or log an ad hoc completion. | Require positive duration if provided; completion cannot precede scheduled date by an invalid timestamp. |
| `GET /api/health/exercise/completion?from=...&to=...` / `kl health-exercise completion` | Bearer / mock-persistent | Return completion rate for Coach. | Rate is completed planned sessions divided by planned sessions in the window; ad hoc sessions are listed but not counted unless attached to a plan. |
| `POST /api/health/sedentary/spans` / `kl health-sedentary ingest-span` | Bearer / mock-persistent | Ingest active/idle spans from logger or fixtures. | Reject invalid intervals, unknown states, overlapping spans from same source unless normalization rules can merge them deterministically. |
| `GET /api/health/sedentary/summary?from=...&to=...` / `kl health-sedentary summary` | Bearer / mock-persistent | Return streaks and reminder eligibility. | Streak threshold defaults to 60 minutes; date window required for long queries. |
| `POST /api/health/break-reminders/evaluate` / `kl health-break-reminder evaluate` | Bearer / mock-persistent | Compute reminder records from sedentary streaks. | Deterministic and idempotent for same span set and threshold. Does not send native notifications. |
| `POST /api/health/coach-digest/generate` / `kl health-coach-digest --date <date> --dry-run` | Bearer / dry-run or mock-persistent | Generate the daily digest snapshot without publishing. | Requires deterministic local data only; compass-health context is optional and marked unavailable in offline mode. |
| `POST /api/health/coach-digest/publish` / `kl agent --dry-run --role coach --phase daily-health` then live agent-day path | Bearer plus Multica live gate | Publish a generated digest to Multica through the existing board client. | Dry-run first keeps `externalWrites: []`; live requires explicit board endpoints and captured publish evidence. |
| Windows logger POST contract | Bearer / adapter contract | Logger sends `{sourceId, spanStart, spanEnd, state, confidence}` to span ingestion route. | First slice uses CLI/file fixtures. Tray startup, sleep/wake behavior, and native notifications are live evidence slices. |

The Coach role should extend M2 patterns:

- Add `coach` to agent roles only in the agent integration slice.
- Add phase `daily-health`.
- Dry-run reads `POST /api/health/coach-digest/generate` or the equivalent handler and emits one intended Multica action with no external writes.
- Live publish uses the existing board client and blocker behavior. If health summary generation fails, Coach posts a blocker instead of a static digest.
- LLM cost remains `dry-run-no-llm` unless a future live pi-harness path records cost. The digest renderer itself must not require an LLM.

## Deterministic Rules

Metric import:

- CSV columns: `metric_key`, `metric_label`, `value`, `unit`, `observed_at`, optional `note`.
- Normalize metric keys to lowercase kebab-case; reject rows that normalize to empty.
- Import report includes accepted and rejected rows with row numbers.
- Export/list then import into an empty DB should round-trip the same normalized observations.

Metric update:

- Update only an existing observation by id; there is no upsert behavior.
- Permit changes to label, value, unit, observed time, and note after full validation. Metric key changes are allowed only if the normalized new key is valid and the audit event records the previous key.
- Preserve `source` unless the implementation has an explicit domain reason to change it through a validated field.
- Emit a trace event and write a metric audit event containing previous and next payloads in the same transaction as the update.
- Return the updated observation plus audit id so CLI/API callers can cite the correction.

Exercise completion:

- Completion rate query returns `{planned, completed, missed, rate}` for the requested window.
- `completed` counts sessions with `status = completed` and `completed_at` inside or attached to the plan window.
- `missed` is planned sessions scheduled before the query end without completion.
- Coach digest uses the same completion-rate helper as API/CLI, not a separate calculation.

Sedentary streaks:

- Idle spans separated by short `unknown` gaps may be merged only if the gap threshold is explicit in config or function options.
- Any `active` span of sufficient duration breaks a sedentary streak.
- Reminder eligibility is based on streak duration >=60 minutes and a cooldown rule recorded in `break_reminders`.
- Deterministic reminder records are the first proof. Native Windows notification proof is a live slice and does not replace DB evidence.

Compass-health read-only proof:

- Health-extensions stores only HTTP response summaries and source URLs, not `compass-health` file paths.
- Read client accepts base URL and bearer token; it rejects file URLs, Windows paths, URL credentials, and non-HTTP protocols.
- M4 live review records `compass-health` database file hashes before first live health-extensions use and after one full week of health-extensions use. The hashes must be identical. This proof is collected outside the health-extensions service write path; the health service itself must not write that repo or database.

## Testing Strategy

Offline/mock verification:

- Unit tests for metric validation, metric update audit behavior, CSV normalization, import idempotency, exercise completion rates, sedentary streak calculation, reminder eligibility, digest rendering, and compass-health HTTP client URL validation.
- Store tests against in-memory SQLite or a temp DB with migrations applied.
- API handler tests for every route: success envelope, auth failure, malformed body, malformed query, rollback on persistence failure where relevant.
- Route-adapter tests for actual Next route modules, `runtime = "nodejs"`, bearer rejection before body parsing, and context cleanup.
- CLI tests for each `health-*` command and Coach dry-run command output shape.
- No-key check: clearing LLM provider variables must still pass deterministic health tests and digest generation.
- CSV round-trip: export/list normalized rows, import into an empty DB, query returns identical normalized values.
- Metric update proof: CLI/API update changes the intended fields only, rejects invalid changes, records previous/next audit payloads, emits trace, and rolls back audit if the update fails.
- Compass-health read-only/hash proof test path: URL validation and mock HTTP reads in unit tests; live review records external database hash proof before first use and after one full week of health-extensions use.

Live gates:

- Real >=60-minute sedentary streak observed from the Windows logger and a break reminder recorded within 5 minutes.
- Coach daily health digest posted to the Multica board with captured board item/comment URL or id.
- `compass-health` database file hash/read-only proof recorded before first live health-extensions use and after one full week of health-extensions use, with identical hashes.
- Section 0 frozen-repo and mock-mode criteria rechecked or explicitly baselined.
- No M4 complete status unless all Section 4 checklist rows and the gates above are satisfied.

## Phased Future Work Slices

These slices are intentionally small and disjoint for future team-mode work:

1. Schema/store core: add health tables, migrations, domain types, store helpers, and store tests.
2. Metrics + CSV import/query/update CLI/API: add metric entry, list/query, conservative update with audit events, CSV import, route manifest entries, pure handlers, route wrappers, CLI commands, and CSV round-trip/update tests.
3. Exercise template/plan/session completion: add template, weekly plan, session completion, completion-rate helper, CLI/API, and tests.
4. Sedentary span ingestion + streak/reminder engine: add span ingestion, streak computation, break reminder records, CLI/API, and deterministic tests.
5. Coach digest dry-run/API/CLI: generate daily digest snapshots from local deterministic data and optional mock compass-health HTTP context.
6. Windows logger/live alert evidence: build the logger adapter/tray/startup slice, ingest real active/idle spans, and record the >=60-minute live alert proof.
7. Multica Coach publish/live review note: add Coach role to agent day sequence, run dry-run first, publish live through the M2 board client, capture board proof, record the one-week compass-health database hash/read-only proof, and write the M4 review note.

The future implementation plan should assign these as separate worker/reviewer slices. Do not merge Windows logger installation, Multica live publishing, or compass-health proof into the early deterministic core slices.
