# Step 2

## What I did

- Made `RecordPersistentReviewAttemptInput.reviewedAt` required in `src/engine/persistent-review.ts`.
- Kept the runtime missing-`reviewedAt` guard in place for JavaScript callers and unsafe casts.
- Updated the runtime invalid-input test to use `as unknown as RecordPersistentReviewAttemptInput`.
- Added a type-level test assertion that `reviewedAt` is `string | Date`, not `string | Date | undefined`.

## Files modified

- `src/engine/persistent-review.ts`
- `src/engine/persistent-review.test.ts`
- `.ai/checkpoints/part-m3-review-attempt-update/step-2.md`

## Commands and results

### RED

Command:

```powershell
npm run typecheck
```

Result:

- Exit code: 1
- Expected failure: `RecordPersistentReviewAttemptInput["reviewedAt"]` still included `undefined`.
- Error location: `src/engine/persistent-review.test.ts(360,84)`.

### GREEN

Commands:

```powershell
npm run typecheck
npm run test:unit -- src\engine\persistent-review.test.ts
```

Results:

- `npm run typecheck`: exit code 0.
- `npm run test:unit -- src\engine\persistent-review.test.ts`: exit code 0, 1 test file passed, 16 tests passed.

### Final verification

Commands:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts src/engine/persistent-plan.test.ts
npm run typecheck
npm run lint
git diff --check
```

Results:

- `npm run test:unit -- src/engine/persistent-review.test.ts src/engine/persistent-plan.test.ts`: exit code 0, 2 test files passed, 30 tests passed.
- `npm run typecheck`: exit code 0.
- `npm run lint`: exit code 0.
- `git diff --check`: exit code 0. Git reported LF-to-CRLF working-copy warnings for the two touched TypeScript files, but no whitespace errors.

## Next step

Reviewer can re-check the P1 type contract slice.
