## Step 1

What I did: Added a deterministic M2 scheduler dry-run layer. `agent-schedule --dry-run` validates `--now`, `--timezone`, and `--daily-at`, computes whether the daily `agent-day` run is due, prints the board-day window, emits the exact `agent-day --dry-run` argv, and embeds the dry-run day plan. It does not create a daemon, call fetch, call Multica, or accept live publish options. Updated the runbook with scheduler dry-run usage and non-completion wording.
Files modified: [src/agents/schedule.ts, src/agents/schedule.test.ts, src/cli/kl.ts, src/cli/kl.test.ts, docs/runbooks/m2-multica.md]
Test status: passing - npm run test:unit -- src/agents/schedule.test.ts src/cli/kl.test.ts
Next step: Run broader verification and split reviewer checks before commit and push.
