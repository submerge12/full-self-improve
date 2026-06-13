# Step 2 - Facade implementation

- Added `src/engine/persistent-mastery.ts` as the engine-layer facade around `recordMasteryUpdate`.
- Updated `src/engine/persistent-quiz.ts` and `src/engine/persistent-teachback.ts` to call `recordPersistentMasteryUpdate` instead of the DB writer directly.
- Expanded `src/engine/persistent-mastery.test.ts` with a behavior test for facade upsert and trace propagation.
- Ran `npm run test:unit -- src/engine/persistent-mastery.test.ts`.
- GREEN result: 2 tests passed.
