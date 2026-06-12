## Step 5

What I did: Added sparse array trace data coverage and updated JSON array validation to reject missing indexes before JSON.stringify can turn them into null.
Files modified: [src/db/trace-store.ts, src/db/trace-store.test.ts]
Test status: passing - npm run test:unit -- src/db/trace-store.test.ts src/db/migrations.test.ts (29 passed); npm run typecheck
Next step: Return for re-review.
