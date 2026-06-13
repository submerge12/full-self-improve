# Part 2.2 Holly Real Dataset Ingest Proof Step 1 - Scope

- Scope checked against `PLAN.md` section 2:
  - runtime adapter must be `holly-vault`, not the CLI-only `cli-vault`;
  - real `G:\dataset\Holly dataset` content must be listed through configured runtime adapter rules;
  - excluded globs such as `90_待确认/**` must not reach persisted `sources`;
  - source failures must not abort ingest, and failure reason evidence must be explicit.
- Runtime config evidence:
  - `createConfiguredSourceAdapters({ KNOWLEDGE_LOOP_VAULT_ROOT: "G:\\dataset\\Holly dataset" })`;
  - adapter id: `holly-vault`;
  - adapter kind: `markdown-vault`;
  - default exclude values confirmed by `npx tsx`: `90_待确认/**`, `private/**`, `draft/**`, `**/drafts/**`, `**/draft-*`.
- Raw vault candidate scan:
  - total markdown files under `G:\dataset\Holly dataset`: 535;
  - default-excluded markdown files: 10;
  - kept markdown files: 525;
  - excluded samples were all under `90_待确认/**`.

## Notes

- The proof uses a scratch SQLite DB under `.ai/tmp/part-2-2-holly-real-ingest/`.
- No writes were made to `G:\dataset\Holly dataset`.
- No bulk-delete commands were used.
