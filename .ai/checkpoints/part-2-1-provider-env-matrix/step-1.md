# Step 1 - Read Existing Context

- Read `PLAN.md` section 2.1 provider requirement: switching `LLM_PROVIDER` between `deepseek`, `qwen`, and unset should require env-var changes only.
- Read `src/engine/health.ts`: provider selection already maps `deepseek` to `DEEPSEEK_API_KEY`, `qwen` to `QWEN_API_KEY`, and falls back to mock otherwise.
- Read `src/engine/health.test.ts`: existing coverage only included no-key mock and configured DeepSeek.
