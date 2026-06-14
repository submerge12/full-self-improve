# Step 3 - Quality Re-Reviewer P1

Task: `part-m3-fsrs-due-review`

Finding: `P1-FSRS-LOSSY-NONPLAIN`

Scope:
- Fixed only silent lossy acceptance of non-plain `fsrsState` objects.
- Did not modify planner, CLI, API, or M2 orchestration.
- Did not modify `docs/AUDIT-MANUAL.md`.
- Did not delete files.

## RED

Added failing coverage in `src/engine/persistent-review.test.ts`:
- Reject root `Map`, `Set`, `Date`, `RegExp`, and custom class instances.
- Reject nested `Map`, `Set`, and custom class instances inside a plain object.
- Reject nested `Map`, `Set`, and custom class instances inside an array.
- Accept null-prototype plain records at root and nested positions.

RED command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts
```

RED result:
- Exit code: 1
- Test files: 1 failed
- Tests: 1 failed, 9 passed, 10 total
- Expected failure: `root Map` did not throw, proving non-plain objects could still be serialized lossily.

Key failure:

```text
AssertionError: root Map: expected [Function] to throw an error
```

## GREEN

Implemented a plain JSON object policy in `src/engine/persistent-review.ts`:
- Root `fsrsState` must be a plain record with prototype `Object.prototype` or `null`; arrays remain rejected at root.
- Nested containers may be arrays or plain records with prototype `Object.prototype` or `null`.
- Non-plain objects are rejected before `JSON.stringify`, covering `Map`, `Set`, `RegExp`, class instances, typed arrays, `Promise`, and similar prototype-backed objects.
- Existing rejection remains for `undefined`, functions, symbols, bigint, non-finite numbers, circular references, array holes, symbol keys, non-enumerable properties, accessors, and custom `toJSON`.

GREEN command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts
```

GREEN result:
- Exit code: 0
- Test files: 1 passed
- Tests: 10 passed

## Final verification

Targeted command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts src/engine/persistent-plan.test.ts
```

Targeted result:
- Exit code: 0
- Test files: 2 passed
- Tests: 24 passed

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
