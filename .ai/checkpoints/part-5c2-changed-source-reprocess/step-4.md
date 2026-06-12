## Step 4

What I did: Fixed reviewer finding C1 for metadata-owned prerequisite edges on preserved same-slug concepts. Preserved prerequisite rebuild now includes both prerequisite hints parsed from live citation chunk text and `prerequisite` / `prerequisites` metadata from skipped unchanged raw documents.

Files modified: [G:\knowledge-loop\src\engine\persistent-ingest.ts, G:\knowledge-loop\src\engine\persistent-ingest.test.ts, G:\knowledge-loop\.ai\checkpoints\part-5c2-changed-source-reprocess\step-4.md]

Test status: passing

Reviewer-fix coverage:
- Added `preserves metadata prerequisite edges owned by an unchanged same-slug contribution`.
- This covers the repro where `changed-shared.md` moves to `# Other` while `unchanged-shared.md` still contributes `# Shared` with `metadata: { prerequisites: ["Base"] }`.

Verification:
- `npm run test:unit -- src/engine/persistent-ingest.test.ts`: 19 passed.
- `npm run check`: typecheck, lint, and 90 unit tests passed outside the sandbox.

Next step: Reviewer re-review and push if approved.
