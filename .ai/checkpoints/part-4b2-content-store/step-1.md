# Part 4B2 Content Store - Step 1

## Scope

Implemented tests first for the Part 4B2 content/mastery store API and the reviewer-requested integrity boundary cases.

## TDD RED Evidence

Initial module RED command:

```powershell
npm run test:unit -- src/db/content-store.test.ts
```

Result:

- Failed before the store module existed.
- Expected failure: `Cannot find module './content-store.js'`.

Reviewer-fix RED command:

```powershell
npm run test:unit -- src/db/content-store.test.ts
```

Result:

- Failed: 6 failed, 24 passed.
- Expected failures:
  - Malformed `citationIds` containers produced raw `TypeError`.
  - Schema-valid malformed stored citation arrays were returned instead of rejected.

## Tests Added

- Public page creation succeeds only when every citation resolves to a chunk.
- Public page creation with zero citations is rejected before insert and logged.
- Missing and invalid citations are rejected before insert.
- Malformed `citationIds` containers are rejected with a domain error and `page-gen` trace.
- Missing concepts are rejected for page creation and mastery updates.
- Public page listing excludes private pages.
- Public page listing rejects malformed stored citation arrays.
- Mastery update inserts once, updates by concept, increments by default, and can set attempts explicitly.
- Mastery score/confidence boundaries `0` and `1` are accepted; out-of-range values are rejected.
- Invalid `attemptsN` values are rejected.
- Source/chunk helper rolls back source insert when chunk insert fails.

## Files Touched

- `src/db/content-store.test.ts`
