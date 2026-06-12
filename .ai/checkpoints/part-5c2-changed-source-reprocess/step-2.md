## Step 2

What I did: Implemented changed-source reprocessing inside the existing persistence transaction, then fixed reviewer REQUEST_CHANGES for stale renamed/removed headings and edge ownership. Changed existing sources now update their `sources` row, capture old affected concepts/pages before deleting old chunks, preserve valid unchanged same-slug citations, delete stale disappeared concepts through SQLite FKs, narrow edge deletion to edges owned by affected concepts, rebuild current mock edges, rebuild related edges from processed documents to existing skipped concepts, rebuild prerequisite edges to existing concepts, and insert replacement pages with current citations.

Files modified: [G:\knowledge-loop\src\engine\persistent-ingest.ts, G:\knowledge-loop\src\engine\persistent-ingest.test.ts, G:\knowledge-loop\.ai\checkpoints\part-5c2-changed-source-reprocess\step-2.md]

Test status: passing

Reviewer-fix RED evidence:
- `npm run test:unit -- src/engine/persistent-ingest.test.ts` failed with 5 expected failures and 10 passing tests after adding reviewer regression coverage.
- Failing cases covered stale concepts/edges after heading rename, stale concepts/edges after multi-heading removal, over-deleted related edges from unchanged sources, missing changed-source related edges to skipped existing concepts, dropped unchanged same-slug page citations, and stale owned prerequisite edges on preserved same-slug concepts.

Verification:
- `npm run test:unit -- src/engine/persistent-ingest.test.ts`: 16 passed.
- `npm run check`: first rerun caught a real lint issue (`PageRow` unused), then sandboxed runs passed typecheck/lint and failed with `spawn EPERM` while loading `vitest.config.ts`; unsandboxed rerun passed typecheck, lint, and 87 unit tests.
- `git diff --check`: no whitespace errors; only CRLF conversion warnings for the touched TypeScript files.

Next step: Return completion report.
