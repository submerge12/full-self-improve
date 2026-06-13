# Part 8B Step 1 - Red

- Scope checked against PLAN sections 2.4, 2.5, and M1 row.
- Added tests for public wiki detail retrieval, private/missing/invalid id handling, broken citation handling, and summary link ids.
- Red command: `npm run test:unit -- src/app/_shared/page-data.test.ts`
- Red evidence: command exited 1 with 3 failing tests because `getPublicWikiPageDetail` was not implemented/exported yet.
