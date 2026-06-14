# part-m3-review-attempt-update checkpoint

## Scope

- Added engine-only `recordPersistentReviewAttempt` on top of the existing `reviews` table.
- Preserved `upsertPersistentReviewSchedule` and `listDuePersistentReviews` behavior.
- Did not modify frozen repos, schema, migrations, CLI/API, dependencies, application code, or `docs/AUDIT-MANUAL.md`.

## RED

Command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts
```

Result:

- Exit code: 1
- Expected failure: 5 new tests failed because `recordPersistentReviewAttempt` was not implemented/exported.
- Existing tests still passed: 10 passed.

## GREEN

Command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts
```

Result:

- Exit code: 0
- Test files: 1 passed
- Tests: 15 passed

## Final Verification

Commands:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts src/engine/persistent-plan.test.ts
npm run typecheck
npm run lint
git diff --check
```

Results:

- `npm run test:unit -- src/engine/persistent-review.test.ts src/engine/persistent-plan.test.ts`: exit code 0, 2 files passed, 29 tests passed.
- `npm run typecheck`: exit code 0.
- `npm run lint`: exit code 0.
- `git diff --check`: exit code 0. Git reported LF-to-CRLF working-copy warnings for the two touched TypeScript files, but no whitespace errors.

## Decisions

- `reviewedAt` is required for deterministic review attempt semantics.
- Rating schedules are deterministic mock intervals: again +1 day, hard +2 days, good +4 days, easy +7 days.
- Rating mastery deltas are deterministic and clamped through the review attempt flow: again -0.08, hard -0.02, good +0.06, easy +0.1.
- Review update and mastery update run inside one transaction. Stored `fsrs_state` is parsed before mutation so corrupt state leaves review and mastery unchanged.
