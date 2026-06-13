# Part 2.5 API External Bearer Smoke Step 2 - Verification

- Focused command:
  - `npm run test:unit -- src/app/api/_shared/route-adapter.test.ts`
  - Current result after reviewer follow-up: 1 file passed, 17 tests passed.
- Broader verification:
  - `npm run typecheck` passed.
  - `npm run lint` passed.
  - `npm run check` passed outside the Windows sandbox: 23 files, 272 tests.
  - `npm audit --audit-level=moderate` reported 0 vulnerabilities.
  - `git diff --check` exited 0 with only CRLF normalization warnings.
- The focused test uses real route exports, runtime DB/env setup, and Web `Request` inputs. It does not call the pure handler directly for the new acceptance cases.
- Initial proof had no production changes. Reviewer follow-up moved Web adapter bearer preflight before body parsing in `src/app/api/_shared/route-adapter.ts`.
- No bulk-delete commands were used.
