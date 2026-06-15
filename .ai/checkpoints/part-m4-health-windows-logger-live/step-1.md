## Step 1

What I did: added the repo-owned Windows health logger companion, startup command rendering, deterministic visible-alert path, live-evidence validator, example config/evidence files, runbook proof steps, and dry-run CLI surfaces.

Files modified:
- `src/health-extensions/windows-logger.ts`
- `src/health-extensions/windows-logger.test.ts`
- `src/health-extensions/windows-logger-contract.ts`
- `src/health-extensions/windows-logger-contract.test.ts`
- `src/health-extensions/live-evidence.ts`
- `src/health-extensions/live-evidence.test.ts`
- `scripts/health-windows-logger.ts`
- `config/health/windows-logger.example.json`
- `config/health/windows-logger-evidence.example.json`
- `docs/runbooks/m4-health-windows-logger.md`
- `src/cli/kl.ts`
- `src/cli/kl.test.ts`
- `.ai/checkpoints/part-m4-health-windows-logger-live/step-1.md`

Logger proof: `createWindowsHealthLogger` polls an injected idle provider using `{ now, idleMs }`, opens and closes idle spans, posts span/reminder HTTP requests with bearer auth, emits heartbeat metrics, handles sleep/wake gaps with a `logger_recovered_after_gap` heartbeat, and triggers an injected visible alert when a reminder is eligible.

Config/startup proof: `health-windows-logger config-check --config config/health/windows-logger.example.json` validates the repo-owned example config without exposing bearer tokens. `health-windows-logger startup-command --config config/health/windows-logger.example.json --script scripts/health-windows-logger.ts` renders the `schtasks /Create` command without executing registration.

Evidence proof: `validateWindowsLoggerLiveEvidence` checks `observed_live_alert_pending_review`, startup observation, sleep/wake survival, at least a 60-minute sedentary streak, reminder recording within 5 minutes, visible alert observation, repo-owned logger/source references, and rejects fake closure fields, secret-like values, and frozen-repo filesystem paths.

Tests run:
- `npm run test:unit -- src/health-extensions/windows-logger.test.ts src/health-extensions/live-evidence.test.ts src/health-extensions/windows-logger-contract.test.ts`
- `npm run test:unit -- src/health-extensions/windows-logger.test.ts src/health-extensions/live-evidence.test.ts src/health-extensions/windows-logger-contract.test.ts src/cli/kl.test.ts`
- `npm run typecheck`
- `node_modules\.bin\tsc.cmd --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --types node --lib dom,dom.iterable,esnext --esModuleInterop --skipLibCheck scripts\health-windows-logger.ts`
- `npm run kl -- health-windows-logger config-check --config config/health/windows-logger.example.json`
- `npm run kl -- health-windows-logger startup-command --config config/health/windows-logger.example.json --script scripts/health-windows-logger.ts`
- `npm run kl -- health-live-evidence windows-logger --dry-run --evidence config/health/windows-logger-evidence.example.json`

Review status:
- Logger/script/contract reviewer requested one fix for default PowerShell alerts. The module now throws unless a `visibleAlertClient` is injected for `powershell`, and the live script injects the PowerShell client. Re-review approved.
- Evidence/runbook reviewer approved.
- CLI/checkpoint reviewer approved.

Live evidence status: deterministic tests and dry-run evidence validation are implemented, but this does not close M4. A real Windows logger run must still record startup, sleep/wake survival, a >=60-minute streak, and a visible break alert before the M4 live gate can be marked observed.

Test status: passing
Next step: split reviewer review for logger/script, evidence/runbook, and CLI/checkpoint before committing and pushing this slice.
