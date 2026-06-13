Step 2 - Scope check after red attempt

- Confirmed the new test uses a temporary vault and a separate temporary SQLite DB path.
- Confirmed the flow goes through `handleKlCommand` for `ingest`, `plan`, `quiz`, `teachback`, `diagnose`, and `trace`.
- Confirmed assertions cover persistent/mock mode, domain-table writes, stored trace rows, and trace query results for the ingest run.
- No boundary files outside the allowed list were modified.
