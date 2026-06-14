# Step 4 - Review Scope Clarification

Task: `part-m3-fsrs-due-review`

Scope:
- Respond to the final reviewer status concern about `docs/AUDIT-MANUAL.md`.
- Do not modify, delete, stage, or include `docs/AUDIT-MANUAL.md`.
- Record the file as pre-existing untracked workspace noise outside this slice.

## Evidence

Current status shows the M3 slice files plus `docs/AUDIT-MANUAL.md` as untracked:

```powershell
git status --short --untracked-files=all
```

Relevant output:

```text
 M src/engine/mock-commands.ts
 M src/engine/persistent-plan.test.ts
 M src/engine/persistent-plan.ts
?? .ai/checkpoints/part-m3-fsrs-due-review/step-1.md
?? .ai/checkpoints/part-m3-fsrs-due-review/step-2.md
?? .ai/checkpoints/part-m3-fsrs-due-review/step-3.md
?? docs/AUDIT-MANUAL.md
?? src/engine/persistent-review.test.ts
?? src/engine/persistent-review.ts
```

Tracked diff for this slice excludes `docs/AUDIT-MANUAL.md`:

```powershell
git diff --name-only -- . ':!docs/AUDIT-MANUAL.md'
```

Relevant output:

```text
src/engine/mock-commands.ts
src/engine/persistent-plan.test.ts
src/engine/persistent-plan.ts
```

`docs/AUDIT-MANUAL.md` is not tracked:

```powershell
git ls-files -- docs/AUDIT-MANUAL.md
```

Relevant output: empty.

## Decision

`docs/AUDIT-MANUAL.md` is outside this task and must remain unstaged. The final staged set for this slice should include only:

- `src/engine/persistent-review.ts`
- `src/engine/persistent-review.test.ts`
- `src/engine/persistent-plan.ts`
- `src/engine/persistent-plan.test.ts`
- `src/engine/mock-commands.ts`
- `.ai/checkpoints/part-m3-fsrs-due-review/step-1.md`
- `.ai/checkpoints/part-m3-fsrs-due-review/step-2.md`
- `.ai/checkpoints/part-m3-fsrs-due-review/step-3.md`
- `.ai/checkpoints/part-m3-fsrs-due-review/step-4.md`
