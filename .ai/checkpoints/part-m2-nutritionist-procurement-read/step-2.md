## Step 2

What I did: Updated the checked-in live-smoke and board-day evidence examples so both Nutritionist board-day items reference the meal-plan GET endpoint and the procurement POST endpoint, without adding request bodies or changing pending/non-completion status text.
Files modified: [
  "config/multica/live-smoke.example.json",
  "config/multica/board-day-evidence.example.json",
  ".ai/checkpoints/part-m2-nutritionist-procurement-read/step-2.md"
]
Test status: passing
Tests run:
- `npm run test:unit -- src/agents/live-smoke-manifest.test.ts src/agents/board-day-evidence.test.ts`
- `npm run test:unit -- src/cli/kl.test.ts src/agents/live-smoke-manifest.test.ts src/agents/board-day-evidence.test.ts`
Next step: Hand off for review with no M2 completion claim.
