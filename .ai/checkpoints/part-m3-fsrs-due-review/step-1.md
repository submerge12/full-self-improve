# Step 1 - RED tests

Task: `part-m3-fsrs-due-review`

Scope understood:
- Engine-only FSRS due review queue.
- No CLI/API, no migration changes, no external FSRS package, no new dependencies.
- Review state is opaque JSON but must be a JSON object.
- Planner should prepend due review activities, renumber the full queue, and preserve stored-plan reuse unless forced.

Files changed in RED step:
- `src/engine/persistent-review.test.ts`
- `src/engine/persistent-plan.test.ts`

RED command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts src/engine/persistent-plan.test.ts
```

RED result:
- Exit code: 1
- Test files: 2 failed
- Tests: no tests executed
- Expected failure: both suites import `./persistent-review.js`, which does not exist yet.

Key failure:

```text
Error: Cannot find module './persistent-review.js' imported from G:/knowledge-loop/src/engine/persistent-review.test.ts
Error: Cannot find module './persistent-review.js' imported from G:/knowledge-loop/src/engine/persistent-plan.test.ts
```

## GREEN implementation

Files changed in implementation:
- `src/engine/persistent-review.ts`
- `src/engine/mock-commands.ts`
- `src/engine/persistent-plan.ts`

Tactical decisions:
- Review schedules use `conceptId` as the upsert key because the database schema enforces `reviews.concept_id` uniqueness.
- `fsrsState` is stored as an opaque JSON string, but both input and stored values are required to parse to a JSON object.
- `YYYY-MM-DD` planner targets use a UTC next-day cutoff, so due reviews before `2026-06-15T00:00:00.000Z` are included for `2026-06-14`.
- Due review activities are prepended to the generated queue and then the full queue is renumbered.

GREEN command:

```powershell
npm run test:unit -- src/engine/persistent-review.test.ts src/engine/persistent-plan.test.ts
```

GREEN result:
- Exit code: 0
- Test files: 2 passed
- Tests: 20 passed

Final verification:

```powershell
npm run typecheck
npm run lint
git diff --check
```

Final verification result:
- `npm run typecheck`: exit code 0
- `npm run lint`: exit code 0
- `git diff --check`: exit code 0
