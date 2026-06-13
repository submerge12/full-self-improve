## Step 1

What I did: Added an offline M2 live-smoke manifest and validator. The manifest defines the two consecutive board days and required evidence for Librarian ingest comments, Scholar morning tasks, Nutritionist meal tasks, and Scholar evening mastery comments. Validation checks the manifest stays `inferred_live_smoke_pending`, references the Multica publish config, matches the dry-run board-day plan, uses HTTP(S) source endpoints, and contains no secrets or frozen-repo filesystem paths. The runbook now documents the manifest as a pre-live contract, not M2 completion.
Files modified: [config/multica/live-smoke.example.json, src/agents/live-smoke-manifest.ts, src/agents/live-smoke-manifest.test.ts, src/agents/profiles.test.ts, docs/runbooks/m2-multica.md]
Test status: passing - npm run test:unit -- src/agents/live-smoke-manifest.test.ts src/agents/profiles.test.ts src/agents/dry-run.test.ts; npm run typecheck; npm run lint
Next step: Run split reviewer checks, then full verification before commit and push.
