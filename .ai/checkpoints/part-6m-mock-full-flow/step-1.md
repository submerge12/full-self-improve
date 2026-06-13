Step 1 - Test added and first verification

- Added a focused integration test in `src/cli/kl.test.ts` for the no-API-key CLI mock persistent full flow.
- The test deletes `DEEPSEEK_API_KEY`, `QWEN_API_KEY`, `OPENAI_API_KEY`, and `LLM_PROVIDER` during the flow and restores them in `finally`.
- First verification command: `npm run test:unit -- src/cli/kl.test.ts`.
- Result: unexpected green, `1 passed`, `50 passed`. Existing production code already supports this slice, so no production-code fix was made.
