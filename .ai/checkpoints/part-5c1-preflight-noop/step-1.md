## Step 1

What I did: Added RED regression tests proving unchanged sources still reach the mock pipeline on all-unchanged and mixed unchanged/new reruns.
Files modified: ["src/engine/persistent-ingest.test.ts"]
Test status: 2 failing. `npm run test:unit -- src/engine/persistent-ingest.test.ts` failed because `preflights unchanged sources before the mock pipeline on a second run` saw `extract` events for existing docs, and `preflights unchanged sources while processing a newly added source` saw `extract` events for existing docs plus `fresh.md`.
Next step: Add persistent ingest preflight so unchanged sources are skipped before `runMockIngest`.
