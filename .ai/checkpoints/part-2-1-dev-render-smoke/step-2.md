# Part 2.1 Dev Render Smoke Step 2 - Fix

- Changed `npm run dev` to `next dev --webpack` so the required PLAN command uses the stable webpack path for this Next 16 canary project.
- Added `next.config.mjs` with:
  - `agentRules: false`, preventing Next from generating root `AGENTS.md` / `CLAUDE.md` files during dev runs;
  - webpack `extensionAlias` for `.js -> .ts/.tsx/.js` and `.jsx -> .tsx/.jsx`, preserving the repository's NodeNext import style while allowing Next webpack to resolve TypeScript sources.
- Updated `src/app/(public)/wiki/[pageId]/page.tsx` so `params` matches Next 16's Promise-shaped `PageProps` and normalizes string-array values before reading public wiki detail data.
- Kept Next's TypeScript support changes in `tsconfig.json`: DOM libs, Next plugin, `.next` generated types includes, `allowJs`, `noEmit`, `incremental`, and `isolatedModules`.
- Ignored local run products in `.gitignore`: `.ai/tmp/`, `*.tsbuildinfo`, and `next-env.d.ts`.
- Added `.ai/tmp/**` to `eslint.config.mjs` ignores so temporary smoke harness files do not break `npm run lint`.
- Removed generated root files one explicit path at a time: `AGENTS.md`, `CLAUDE.md`, `next-env.d.ts`, and `tsconfig.tsbuildinfo`.
