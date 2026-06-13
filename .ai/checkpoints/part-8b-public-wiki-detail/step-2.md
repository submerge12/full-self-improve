# Part 8B Step 2 - Green

- Implemented `PublicWikiPageCitation`, `PublicWikiPageDetail`, `getPublicWikiPageDetail`, and `getRuntimePublicWikiPageDetail`.
- Detail reads only `visibility = 'public'` pages, parses safe page ids, preserves stored citation order, and throws `Public wiki page <id> cites missing chunk <id>` for broken provenance.
- Updated `/wiki` summaries to link each public page id.
- Added `/wiki/[pageId]` dynamic server route with a local `throwNextNotFound()` fallback for missing/private/invalid ids and clickable provenance anchors.
- Green evidence: `npm run test:unit -- src/app/_shared/page-data.test.ts` passed with 8 tests before the reviewer-requested malformed citation id coverage was added.
