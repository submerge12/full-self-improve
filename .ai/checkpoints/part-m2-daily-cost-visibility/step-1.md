## Step 1

What I did: Added daily LLM cost visibility to the M2 day runner report. Live `agent-day` output now distinguishes actual injected `pi-harness-live` cost snapshots from the default `not_configured` state, while dry-run reports continue to show `dry-run-no-llm`. If a configured cost snapshot client fails, the report remains available with redacted `cost_unavailable` entries instead of rejecting the day run.
Files modified: [`src/agents/day-runner.ts`, `src/agents/day-runner.test.ts`, `src/cli/kl.test.ts`, `docs/runbooks/m2-multica.md`, `.ai/checkpoints/part-m2-daily-cost-visibility/step-1.md`]
Boundary: This adds the report contract and injection point only. It does not install or import pi-harness, does not read or write the pi-harness checkout, does not prove live cost tracking, and does not close M2. The live proof still requires a real pi-harness-backed run with captured cost data.
Test status: passing - `npm run test:unit -- src/agents/day-runner.test.ts src/cli/kl.test.ts` passed with 2 files and 90 tests.
Next step: split reviewer pass, then final verification, commit, push, and continue the next M2 item.
