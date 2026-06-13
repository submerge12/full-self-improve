# PLAN 2.1 engine dependency boundary - step 1

- Read `PLAN.md`, `package.json`, `vitest.config.ts`, `tsconfig.json`, and the existing `src/engine/*.ts` / `src/engine/*.test.ts` files.
- Confirmed PLAN 2.1 requires `src/engine/` to have zero imports from `next` or `src/app`, enforced by a rule or test.
- Existing production engine files do not show a `next` or `src/app` import during inspection; some engine files legitimately import `../db/*`, which is outside this slice's forbidden boundary.
- Added `src/engine/dependency-boundary.test.ts` with a TypeScript-AST-based import-specifier scan so ordinary identifiers such as `nextScore` are not treated as dependency violations.
