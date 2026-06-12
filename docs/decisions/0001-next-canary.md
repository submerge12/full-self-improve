# Next Canary Dependency

## Decision

Use `next@16.3.0-canary.49` for the initial App Router API adapter work.

## Rationale

The current stable `next@16.2.9` resolved to a bundled `postcss` version flagged by
`npm audit --audit-level=moderate`. The selected canary resolves its bundled
`postcss` dependency to `8.5.10`, which keeps the audit gate clean while preserving
the Next 16 App Router target.

## Risk

This is a canary framework release, so route behavior, bundling, and native module
handling can shift before a stable release. The API adapter explicitly exports
`runtime = "nodejs"` in route modules because the runtime context uses
`better-sqlite3`.

## Exit Criteria

Revisit this before stabilization. Move back to the newest stable Next release once
it provides a non-vulnerable bundled `postcss` version and `npm audit
--audit-level=moderate` remains clean.
