## Step 2

What I did: Added CLI-level `--difficulty` validation for `kl application` create mode so invalid values are rejected as `UsageError` before opening or migrating the database.
Files modified: [`src/cli/kl.ts`, `src/cli/kl.test.ts`, `.ai/checkpoints/part-m3-application-cli/step-2.md`]
Test status: passing (`npm run test:unit -- src/cli/kl.test.ts`; `npm run test:unit -- src/cli/kl.test.ts src/engine/persistent-application.test.ts src/engine/persistent-plan.test.ts`; `npm run typecheck`; `npm run lint`)
Next step: Report completion to Planner.
