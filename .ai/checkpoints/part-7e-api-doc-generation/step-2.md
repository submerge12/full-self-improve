# Step 2 - RED confirmed and implementation added

- Ran `npm run test:unit -- src/api/contracts.test.ts`.
- RED result: failed with `TypeError: createRouteManifestMarkdown is not a function` in the two new Markdown documentation tests; 11 existing tests passed.
- Added exported `createRouteManifestMarkdown()` in `src/api/contracts.ts`.
- The function generates Markdown only from `API_ROUTE_MANIFEST`, preserving manifest order and including id, method, path, auth, and description columns plus bearer/public read auth notes.

Verification pending: rerun focused unit test and typecheck.
