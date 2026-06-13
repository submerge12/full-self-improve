## Step 1

What I did: Verified the Multica self-host runtime boundary from the external checkout. Docker Desktop was started, Docker engine became reachable, and `docker compose -f docker-compose.selfhost.yml up -d --pull missing` was executed from `G:\multica-ai-multica-https-github-com`. The command recreated the existing backend/frontend containers and left `postgres`, `backend`, and `frontend` running.

Files modified: [`.ai/checkpoints/part-m2-multica-selfhost-live/step-1.md`]

Evidence:
- Docker engine: Docker Desktop server reachable, engine version `27.5.1`; WSL `docker-desktop` running.
- Multica repo root: `G:/multica-ai-multica-https-github-com`.
- Documented compose services: `postgres`, `backend`, `frontend`.
- Compose/env files: `git status --short -- docker-compose.selfhost.yml .env .env.example` returned 0 entries.
- Running containers after alignment:
  - `backend`: `ghcr.io/multica-ai/multica-backend:latest`, compose project `multica`, config file `G:\multica-ai-multica-https-github-com\docker-compose.selfhost.yml`, port `127.0.0.1:8080->8080/tcp`.
  - `frontend`: `ghcr.io/multica-ai/multica-web:latest`, compose project `multica`, config file `G:\multica-ai-multica-https-github-com\docker-compose.selfhost.yml`, port `127.0.0.1:3000->3000/tcp`.
  - `postgres`: `pgvector/pgvector:pg17`, compose project `multica`, status `healthy`.
- Backend health: `GET http://127.0.0.1:8080/health` returned HTTP 200 with `{"status":"ok"}`.
- Backend readiness: `GET http://127.0.0.1:8080/readyz` returned HTTP 200 with `{"status":"ok","checks":{"db":"ok","migrations":"ok"}}`.
- Frontend reachability: `HEAD http://127.0.0.1:3000` returned HTTP 200 with `Content-Type: text/html; charset=utf-8`.

Boundary:
- No Multica source files were edited by this task.
- No files or directories were deleted.
- The self-host command changed Docker runtime state by recreating existing backend/frontend containers; it did not write repo files or delete Docker volumes.
- Local secret material was not recorded. The compose config rendered a JWT secret value; this checkpoint intentionally records only that runtime config rendered successfully, not the value.

Strict blocker:
- Full `git status --short` in `G:\multica-ai-multica-https-github-com` currently reports 157 entries. Because those external dirty/untracked entries remain, the strict PLAN wording "Multica runs locally from its unmodified repo" is not fully proven from a clean checkout. The functional self-host is verified, but strict milestone closure still needs either a clean external Multica checkout or an explicit user-approved baseline for the existing external state.

Test status: live probe passing with strict clean-repo blocker.

Next step: reviewer pass for the evidence boundary, then commit and push this checkpoint. Continue M2, but do not mark M2 complete until the strict external-repo blocker and remaining live proofs are resolved.
