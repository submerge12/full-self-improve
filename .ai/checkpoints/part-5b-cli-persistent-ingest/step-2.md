## Step 2

What I did: Wired `kl ingest --vault <dir> --db <path>` to open SQLite with `better-sqlite3`, apply migrations, run `runPersistentMockIngest`, close the DB, and return `mode: "mock-persistent"` with the persistent summary. The existing `kl ingest --vault <dir>` path still returns pure mock JSON with `mode: "mock"`.
Files modified: [`src/cli/kl.ts`, `src/cli/kl.test.ts`, `.ai/checkpoints/part-5b-cli-persistent-ingest/step-2.md`]
Implementation notes:
- Added a persistent ingest result variant so CLI callers can distinguish pure mock ingest from persistent mock ingest.
- Added optional `--db` parsing that allows omission but requires exactly one value when present.
- Added parser coverage for missing `--db` values and unknown ingest options.
- Kept all database work inside the CLI branch and reused the existing migration and persistent ingest engine modules.
Verification:
- `npm run test:unit -- src/cli/kl.test.ts`: passing, 8 tests passed.
- `npm run check`: first sandboxed run typechecked and linted, then failed at Vitest startup with `spawn EPERM`; rerun with escalation passed typecheck, lint, and 78 unit tests.
Next step: Hand this slice to the reviewer for cross-slice review.
