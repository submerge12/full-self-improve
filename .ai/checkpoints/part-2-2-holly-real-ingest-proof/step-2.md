# Part 2.2 Holly Real Dataset Ingest Proof Step 2 - Results

- Command shape:
  - `KNOWLEDGE_LOOP_VAULT_ROOT=G:\dataset\Holly dataset`;
  - `KNOWLEDGE_LOOP_PROOF_DB=G:\knowledge-loop\.ai\tmp\part-2-2-holly-real-ingest\holly-ingest-20260613-1.db`;
  - `KNOWLEDGE_LOOP_PROOF_RUN_ID=holly-real-ingest-2026-06-13`;
  - runtime adapter was created through `createConfiguredSourceAdapters`, then passed to `runPersistentMockIngest`.
- Adapter list proof:
  - listed documents: 525;
  - listed excluded documents: 0;
  - first listed docs:
    - `0 记录还需要看的视频.md`;
    - `00_目录总览.md`;
    - `00_自动化目录总览.md`;
    - `01_项目资料/AI基础设施/ai-infra-7-day-detailed-plan.md`;
    - `01_项目资料/AI基础设施/ai-infra-7-day-study-guide.md`.
- Persistent ingest summary:
  - `sourcesSeen`: 525;
  - `sourcesProcessed`: 525;
  - `sourcesSkipped`: 0;
  - `sourcesFailed`: 0;
  - `chunksCreated`: 4408;
  - `conceptsCreated`: 2141;
  - `pagesCreated`: 2141.
- Scratch DB table counts:
  - `sources`: 525;
  - `chunks`: 4408;
  - `concepts`: 2141;
  - `concept_edges`: 0;
  - `pages`: 2141;
  - `trace_events`: 15366.
- `sources` status distribution:
  - `ingested`: 525.
- Exclude verification:
  - persisted `sources.doc_ref` rows matching `90_待确认/**`, `private/**`, `draft/**`, `**/drafts/**`, or `**/draft-*`: 0.
- Failure evidence:
  - `sources.status='error'` rows: 0;
  - persisted `trace_events` with `stage='chunk'`, `level='error'`, and `data.outcome='source_error'`: 0.

## Notes

- Because this real run had zero source failures, it proves the current dataset does not trigger the failure path during full ingest.
- Existing unit coverage still owns the positive failure-reason behavior: failed sources are marked `sources.status='error'`, while reasons are persisted in `trace_events.data.reason` with `data.outcome='source_error'`.

## Repro Commands

The scratch helper scripts used during this proof live under ignored `.ai/tmp`; the durable proof is the checkpoint plus these command shapes.

Raw candidate scan:

```powershell
$env:KNOWLEDGE_LOOP_VAULT_ROOT = "G:\dataset\Holly dataset"
node .ai\tmp\part-2-2-holly-real-ingest\scan-holly-vault-candidates.cjs
```

Runtime adapter list:

```powershell
$env:KNOWLEDGE_LOOP_VAULT_ROOT = "G:\dataset\Holly dataset"
npx tsx -e "import { createConfiguredSourceAdapters } from './src/adapters/config.ts'; void (async () => { const adapter = createConfiguredSourceAdapters(process.env)?.['holly-vault']; if (!adapter) throw new Error('holly-vault adapter missing'); const docs = []; for await (const doc of adapter.listDocuments()) docs.push(doc); const excluded = docs.filter((doc) => doc.path.startsWith('90_待确认/') || doc.path.startsWith('private/') || doc.path.startsWith('draft/') || doc.path.includes('/drafts/') || /(^|\/)draft-[^/]*$/.test(doc.path)); console.log(JSON.stringify({ adapterId: adapter.id, kind: adapter.kind, listed: docs.length, excludedCount: excluded.length, first: docs.slice(0, 5).map((doc) => doc.path) }, null, 2)); })();"
```

Scratch DB ingest:

```powershell
$env:KNOWLEDGE_LOOP_VAULT_ROOT = "G:\dataset\Holly dataset"
$env:KNOWLEDGE_LOOP_PROOF_DB = "G:\knowledge-loop\.ai\tmp\part-2-2-holly-real-ingest\holly-ingest-20260613-1.db"
$env:KNOWLEDGE_LOOP_PROOF_RUN_ID = "holly-real-ingest-2026-06-13"
npx tsx .ai\tmp\part-2-2-holly-real-ingest\run-holly-ingest-proof.ts
```

DB verification queries:

```sql
SELECT COUNT(*) AS count FROM sources;
SELECT status, COUNT(*) AS count FROM sources GROUP BY status ORDER BY status;
SELECT COUNT(*) AS count
FROM sources
WHERE doc_ref LIKE '90_待确认/%'
   OR doc_ref LIKE 'private/%'
   OR doc_ref LIKE 'draft/%'
   OR doc_ref LIKE '%/drafts/%'
   OR doc_ref GLOB 'draft-*'
   OR doc_ref GLOB '*/draft-*';
SELECT COUNT(*) AS count FROM sources WHERE status = 'error';
SELECT COUNT(*) AS count
FROM trace_events
WHERE run_id = 'holly-real-ingest-2026-06-13'
  AND stage = 'chunk'
  AND level = 'error'
  AND json_extract(data, '$.outcome') = 'source_error';
```
