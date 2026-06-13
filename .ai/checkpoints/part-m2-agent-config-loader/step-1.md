## Step 1

What I did: Added a dry-run-only agent runtime config loader and wired `kl agent` / `kl agent-day` to accept `--config`. Config values provide shared defaults while CLI flags still override them. The loader rejects secret-like keys and values, live-write switches, filesystem-shaped integration values, unknown fields, and config paths outside the project checkout.
Files modified: [src/agents/config.ts, src/agents/config.test.ts, src/cli/kl.ts, src/cli/agent-config.test.ts]
Test status: passing - npm run test:unit -- src/agents/config.test.ts src/cli/agent-config.test.ts; npm run typecheck
Next step: Run split reviewer checks, then full verification before commit and push.
