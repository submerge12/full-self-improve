## Step 1

What I did: Added the offline `agent-preflight --dry-run` report. The command composes the existing scheduler dry-run report and live-smoke manifest validation, then prints deterministic offline checks plus the M2 live proofs that remain unverified offline. It does not add live clients, install a scheduler, call Multica, call compass-health, fetch knowledge-loop, use bearer tokens, or touch the Multica/pi-harness checkouts.

Command:

```powershell
npm run kl -- agent-preflight --dry-run `
  --now 2026-06-14T07:30:00+08:00 `
  --timezone Asia/Shanghai `
  --daily-at 07:30 `
  --manifest config/multica/live-smoke.example.json `
  --config config/agents.example.json
```

Output fields:

- `command: "agent-preflight"` and `mode: "dry-run"`.
- `result.status`: `ready_for_live_smoke` only when offline checks pass, otherwise `blocked`.
- `result.date`: the scheduler board date derived from `--now`, `--timezone`, and `--daily-at`.
- `result.nonCompletionNotice`: explicit offline-only wording.
- `result.schedule`: embed the existing scheduler dry-run report, including `due`, `date`, `window`, `wouldRun.argv`, and the dry-run day `plan`.
- `result.liveSmoke`: include `manifestPath`, `valid`, `validation.errors`, optional validation summary, and manifest evidence days.
- `result.offlineChecks`: deterministic checks such as `scheduler_due`, `live_smoke_manifest_valid`, and `manifest_starts_on_schedule_date`, each with `passed` or `blocked` plus detail when blocked.
- `result.requiredLiveProofs`: M2 gaps that remain `not_verified_offline`, including Multica self-host verification, pi-harness dependency cleanliness, two consecutive hands-free board days, failure blocker board comment, evening mastery delta matching the API, and daily cost visibility.

Non-completion wording: "This preflight is offline-only. It does not execute Multica, install a scheduler, prove live board posting, prove two hands-free days, or close M2."

Important boundary: Do not call this "M2 complete", "hands-free verified", "scheduler installed", "live smoke passed", or "board posting proven". A passing preflight means only that the repo's offline scheduler intent and live-smoke manifest contract are internally aligned and ready for a gated live smoke.

Changed paths: [src/cli/kl.ts, src/cli/kl.test.ts, docs/runbooks/m2-multica.md, .ai/checkpoints/part-m2-agent-preflight-report/step-1.md]
Test status: passing - npm run test:unit -- src/cli/kl.test.ts; npm run test:unit -- src/cli/kl.test.ts src/agents/schedule.test.ts src/agents/live-smoke-manifest.test.ts; npm run kl -- agent-preflight --dry-run --now 2026-06-14T07:30:00+08:00 --timezone Asia/Shanghai --daily-at 07:30 --manifest config/multica/live-smoke.example.json --config config/agents.example.json; npm run check; npm audit --audit-level=moderate; git diff --check
Review status: split reviewers checked CLI contract/security and M2 wording. No P0-P3 findings.
Next step: Commit and push this M2 slice, then continue to the next M2 task.
