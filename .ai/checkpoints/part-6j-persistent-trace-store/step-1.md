## Step 1

What I did: Added failing tests for the trace_events migration and durable trace store, then implemented the migration, schema entry, and store helpers until the targeted tests passed.
Files modified: [src/db/migrations.ts, src/db/migrations.test.ts, src/db/schema.ts, src/db/trace-store.ts, src/db/trace-store.test.ts]
Test status: passing - npm run test:unit -- src/db/trace-store.test.ts src/db/migrations.test.ts (14 passed)
Next step: Run typecheck to catch integration and exported type issues.
