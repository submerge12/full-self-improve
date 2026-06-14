# part-m2-preflight-board-config step 1

## Changes

- Added `agent-preflight --dry-run` board publish config validation.
- Default board config path: `config/multica/board-publish.example.json`.
- Added optional `--board-config <path>` for preflight without reusing the runtime `--config` flag.
- Added `result.boardConfig` with `configPath`, `valid`, and `validation`.
- Added `offlineChecks` entry `board_publish_config_valid`; preflight status remains `ready_for_live_smoke` only when every offline check passes.
- Reused tolerant board config JSON loading so malformed or validator-invalid board configs return blocked results instead of throwing. Checkout escape and missing-path errors still use the existing resolver behavior.
- Updated the M2 runbook preflight command and wording to say the preflight embeds scheduler, live-smoke manifest, and board publish config validation.

## TDD

RED:

```powershell
npm run test:unit -- src/cli/kl.test.ts
```

Result: failed as expected. The new preflight tests failed because `result.boardConfig` was missing and `--board-config` was still an unknown option.

GREEN:

```powershell
npm run test:unit -- src/cli/kl.test.ts
```

Result: passed. 1 test file passed, 94 tests passed.

## New Tests

- `agent-preflight dry-run combines schedule intent and live-smoke validation without fetching` now also asserts default board config validation and a passed `board_publish_config_valid` check.
- `agent-preflight blocks for an invalid board publish config without fetching`.
- `agent-preflight returns load errors for malformed board publish config JSON`.
- `agent-preflight command validates dry-run mode and rejects live mode` now also asserts an outside `--board-config` path is rejected by the checkout resolver.

## Boundary

This remains offline-only. It does not fetch Knowledge-Loop, compass-health, or Multica endpoints, does not use bearer tokens, does not publish board items, does not install a scheduler, does not read or write Multica/pi-harness checkouts, and does not close M2.

## Final Verification

```powershell
npm run test:unit -- src/cli/kl.test.ts src/agents/board-publish-config.test.ts src/agents/live-smoke-manifest.test.ts src/agents/schedule.test.ts
```

Result: passed. 4 test files passed, 111 tests passed.

```powershell
npm run typecheck
```

Result: passed.

```powershell
npm run lint
```

Result: passed.

```powershell
npm run kl -- agent-preflight --dry-run --now 2026-06-14T07:30:00+08:00 --timezone Asia/Shanghai --daily-at 07:30 --manifest config/multica/live-smoke.example.json --board-config config/multica/board-publish.example.json --config config/agents.example.json
```

Result: passed after rerunning outside the sandbox because the first sandboxed `tsx` launch hit `spawn EPERM`. The dry-run output reported `status: "ready_for_live_smoke"`, `boardConfig.valid: true`, and `offlineChecks` included `board_publish_config_valid: passed`.

```powershell
git diff --check
```

Result: passed with CRLF working-copy warnings only.

## Next Step

Hand back to the coordinator. Do not stage, commit, push, or touch `docs/AUDIT-MANUAL.md`.
