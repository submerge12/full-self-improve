# M4 Health Windows Logger Runbook

This runbook records the proof steps for the M4 Windows logger live evidence gate.

Run the deterministic config check:

```powershell
npm run kl -- health-windows-logger config-check --config config/health/windows-logger.example.json
```

Render the startup command and install it manually only after review:

```powershell
npm run kl -- health-windows-logger startup-command --config config/health/windows-logger.example.json --script scripts/health-windows-logger.ts
```

Start one real logger run from the repo-owned script:

```powershell
npm exec tsx scripts/health-windows-logger.ts -- --config config/health/windows-logger.example.json
```

Record the observed idle span:

```powershell
npm run kl -- health-sedentary ingest-span --db .ai/tmp/m4-health/live.db --source-id live-20260614-090000 --start 2026-06-14T08:00:00.000Z --end 2026-06-14T09:05:00.000Z --state idle --confidence 1
```

Evaluate the break reminder:

```powershell
npm run kl -- health-break-reminder evaluate --db .ai/tmp/m4-health/live.db --from 2026-06-14T08:00:00.000Z --to 2026-06-14T10:00:00.000Z --threshold-minutes 60
```

Validate the live evidence file:

```powershell
npm run kl -- health-live-evidence windows-logger --dry-run --evidence config/health/windows-logger-evidence.example.json
```

Deterministic logger tests and deterministic reminder records do not close the live gate until a real logger run records startup, sleep/wake survival, at least a 60-minute streak, and a visible break alert.
