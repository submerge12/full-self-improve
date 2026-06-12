## Step 1

What I did: Added RED tests for changed-source persistent mock ingest reprocessing. The tests now require an edited source to be processed while unchanged sources are preflight-skipped, changed chunks/pages/fingerprints to be replaced, prerequisite edges to be added and removed on reprocess, and a third identical run after reprocess to be a no-op.

Files modified: [G:\knowledge-loop\src\engine\persistent-ingest.test.ts]

Test status: 3 failing

RED evidence:
`npm run test:unit -- src/engine/persistent-ingest.test.ts` failed with 3 expected failures:
- `reprocesses only the edited source while preflight-skipping unchanged sources`: expected `sourcesProcessed: 1`, `sourcesSkipped: 1`, `chunksCreated: 1`, `pagesCreated: 1`; actual still skipped the changed source with zero chunk/page writes.
- `rewrites prerequisite edges for a changed source`: expected one changed source to process and create replacement chunk/page rows; actual still skipped it.
- `skips an identical third run after a changed-source reprocess`: expected no mock pipeline events after reprocess; actual still emitted extract/page events because the changed fingerprint had not been persisted.

Next step: Implement changed-source reprocessing inside the existing persistence transaction.
