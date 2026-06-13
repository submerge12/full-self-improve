## Step 1

What I did: Added the offline M2 failure blocker smoke module, dry-run CLI command, tests, and runbook guidance. The smoke run uses injected in-memory read and board clients, fails the selected source endpoint, verifies a blocker comment/action is published, confirms later independent agents continue, and keeps the report redaction-safe.
Files modified: [src/agents/failure-smoke.ts, src/agents/failure-smoke.test.ts, src/cli/kl.ts, src/cli/kl.test.ts, docs/runbooks/m2-multica.md, .ai/checkpoints/part-m2-failure-blocker-smoke/step-1.md]
Command:

```powershell
npm run kl -- agent-failure-smoke --dry-run --date 2026-06-14
```

Boundary: `agent-failure-smoke` is offline-only. It does not kill a real API service, call Multica, use bearer tokens, prove live blocker visibility, or close M2. The real M2 failure proof still requires a live kill-API drill and captured board blocker. Fake board publishes return offline ids only, not board URLs.
Test status: passing - `npm run test:unit -- src/agents/failure-smoke.test.ts src/cli/kl.test.ts` passed with 2 files and 86 tests; `npm run kl -- agent-failure-smoke --dry-run --date 2026-06-14` returned a blocked offline smoke report with `blockerPublished: true`, 3 reads, 4 published actions, 1 blocker, and the non-completion notice.
Next step: reviewer pass, then final verification, commit, and push this part.
