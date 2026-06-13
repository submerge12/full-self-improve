# Step 1 - RED

Added failing tests for persistent ingest source failure isolation.

Command:

`npm run test:unit -- src/engine/persistent-ingest.test.ts`

Observed result:

- 19 passed, 4 failed.
- Processing read failures still abort through `PreflightSourceAdapter.readDocument`.
- Fingerprint failures still abort in `preflightSources`.
- Skipped unchanged read failure is counted as skipped instead of failed.
