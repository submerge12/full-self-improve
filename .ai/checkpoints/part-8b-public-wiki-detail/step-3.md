# Part 8B Step 3 - Refactor and Verification

- Kept the public detail route server-only with no client JS.
- Used a plain anchor for listing links. The current Next canary package exposes `next/navigation.d.ts`, but this repo's `NodeNext` typecheck does not resolve the `next/navigation` subpath, so the detail route uses a local `throwNextNotFound()` helper that throws Next's documented 404 fallback digest shape for missing/private/invalid pages.
- Verification:
  - `npm run test:unit -- src/app/_shared/page-data.test.ts` passed: 1 file, 9 tests.
  - `npm run typecheck` passed with `tsc --noEmit`.
  - `npm run lint` passed with `eslint .`.
  - `npm run check` passed outside the Windows sandbox: 19 files, 232 tests.
- Follow-up: added explicit malformed stored citation id coverage after review.
