# Step 2 - Config implementation

Implemented `src/adapters/config.ts` as the runtime env-to-adapter registry boundary and updated the route adapter to use it.

Verification:
- `npm run test:unit -- src/adapters/config.test.ts src/app/api/_shared/route-adapter.test.ts`
- Result: passed, 17 tests.
