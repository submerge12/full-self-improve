# Part 2.1 Dev Render Smoke Step 1 - Diagnosis

- Scope checked against PLAN 2.1: `npm run dev` must start the app, and the private UI plus public wiki must render.
- Seeded a temporary SQLite database at `.ai/tmp/part-2-1-dev-render-smoke/smoke.db` with:
  - one public page: `Public Smoke Concept`, page id `1`, citation to `Public Smoke Source`;
  - one private page: `Private Smoke Concept`, used to verify public routes do not leak private content;
  - one study plan for `2026-06-13`;
  - one mastery row for `Public Smoke Concept` with score `0.42`, confidence `0.7`, attempts `2`.
- Read-only worker Peirce investigated the failed dev launch path. The finding was that Next canary prints `Ready` before handler initialization is complete, so `Ready` alone is not sufficient readiness evidence.
- Initial `npm run dev` attempts inside the managed sandbox failed with `spawn EPERM` when Next CLI tried to fork its dev server child process.
- Direct `npx next build --webpack` exposed the real source issues after bypassing the default Turbopack path: App Router modules using NodeNext `.js` imports needed webpack extension aliasing, and the dynamic wiki page needed the Next 16 Promise-shaped `params` contract.
