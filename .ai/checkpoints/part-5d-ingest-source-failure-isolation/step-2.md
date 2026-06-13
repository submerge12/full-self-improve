# Step 2 - GREEN

Implemented per-source adapter failure isolation in persistent ingest.

Key changes:

- Fingerprint and read failures are caught per source.
- Failed sources are upserted with `status = 'error'`.
- Successful pre-read documents are passed to `runMockIngest` through an in-memory preflight adapter.
- Error sources are not skipped on later equal-fingerprint runs.
- Existing chunks/pages are left intact when a later read fails.

Command:

`npm run test:unit -- src/engine/persistent-ingest.test.ts`

Observed result:

- 1 test file passed.
- 23 tests passed.
