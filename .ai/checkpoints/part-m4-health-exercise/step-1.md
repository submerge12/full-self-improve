## Step 1

What I did: Added the M4 health exercise template, weekly plan, session completion, completion summary, API, route wrappers, and CLI slice. Templates now use typed default day objects, plans generate planned sessions from template days, completions support `sessionId`, `planId + templateSessionKey`, and ad hoc sessions, and completion summaries return planned/completed/missed/rate while keeping ad hoc sessions outside the planned denominator.

Files modified:
- `src/health-extensions/exercise.ts`
- `src/health-extensions/exercise.test.ts`
- `src/health-extensions/schema.ts`
- `src/health-extensions/store.ts`
- `src/health-extensions/store.test.ts`
- `src/api/contracts.ts`
- `src/api/contracts.test.ts`
- `src/api/handlers.ts`
- `src/api/handlers.test.ts`
- `src/app/api/health/exercise/templates/route.ts`
- `src/app/api/health/exercise/plans/route.ts`
- `src/app/api/health/exercise/sessions/complete/route.ts`
- `src/app/api/health/exercise/completion/route.ts`
- `src/app/api/_shared/route-adapter.test.ts`
- `src/cli/kl.ts`
- `src/cli/kl.test.ts`

Review status: Task 3A domain/store, Task 3B API/routes, and Task 3C CLI passed separate spec and quality reviews. Review fixes included rejecting planned completion before `scheduledFor`, preserving planned-session metadata when optional completion fields are omitted, validating stored exercise template days on write and read, supporting `planId + templateSessionKey` completion targets, and adding route-level malformed input coverage.

Test status: passing for focused Task 3 verification.
- `npm run test:unit -- src/health-extensions/exercise.test.ts src/health-extensions/store.test.ts`: 2 files passed, 27 tests passed.
- `npm run test:unit -- src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts`: 3 files passed, 107 tests passed.
- `npm run test:unit -- src/cli/kl.test.ts`: 1 file passed, 122 tests passed.
- `npm run test:unit -- src/health-extensions/exercise.test.ts src/api/handlers.test.ts src/cli/kl.test.ts`: 3 files passed, 206 tests passed.
- `npm run typecheck`: passed.
- `npm run check`: passed after sandbox escalation, 42 files passed, 593 tests passed.

Completion-rate proof: `queryExerciseCompletion` and `kl health-exercise completion` return `planned`, `completed`, `missed`, and `rate` with `rate = planned === 0 ? 0 : completed / planned`; ad hoc sessions are returned separately and do not inflate the planned denominator.

Next step: Commit and push this Task 3 slice, then continue to Task 4 sedentary span ingestion, streaks, and reminder engine.
