## Step 2

What I did: Implemented `runPersistentMockIngest` as a narrow SQLite-backed wrapper around `runMockIngest`.

Implementation notes:
- Calls `runMockIngest(adapter, options)` and persists only absent sources.
- Uses `(adapter_id, doc_ref)` to classify sources as new, unchanged, or changed-fingerprint.
- Inserts new sources, chunks, concepts, concept edges, and private pages with numeric chunk citation IDs.
- Maps unchanged source chunks by existing `source_id` and `seq` so second runs can prove no-op behavior without writes.
- Skips changed fingerprints without overwriting rows and emits a `merge` warning trace.
- Prevents skipped changed fingerprints from contributing downstream concept, edge, or page writes; a changed source that introduces a new edge now leaves `concept_edges` unchanged when no sources were processed.
- Marks merged concepts that include changed-skipped sources as changed-contributed, so changed content cannot add edges through a same-slug newly processed source.
- Prevents changed-source related edges from being inserted even when the related target is a newly processed concept in the same run.
- Uses deterministic fallback timestamps (`1970-01-01T00:00:00.000Z`) for persistent skip/warn traces when no trace recorder is supplied.
- Uses static parameterized SQL statements and wraps persistence writes in one `db.transaction`.

Files modified: [`src/engine/persistent-ingest.ts`, `.ai/checkpoints/part-5a-persistent-ingest/step-2.md`]

Test status: passing

Verification:
- RED reviewer regression evidence: `npm run test:unit -- src/engine/persistent-ingest.test.ts` failed before the fix with reviewer regression tests showing changed fingerprints inserted `concept_edges`, changed-source same-slug merged concepts could persist new prerequisite edges, changed-source related edges could be persisted through a new concept, and fallback persistent trace timestamps were nondeterministic.
- `npm run test:unit -- src/engine/persistent-ingest.test.ts`: 1 file passed, 7 tests passed.
- `npm run check`: first sandbox run reached typecheck and lint, then Vitest config load failed with `spawn EPERM`.
- Escalated `npm run check`: typecheck passed, lint passed, 10 test files passed, 74 tests passed.

Next step: Worker 5A slice is ready for review.
