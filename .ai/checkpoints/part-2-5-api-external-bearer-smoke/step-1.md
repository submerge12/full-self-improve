# Part 2.5 API External Bearer Smoke Step 1 - Coverage Proof

- Scope checked against PLAN 2.5:
  - endpoints must be callable by an external process with a bearer token;
  - unauthenticated mutation requests must be rejected.
- Added route-adapter acceptance coverage using the actual App Router route exports and Web `Request` objects.
- Covered a bearer-authenticated protected GET through `GET /api/mastery/summary`.
- Covered a bearer-authenticated protected POST through `POST /api/plan/generate`.
- Covered unauthenticated mutation rejection for:
  - `POST /api/ingest/run?adapter=fixture`;
  - `POST /api/plan/generate`;
  - `POST /api/quiz/grade`;
  - `POST /api/teachback`.
- The new tests passed immediately. This is a proof/coverage slice rather than a production-code fix: the bearer behavior already existed, but §2.5 lacked direct external-style App Route evidence.
- Reviewer follow-up found the first mutation rejection test only used empty bodies, while the Web adapter parsed request bodies before handler auth.
- Added a regression test for unauthenticated malformed JSON on `POST /api/quiz/grade`.
- RED evidence: `npm run test:unit -- src/app/api/_shared/route-adapter.test.ts` failed with expected `401` but received `400`, proving body parsing happened before bearer auth.
