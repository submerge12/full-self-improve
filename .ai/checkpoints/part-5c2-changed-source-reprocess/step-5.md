## Step 5

What I did: Fixed reviewer finding C1 for stale concept summaries on preserved-only same-slug concepts. When a changed source moves away from a shared slug, the surviving concept row now updates its summary from remaining live citation chunks instead of keeping the old changed-source summary.

Files modified: [G:\knowledge-loop\src\engine\persistent-ingest.ts, G:\knowledge-loop\src\engine\persistent-ingest.test.ts, G:\knowledge-loop\.ai\checkpoints\part-5c2-changed-source-reprocess\step-5.md]

Test status: passing

Reviewer-fix coverage:
- Added `readConceptSummary` test assertions to prove preserved same-slug summaries no longer contain removed changed-source text.
- Verified both text-owned and metadata-owned prerequisite preservation still keep valid edges and page content.

Verification:
- `npm run test:unit -- src/engine/persistent-ingest.test.ts`: 19 passed.
- `npm run check`: typecheck, lint, and 90 unit tests passed outside the sandbox.

Next step: Final reviewer re-review and push if approved.
