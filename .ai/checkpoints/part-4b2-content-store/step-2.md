# Part 4B2 Content Store - Step 2

## Scope

Implemented the narrow better-sqlite3 content/mastery store API for page citation integrity and mastery updates.

## Implementation Notes

- Added `createSourceWithChunk`, `createPage`, `listPublicPages`, and `recordMasteryUpdate`.
- Used static parameterized SQL against the Part 4A tables.
- Validated public pages before insert so zero-citation public pages cannot be created through the store API.
- Validated every page citation against `chunks.id` before insert.
- Added runtime validation for malformed `citationIds` containers before reading `.length` or iterating.
- Added read-time validation for stored page citation arrays so schema-valid malformed arrays do not return as `number[]`.
- Kept public page listing constrained to `visibility = 'public'`.
- Upserted `mastery` by `concept_id`, making `recordMasteryUpdate` the current store-level writer.
- Recorded `page-gen` trace events for accepted/rejected page writes and `grade` trace events for accepted/rejected mastery writes when both `traceRecorder` and `runId` are provided.

## Verification

Targeted test:

```powershell
npm run test:unit -- src/db/content-store.test.ts
```

Result:

- Passed: 1 test file, 30 tests.

Full check:

```powershell
npm run check
```

Result:

- First sandboxed run passed typecheck and lint, then Vitest failed with Windows `spawn EPERM`.
- Escalated rerun passed typecheck, lint, and all unit tests.
- Final result: 9 test files passed, 67 tests passed.

## Files Touched

- `src/db/content-store.ts`
- `src/db/content-store.test.ts`
- `.ai/checkpoints/part-4b2-content-store/step-1.md`
- `.ai/checkpoints/part-4b2-content-store/step-2.md`
