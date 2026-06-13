## Step 1

What I did: Added a read-only `agent-harness-dependency --dry-run` preflight for the M2 pi-harness dependency boundary. It validates pi-harness package metadata, root/CLI exports, required `dist` files including CLI types, the `new-agent` script and file, and `git --no-optional-locks ... status --short` cleanliness through an injected filesystem/exec boundary in tests. Required paths must be files, not directories, and package/git inspection failures are reported with sanitized errors.
Files modified: [`src/agents/pi-harness-dependency.ts`, `src/agents/pi-harness-dependency.test.ts`, `src/cli/kl.ts`, `src/cli/kl.test.ts`, `docs/runbooks/m2-multica.md`, `.ai/checkpoints/part-m2-pi-harness-dependency-preflight/step-1.md`]
Boundary: This preflight is read-only. It does not install, link, import, or run pi-harness, does not modify `G:\pi-harness`, and does not prove M2. The actual dependency proof still requires consuming pi-harness from knowledge-loop and showing the external checkout is clean.
Actual local dry-run: `npm run kl -- agent-harness-dependency --dry-run --harness-path G:\pi-harness` returned `status: "blocked"` because `git_status_clean` found 2 dirty entries. The report redacts the external path and does not print raw dirty filenames. Package metadata and required dist checks passed.
Test status: passing - `npm run test:unit -- src/agents/pi-harness-dependency.test.ts src/cli/kl.test.ts` passed with 2 files and 92 tests.
Next step: split reviewer pass, then final verification, commit, push, and continue M2 live proof preparation.
