## Step 2

What I did: Added non-empty exact-answer validation to `gradeQuizAttempt` via `toExactAnswerSpec`, preserving `trim: false` behavior for non-empty spacing answers and returning cloned answer arrays. This aligns mock quiz mode with persistent quiz validation.

Files modified: [G:/knowledge-loop/src/engine/mock-commands.ts, G:/knowledge-loop/src/engine/mock-commands.test.ts, G:/knowledge-loop/src/cli/kl.test.ts]

Test status: passing

Verification:
- `npm run test:unit -- src/engine/mock-commands.test.ts`: 7 passed.
- `npm run test:unit -- src/cli/kl.test.ts`: 21 passed.
- `npm run test:unit -- src/engine/persistent-quiz.test.ts`: 6 passed.
- `npm run check`: typecheck, lint, and 118 unit tests passed outside the sandbox.

Next step: Reviewer review and push if approved.
