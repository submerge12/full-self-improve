# Step 2 - Green implementation

Command:

```powershell
npm run test:unit -- src/engine/persistent-plan.test.ts src/api/handlers.test.ts
```

Result: passed.

Evidence:

- Test files: 2 passed.
- Tests: 24 passed.
- `createPersistentDailyPlan` now accepts `force: true`.
- `force: true` creates a plan when absent, or replaces the existing date row queue/rationale and resets status to `planned`.
- Plan trace outcomes now include `created`, `reused`, and `regenerated`.
- `POST /api/plan/generate` now calls the persistent planner with `force: true` and persists trace events through the existing mutation trace flow.
