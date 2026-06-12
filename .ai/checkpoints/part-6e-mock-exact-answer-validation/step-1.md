## Step 1

What I did: Added RED tests for blank exact answers in mock quiz grading and CLI mock mode after reviewer feedback found that `--answer "" --response ""` could be marked correct.

Files modified: [G:/knowledge-loop/src/engine/mock-commands.test.ts, G:/knowledge-loop/src/cli/kl.test.ts]

Test status: failing

RED evidence:
- `npm run test:unit -- src/engine/mock-commands.test.ts` failed because blank exact answers were accepted.
- `npm run test:unit -- src/cli/kl.test.ts` failed because mock CLI quiz resolved with `verdict: "correct"` for blank answer/response.

Next step: Add non-empty exact-answer validation to the shared mock grader.
