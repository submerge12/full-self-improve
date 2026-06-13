# Step 1 - Read and RED test setup

- Read `PLAN.md`, `src/api/contracts.ts`, and `src/api/contracts.test.ts`.
- Confirmed `API_ROUTE_MANIFEST` has seven PLAN 2.5 routes and `createRouteManifestDocument()` already returns a manifest-derived structural document.
- Added RED tests for an exported `createRouteManifestMarkdown()` function that must generate deterministic Markdown rows from `API_ROUTE_MANIFEST` and include bearer/public auth notes.

Verification pending: run focused unit test to confirm the new test fails because the function is missing.
