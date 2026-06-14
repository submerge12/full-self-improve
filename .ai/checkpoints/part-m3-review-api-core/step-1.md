## Step 1

What I did: Added pure API manifest and handler support for persistent review due-list reads and review attempt mutations, including query/body validation, route envelopes, no trace writes for due-list reads, and atomic trace-backed review attempt persistence. Reviewer fix: added regression coverage for whitespace-containing review slugs returning 400 on missing concept/schedule, broadened review attempt input-error classification, and changed malformed due-list fallback routing to reuse the manifest entry instead of duplicating route metadata.
Files modified: [src/api/contracts.ts, src/api/contracts.test.ts, src/api/handlers.ts, src/api/handlers.test.ts, .ai/checkpoints/part-m3-review-api-core/step-1.md]
Test status: passing
Next step: Hand off to the route-wrapper worker for src/app/api coverage, if that slice is scheduled.
