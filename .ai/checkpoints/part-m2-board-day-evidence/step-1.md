## Step 1

What I did: Added the M2 board-day evidence validator core module, a two-day offline observation example aligned to the live-smoke manifest, a dry-run CLI command, and runbook guidance. The validator checks observed board-day items against the manifest, rejects secret-like values, filesystem paths, URL credentials, fake closure fields/statuses, malformed evidence JSON, missing/duplicate items, and required board-evidence gaps.
Files modified: [src/agents/board-day-evidence.ts, src/agents/board-day-evidence.test.ts, src/cli/kl.ts, src/cli/kl.test.ts, config/multica/board-day-evidence.example.json, docs/runbooks/m2-multica.md, .ai/checkpoints/part-m2-board-day-evidence/step-1.md]
Command:

```powershell
npm run kl -- agent-board-evidence --dry-run `
  --evidence config/multica/board-day-evidence.example.json `
  --manifest config/multica/live-smoke.example.json
```

Boundary: `agent-board-evidence` is offline-only. A passing result means the evidence file is shaped for later human/live verification. It does not call Multica, prove hands-free execution, prove live board posting, satisfy the two-day requirement, or close M2. The runbook keeps it post-observation, not a pre-live gate.
Review status: split reviewers found that the runbook initially blurred pre-live vs post-observation evidence, malformed manifest input could crash instead of returning `valid:false`, boardEvidence fields only checked key presence, fake-closure detection was narrow, `FILE://` path detection was case-sensitive, and method-prefixed source endpoints could hide URL credentials. Fixes split the runbook gate wording, made manifest loading tolerant for `agent-board-evidence`, hardened manifest day/item runtime checks, added per-field boardEvidence shape validation, broadened fake-closure guards, normalized file-scheme detection, scanned the reference manifest for unsafe values, and extracted the URL part from `GET/POST <url>` endpoints before unsafe checks.
Test status: passing - `npm run test:unit -- src/agents/board-day-evidence.test.ts src/cli/kl.test.ts` passed with 2 files and 90 tests; `npm run typecheck` passed; `npm run lint` passed.
Next step: reviewer recheck, then final verification, commit, and push this part.
