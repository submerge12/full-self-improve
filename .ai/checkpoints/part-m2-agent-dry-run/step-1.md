# Part M2 Agent Dry-Run Step 1

What I did: added the first repo-local M2 orchestration slice: Librarian, Scholar, and Nutritionist dry-run profiles that print intended Multica actions without posting.

Files modified:

- `src/agents/dry-run.ts`
- `src/agents/dry-run.test.ts`
- `src/cli/kl.ts`
- `src/cli/kl.test.ts`

Scope:

- `librarian` supports `nightly-ingest`.
- `scholar` supports `morning-plan` and `evening-mastery`.
- `nutritionist` supports `daily-meals`.
- `kl agent --dry-run ...` returns JSON in the existing CLI shape: `{ command, mode, result }`.
- Dry-run output has `externalReads`, `externalWrites: []`, `intendedActions`, and `llmCost.estimatedUsd = 0`.
- The slice does not call Multica, knowledge-loop API, compass-health, pi-harness, or any network client. It only plans the actions.

Stable contracts used:

- Librarian points at `POST /api/ingest/run?adapter=...` and plans an ingest report based on summary counts.
- Scholar morning points at `GET /api/plan/today` and plans a study checklist.
- Scholar evening points at `GET /api/mastery/summary` and plans a mastery/weak-spots comment.
- Nutritionist points at the existing compass-health meal endpoint as a read-only source for a later live integration.

Verification:

```powershell
npm run test:unit -- src/agents/dry-run.test.ts src/cli/kl.test.ts
npm run typecheck
npm run lint
npm run check
npm run kl -- agent --dry-run --role librarian --date 2026-06-13 --knowledge-loop-url http://127.0.0.1:3124 --adapter holly-vault --board "Holly Daily"
npm audit --audit-level=moderate
```

Results:

- `src/agents/dry-run.test.ts` + `src/cli/kl.test.ts`: 2 files / 58 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run check`: passed outside the sandbox after sandboxed full Vitest hit `spawn EPERM`; 24 files / 280 tests passed.
- CLI smoke passed outside the sandbox after sandboxed `tsx` hit `spawn EPERM`; output had `command: "agent"`, `mode: "dry-run"`, one `POST /api/ingest/run?adapter=holly-vault` planned read, and `externalWrites: []`.
- `npm audit --audit-level=moderate`: passed; found 0 vulnerabilities.

Team-mode note:

- Worker slices completed read-only:
  - API/contract worker identified stable ingest, plan, and mastery fields.
  - test-shape worker identified CLI JSON and no-key/no-network dry-run proof requirements.
- Reviewer slices were attempted but did not run because the environment reported a usage-limit error. This checkpoint is therefore self-reviewed plus locally verified, not reviewer-approved.

Next step: add live posting adapters and scheduler wiring in later M2 slices, with separate review when reviewer capacity is available.
