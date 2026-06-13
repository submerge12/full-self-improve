## Step 1

What I did: Added the offline `agent-live-smoke --dry-run` CLI entry for M2 live-smoke manifest validation. The command reads a manifest from inside the knowledge-loop checkout, builds the existing `agent-day` dry-run reference plan for the selected date, runs the manifest validator, and prints JSON with `valid`, validator errors/summary, the manifest non-completion notice, and the dry-run plan. The runbook now shows the command and states it must not fetch external services, use bearer tokens, touch Multica or pi-harness checkouts, accept `--live`, install a scheduler, prove live posting, prove two hands-free days, or close M2.
Files modified: [src/cli/kl.ts, src/cli/kl.test.ts, docs/runbooks/m2-multica.md, .ai/checkpoints/part-m2-agent-live-smoke-cli/step-1.md]
Test status: passing - npm run test:unit -- src/cli/kl.test.ts; npm run test:unit -- src/cli/kl.test.ts src/agents/live-smoke-manifest.test.ts; npm run kl -- agent-live-smoke --dry-run --manifest config/multica/live-smoke.example.json --date 2026-06-14 --board daily-plan; npm run check; npm audit --audit-level=moderate; git diff --check
Review status: split reviewers checked CLI contract/security and M2 wording. One P2 unsafe invalid-manifest notice echo was fixed by falling back to a constant notice whenever validation fails.
Next step: Commit and push this M2 slice, then continue to the next M2 task.
