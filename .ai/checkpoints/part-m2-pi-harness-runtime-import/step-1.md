## Step 1

What I did: Added an explicit pi-harness runtime import proof path to the existing dependency preflight. `agent-harness-dependency --dry-run` can now take `--runtime-package pi-harness`, dynamically import `pi-harness` and `pi-harness/cli`, and block unless the linked/installed runtime exposes the expected public symbols. The default preflight remains package-shape only, so clean clones do not need `G:\pi-harness` installed.

Files modified: [`src/agents/pi-harness-dependency.ts`, `src/agents/pi-harness-dependency.test.ts`, `src/cli/kl.ts`, `src/cli/kl.test.ts`, `docs/runbooks/m2-multica.md`, `.ai/checkpoints/part-m2-pi-harness-runtime-import/step-1.md`]

Boundary:
- `package.json` and `package-lock.json` were not changed. No local `file:` dependency was committed.
- Runtime import is opt-in through `--runtime-package pi-harness`; arbitrary package specifiers are rejected.
- Import failures are reported as blocked without leaking local module resolution paths.
- This does not install, link, or modify `G:\pi-harness`, and does not close M2.

Validation:
- `npm run test:unit -- src/agents/pi-harness-dependency.test.ts src/cli/kl.test.ts` passed with 2 files and 97 tests.
- `npm run test:unit -- src/agents/pi-harness-dependency.test.ts src/cli/kl.test.ts src/agents/profiles.test.ts` passed with 3 files and 106 tests.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm run check` passed with 37 files and 413 tests after sandbox `spawn EPERM` required the already-approved elevated check path.
- `git diff --check` passed.
- `npm audit --audit-level=moderate` passed with 0 vulnerabilities.

Review status:
- Worker research was split across pi-harness API shape and knowledge-loop dependency constraints.
- A reviewer pass was attempted for this slice, but new reviewer agents were unavailable because the platform returned a usage-limit error. This checkpoint therefore records local verification evidence but not an independent reviewer approval for this specific runtime-import slice.

Live status:
- The actual local runtime import proof has not been claimed in this step. The previous preflight still showed the external `G:\pi-harness` checkout blocked by dirty git status, and the live runtime proof requires a linked or installed `pi-harness` package in this environment.

Next step: commit, push, and continue M2 live proof work without marking the pi-harness dependency criterion complete until both runtime import and clean external checkout pass.
