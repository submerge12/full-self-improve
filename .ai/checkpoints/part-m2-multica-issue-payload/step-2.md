# part-m2-multica-issue-payload step 2

## Reviewer Fix

- Fixed the Quality reviewer Important issue in `src/agents/board-publish-config.ts`.
- `actions.create_task.payload.priority` now rejects any present value that is not a string before checking the allowed Multica priority enum.
- Kept the existing priority validation message unchanged:
  - `board publish config actions.create_task.payload.priority must be one of none, low, medium, high, urgent when present.`
- Did not change the unrelated Minor http-clients exhaustiveness guard.

## Regression Coverage

- Added focused regression coverage in `src/agents/board-publish-config.test.ts` for non-string priority values:
  - `priority: ["medium"]` is rejected.
  - `priority: { value: "medium" }` is rejected.

## Test Status

RED:

```powershell
npm run test:unit -- src/agents/board-publish-config.test.ts
```

Result: failed as expected. 1 test failed, 5 tests passed. The failing case was `rejects non-string create_task payload priority: array priority`, proving the previous `String(priority)` coercion allowed `["medium"]`.

GREEN:

```powershell
npm run test:unit -- src/agents/board-publish-config.test.ts
```

Result: passed. 1 test file passed, 6 tests passed.

## Next Step

- Run the requested final focused verification:
  - `npm run test:unit -- src/agents/http-clients.test.ts src/agents/board-publish-config.test.ts src/cli/kl.test.ts`
- Hand off for review without staging, committing, or pushing.
