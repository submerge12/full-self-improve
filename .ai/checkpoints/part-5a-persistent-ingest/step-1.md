## Step 1

What I did: Added persistent mock ingest tests first and confirmed RED with a typed `runPersistentMockIngest` stub.
Files modified: [`src/engine/persistent-ingest.test.ts`, `src/engine/persistent-ingest.ts`]
Test status: 3 failing
RED evidence: `npm run test:unit -- src/engine/persistent-ingest.test.ts` failed because `runPersistentMockIngest is not implemented yet.`
Next step: Implement the narrow store-backed runner and rerun the targeted tests.
