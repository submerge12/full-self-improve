## Step 1

What I did: Added M2 agent profile source-of-truth in this repo plus Multica/pi-harness boundary config examples and a self-host runbook. The profiles stay dry-run first, deny write/destructive defaults, and do not run pi-harness scaffolding.
Files modified: [src/agents/profiles.ts, src/agents/profiles.test.ts, config/agents.example.json, config/multica/board-publish.example.json, config/multica/selfhost.env.example, docs/runbooks/m2-multica.md]
Test status: passing - npm run test:unit -- src/agents/profiles.test.ts src/agents/dry-run.test.ts src/agents/http-clients.test.ts src/cli/kl.test.ts; npm run typecheck; npm run lint
Next step: Run split reviewer checks, then full verification before commit and push.
