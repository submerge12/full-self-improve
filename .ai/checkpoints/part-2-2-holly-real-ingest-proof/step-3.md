# Part 2.2 Holly Real Dataset Ingest Proof Step 3 - Team Review Prep

- Worker-Holly-Config concern:
  - a `listed=525 excludedCount=0` adapter probe alone is not enough;
  - reviewer should require proof that the real vault contains excluded candidates.
- Follow-up evidence added:
  - raw vault scan found 535 markdown files;
  - 10 markdown files matched default exclude rules;
  - runtime adapter listed 525 files;
  - scratch DB persisted 525 `holly-vault` sources and 0 excluded `doc_ref` rows.
- Worker-Holly-IngestTrace concern:
  - `sources` has `status='error'`, but no `error_reason` column;
  - failure reasons live in `trace_events.data.reason` on `chunk/error` events with `data.outcome='source_error'`.
- Current proof posture:
  - real Holly ingest is proven with no source failures;
  - failure-reason persistence is documented as an existing trace-events contract, not a new `sources` column;
  - if a stricter `sources.error_reason` requirement is desired later, that should be a separate schema change.

## Reviewer Checklist

- Confirm the proof uses runtime `holly-vault`, not CLI `cli-vault`.
- Confirm the scratch DB path is inside `G:\knowledge-loop\.ai\tmp`.
- Confirm `G:\dataset\Holly dataset` was only read.
- Confirm raw candidate count and adapter listed count reconcile: 535 total minus 10 excluded equals 525 listed.
- Confirm persisted `sources.adapter_id='holly-vault'` count equals 525.
- Confirm persisted excluded `doc_ref` count equals 0.
- Confirm no failed real source rows or source-error trace rows were present in this run.
- Confirm no bulk-delete commands were used.
