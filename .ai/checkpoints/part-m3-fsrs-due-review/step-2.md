# Step 2 - Quality Reviewer P1

Task: `part-m3-fsrs-due-review`

Scope:
- Fix only the Quality Reviewer P1 for lossy `fsrsState` validation.
- No CLI/API changes.
- No deduplication policy changes.
- Did not modify `docs/AUDIT-MANUAL.md`.
- Did not delete files.

## RED

Added failing coverage in `src/engine/persistent-review.test.ts`:
- Valid nested JSON object state is preserved.
- `upsertPersistentReviewSchedule` rejects lossy/non-JSON FSRS members before serialization:
  - top-level `undefined`
  - top-level function
  - top-level symbol
  - nested object `undefined` / function / symbol
  - nested array `undefined` / function / symbol
  - `NaN`
  - `Infinity`
  - nested non-finite number
  - `bigint`
  - circular structure

RED command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts
```

RED result:
- Exit code: 1
- Expected failure: `top-level undefined property` did not throw, proving the old stringify path silently dropped data.

Key failure:

```text
AssertionError: top-level undefined property: expected [Function] to throw an error
```

## GREEN

Implemented recursive JSON validation in `src/engine/persistent-review.ts` before calling `JSON.stringify`.

Validation behavior:
- Root must be a non-null object and not an array.
- Nested values may be strings, finite numbers, booleans, null, arrays, or objects.
- Rejects `undefined`, functions, symbols, bigint, non-finite numbers, array holes, symbol keys, non-JSON array properties, accessors, non-enumerable object properties, custom JSON serialization, and circular structures.
- Error messages include `fsrsState`.
- Existing valid nested JSON object behavior remains supported.

GREEN command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts
```

GREEN result:
- Exit code: 0
- Test files: 1 passed
- Tests: 8 passed

## Final verification

Targeted command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts src/engine/persistent-plan.test.ts
```

Targeted result:
- Exit code: 0
- Test files: 2 passed
- Tests: 22 passed

Other verification:

```powershell
npm run typecheck
npm run lint
git diff --check
```

Results:
- `npm run typecheck`: exit code 0
- `npm run lint`: exit code 0
- `git diff --check`: exit code 0
- `git diff --check` printed line-ending warnings for pre-existing modified files `src/engine/mock-commands.ts`, `src/engine/persistent-plan.test.ts`, and `src/engine/persistent-plan.ts`.
