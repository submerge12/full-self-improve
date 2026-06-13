# M2 Board Publish Config Validator - Step 1

What I did: Added an offline board publish config validator and dry-run CLI entry. The validator checks `config/multica/board-publish.example.json` stays `inferred_live_smoke_pending`, uses HTTP(S) endpoints without URL credentials, keeps the workspace mapping secret-free and path-free, includes both `create_task` and `add_comment` mappings, requires `POST`, requires `{issueId}` for comment templates, and requires the current action payload placeholders. The CLI command `agent-board-config --dry-run --config config/multica/board-publish.example.json` reads only a config file inside the knowledge-loop checkout, returns `valid` plus validator errors/warnings/summary, and keeps the result explicitly offline.

Command:

```powershell
npm run kl -- agent-board-config --dry-run `
  --config config/multica/board-publish.example.json
```

Boundary: This validation does not call Multica, prove the Multica API contract, resolve `{issueId}`, install a scheduler, prove live board posting, prove two consecutive hands-free days, or close M2. It is a live-gate input only. The result includes a warning that `agent-day --live` currently uses explicit endpoint flags and the internal agent action payload rather than rendering this payload template.

Files modified: [src/agents/board-publish-config.ts, src/agents/board-publish-config.test.ts, src/agents/http-clients.ts, src/agents/http-clients.test.ts, src/cli/kl.ts, src/cli/kl.test.ts, docs/runbooks/m2-multica.md, .ai/checkpoints/part-m2-board-publish-validator/step-1.md]
Test status: passing - `npm run test:unit -- src/agents/board-publish-config.test.ts src/cli/kl.test.ts src/agents/http-clients.test.ts src/agents/profiles.test.ts` passed with 4 files and 99 tests; `npm run kl -- agent-board-config --dry-run --config config/multica/board-publish.example.json` returned `valid: true` with the offline-candidate warning and non-completion notice.
Review status: initial split reviewers found URL userinfo and live-client-binding overclaim risks; follow-up reviews found missing malformed-JSON coverage, narrow duplicate-key coverage, and raw credential leakage in live endpoint prevalidation errors. Fixes added URL credential rejection/redaction in the validator, live CLI prevalidation, and HTTP board client; non-leaking live endpoint error messages; broader filesystem-path rejection; duplicate-key `valid:false` behavior with nested/string-literal/unicode-escape coverage; malformed JSON `valid:false` coverage; and explicit offline-candidate warnings in output, docs, and checkpoint.
Next step: Run final full verification before commit and push, then continue with the next M2 task.
