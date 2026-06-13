# M2 Multica And Agent Profiles Runbook

This runbook records the external Multica and pi-harness boundary for the M2 orchestration spine.

## Frozen Repositories

Do not modify the Multica repository at `G:\multica-ai-multica-https-github-com`.
Do not run pi-harness scaffolding that writes into `G:\pi-harness`.
Agent profiles and dry-run configuration for this project live in this repository.

## Multica Self-Host

Run Multica from its own checkout after preparing that checkout according to Multica's own self-hosting docs:

```powershell
Set-Location G:\multica-ai-multica-https-github-com
docker compose -f docker-compose.selfhost.yml up -d
```

This runbook deliberately does not include file creation or edit commands for the Multica checkout. The documented shortcut in that repository is `make selfhost`. If local images need to be rebuilt, use Multica's documented build compose flow from that checkout.

Expected local endpoints:

- App: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:8080`

## Knowledge-Loop Config

Use `config/multica/selfhost.env.example` as the local variable template. Keep credential values empty in committed files and provide them only through the local shell or untracked environment files.

Use `config/multica/board-publish.example.json` as the declarative publish mapping. Its `contractStatus` is `inferred_live_smoke_pending`, so treat the endpoints as candidates until a running Multica instance confirms them. The current observed Multica board-like surface is issues:

- `create_task`: `POST http://127.0.0.1:8080/api/issues`
- `add_comment`: `POST http://127.0.0.1:8080/api/issues/{issueId}/comments`

The comment endpoint needs a concrete issue id from a prior created task or an existing Multica issue. Do not invent a board id until a running Multica instance proves the workspace or issue-board contract.

## Dry-Run First

Run these from `G:\knowledge-loop`:

```powershell
npm run kl -- agent --dry-run --role librarian --date 2026-06-13
npm run kl -- agent --dry-run --role scholar --phase morning-plan --date 2026-06-13
npm run kl -- agent --dry-run --role nutritionist --date 2026-06-13
npm run kl -- agent-day --dry-run --date 2026-06-13
```

Dry-run mode prints intended Multica actions and keeps `externalWrites` empty.

## Manual Live Agent-Day Smoke (Gated)

The manual trigger is available only with an explicit `--live` flag and explicit Multica publish endpoints. It is the M2 bridge toward the plan's "scheduler firing or manually triggered" criterion, but it does not by itself prove the two-day hands-free scheduler requirement.

Keep bearer values in the local shell only:

```powershell
$env:KL_AGENT_READ_BEARER_TOKEN = "<local knowledge-loop token if required>"
$env:KL_MULTICA_BEARER_TOKEN = "<local Multica token if required>"

npm run kl -- agent-day --live `
  --date 2026-06-13 `
  --knowledge-loop-url http://127.0.0.1:3000 `
  --compass-health-url http://127.0.0.1:8000 `
  --board daily-plan `
  --multica-create-task-url http://127.0.0.1:8080/api/issues `
  --multica-add-comment-url http://127.0.0.1:8080/api/issues/<issue-id>/comments
```

The `--multica-add-comment-url` value must be a concrete endpoint confirmed against a running Multica instance. Because `config/multica/board-publish.example.json` is still `inferred_live_smoke_pending`, treat the issue/comment URLs as candidate wiring until a live smoke confirms the board contract.

## Live Gate

Before enabling live publish, verify a running Multica self-host instance with a bearer-authenticated smoke test and confirm the workspace or issue-board identifiers. The live agent client must use HTTP endpoints only and must not read or write files in the Multica checkout.
