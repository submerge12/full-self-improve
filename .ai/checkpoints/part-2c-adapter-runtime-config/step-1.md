# Step 1 - Red tests

Added adapter runtime config tests before implementation.

Verification:
- `npm run test:unit -- src/adapters/config.test.ts src/app/api/_shared/route-adapter.test.ts`
- Result: failed as expected because `src/adapters/config.ts` does not exist and the route adapter still registers the old default path.
