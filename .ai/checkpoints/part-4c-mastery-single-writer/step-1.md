# Step 1 - RED guard

- Added `src/engine/persistent-mastery.test.ts` with a production engine source scan for direct `recordMasteryUpdate` references outside `src/engine/persistent-mastery.ts`.
- Ran `npm run test:unit -- src/engine/persistent-mastery.test.ts`.
- RED result: failed as expected, listing direct writer references in `src/engine/persistent-quiz.ts` and `src/engine/persistent-teachback.ts`.
