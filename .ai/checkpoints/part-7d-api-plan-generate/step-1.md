# Step 1 - Red tests

Command:

```powershell
npm run test:unit -- src/engine/persistent-plan.test.ts src/api/handlers.test.ts
```

Result: failed as expected.

Evidence:

- `src/engine/persistent-plan.test.ts`: `force regenerates an existing plan and resets status to planned` failed because the existing implementation reused status `active` instead of resetting to `planned`.
- `src/api/handlers.test.ts`: both `POST /api/plan/generate` tests failed because the handler still returned HTTP `501` instead of creating/regenerating a plan.
- Summary: 2 failed test files, 3 failed tests, 21 passed tests.
