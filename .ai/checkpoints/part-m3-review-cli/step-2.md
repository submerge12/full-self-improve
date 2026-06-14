## Step 2

What I did: Split `kl review` database handling so due-list mode opens an existing database read-only without applying migrations, while attempt mode remains writable and migrates before recording attempts.
Files modified: [src/cli/kl.ts, src/cli/kl.test.ts, .ai/checkpoints/part-m3-review-cli/step-2.md]
Test status: passing
Next step: Report final validation evidence.
