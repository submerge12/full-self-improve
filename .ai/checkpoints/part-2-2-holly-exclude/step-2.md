# Step 2

## What I did

- Re-ran the focused config unit test after keeping the tightened Unicode exclude assertion.
- Confirmed the fixture vault excludes `90_待确认/hidden.md` from `listDocuments`.
- Confirmed no production edit was needed because `src/adapters/config.ts` already contains `90_待确认/**` in UTF-8.

## Files modified

- `.ai/checkpoints/part-2-2-holly-exclude/step-2.md`

## Test status

- `npm run test:unit -- src/adapters/config.test.ts` passed: 1 test file, 6 tests.

## Next step

- Run the required typecheck and record the result.
