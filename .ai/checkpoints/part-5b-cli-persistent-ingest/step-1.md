## Step 1

What I did: Added CLI handler tests for opt-in `kl ingest --vault <dir> --db <path>` persistence and duplicate `--db` validation.
Files modified: [`src/cli/kl.test.ts`, `.ai/checkpoints/part-5b-cli-persistent-ingest/step-1.md`]
Test status: 2 failing, 4 passing in the initial `npm run test:unit -- src/cli/kl.test.ts` RED run.
RED evidence:
- `ingest with a db persists sources and becomes a no-op on the second run` failed with `Unknown option for ingest: --db`.
- `ingest requires exactly one db path when db is provided` failed because the parser still rejected `--db` before arity validation.
Next step: Implement the persistent SQLite-backed CLI ingest path while preserving the existing pure mock ingest behavior without `--db`.
