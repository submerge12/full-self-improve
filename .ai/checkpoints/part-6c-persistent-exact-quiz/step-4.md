## Step 4

What I did: Fixed reviewer C1 for blank exact answers. Persistent quiz grading now validates every exact answer before inserting items, rejecting blank default-trim answers, blank whitespace answers, and blank `answerSpec.answers` without partial DB writes. Added coverage that `trim: false` and `caseSensitive: true` answer specs still flow through to the existing exact grader.

Files modified: [G:/knowledge-loop/src/engine/persistent-quiz.ts, G:/knowledge-loop/src/engine/persistent-quiz.test.ts, G:/knowledge-loop/.ai/checkpoints/part-6c-persistent-exact-quiz/step-4.md]

Test status: passing

Verification:
- `npm run test:unit -- src/engine/persistent-quiz.test.ts`: 6 passed.

Next step: Run full project verification and reviewer re-review.
