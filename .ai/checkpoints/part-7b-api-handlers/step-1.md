# Step 1 - Red

## Change

- Added `src/api/handlers.test.ts` with integration-style coverage for the pure TypeScript API handler surface.

## Evidence

Command:

```powershell
npm run test:unit -- src/api/handlers.test.ts
```

Result:

- Exit code: 1
- Expected red failure: `Cannot find module './handlers.js'`
- No handler implementation exists yet, so Vitest collected no runnable tests.
