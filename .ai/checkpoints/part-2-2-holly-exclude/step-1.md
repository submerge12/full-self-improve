# Step 1

## What I did

- Tightened the default exclude test to require `90_待确认/**` in `DEFAULT_MARKDOWN_VAULT_EXCLUDE`.
- Re-ran the focused config unit test as the RED check.
- Verified with a UTF-8 Node read that `src/adapters/config.ts` already contains `90_待确认/**`; the earlier mojibake appearance is PowerShell display drift, not the file bytes.

## Files modified

- `src/adapters/config.test.ts`
- `.ai/checkpoints/part-2-2-holly-exclude/step-1.md`

## Test status

- `npm run test:unit -- src/adapters/config.test.ts` passed unexpectedly: 1 test file, 6 tests.
- Expected RED was not reproducible because production config already has the Unicode exclude.

## Next step

- Keep the test coverage and run the required green verification path without changing unrelated production code.
