## Step 1

What I did: Added the M4 health metrics domain, API, Next route wrappers, and CLI slice. Metric create/list/update/import now works through the shared health store, API handlers, and `kl health-metric` commands. Metric updates record previous/next audit payloads and health trace events in the same transaction. CSV import records import reservations before observations, reports row-level accept/reject status, rejects manual/mock source spoofing, and keeps accepted imported rows as `source: "csv"`.

Files modified:
- `src/health-extensions/metrics.ts`
- `src/health-extensions/metrics.test.ts`
- `src/health-extensions/store.ts`
- `src/api/contracts.ts`
- `src/api/contracts.test.ts`
- `src/api/handlers.ts`
- `src/api/handlers.test.ts`
- `src/app/api/health/metrics/route.ts`
- `src/app/api/health/metrics/import/route.ts`
- `src/app/api/_shared/route-adapter.test.ts`
- `src/cli/kl.ts`
- `src/cli/kl.test.ts`

Review status: Task 2A domain/store, Task 2B API/routes, and Task 2C CLI each passed separate spec and quality review. Review fixes included pre-DB CLI validation for `health-metric add`, transaction-bound metric update audit reads, CSV source spoofing rejection, and `compass-health` filesystem path rejection for CLI CSV imports.

Test status: passing for focused Task 2 verification.
- `npm run test:unit -- src/cli/kl.test.ts src/health-extensions/metrics.test.ts src/health-extensions/store.test.ts`: 3 files passed, 143 tests passed.
- `npm run test:unit -- src/health-extensions/metrics.test.ts src/api/contracts.test.ts src/api/handlers.test.ts src/app/api/_shared/route-adapter.test.ts src/cli/kl.test.ts`: 5 files passed, 219 tests passed.
- `npm run check`: typecheck and lint passed in the sandbox, then Vitest config loading hit the known Windows sandbox `spawn EPERM` blocker before tests ran. The escalated rerun request failed at the approval channel, so no fresh full `npm run check` result was recorded after the final CLI path-guard fix.

Metric update audit and health trace proof are implemented in this slice.

Next step: Commit and push this Task 2 slice, then continue to Task 3 exercise template/plan/session completion.
