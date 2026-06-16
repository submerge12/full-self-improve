# Review Status Snapshot

Date: 2026-06-16

This snapshot summarizes the review notes and checkpoint evidence currently recorded for M1-M5. It does not modify `PLAN.md` global checklists and does not close live or Section 0 gates by implication.

| Milestone | Current status | Deterministic/offline evidence | Live evidence pending | Next ownership |
| --- | --- | --- | --- | --- |
| M1 | Live demo verified; strict closure blocked by Section 0. | Mock/no-key check, Holly ingest, CLI learning flow, API/wiki privacy, graph-store rejection and link trace logging are recorded in `docs/reviews/M1.md` and related checkpoints. | Section 0 frozen-repo clean/baseline recheck remains required before strict M1 completion. | Closure owner to baseline or recheck Section 0 frozen repos. |
| M2 | Implementation/offline evidence recorded; strict closure pending live orchestration proof. | Agent profiles, dry-run day runner, gated live CLI paths, validators, failure blocker simulation, mastery renderer, and cost fields are recorded in `docs/reviews/M2.md`. | Blocked by live Multica/scheduler/pi-harness/cost/mastery evidence: two hands-free board days, clean pi-harness dependency proof, live failure blocker, evening mastery delta comparison, and real cost snapshot. | M2 live owner to run and capture Multica, scheduler, pi-harness, mastery, and cost evidence. |
| M3 | Phase-2 implementation verified; strict closure blocked by Section 0. | FSRS due review, review attempt update, application task grading, due review/application planning, CLI/API/route surfaces, and focused tests are recorded in `docs/reviews/M3.md`. | Section 0 frozen-repo baseline/recheck remains required before strict M3 completion. | Closure owner to baseline or recheck Section 0 frozen repos. |
| M4 | Deterministic implementation evidence recorded; M4 remains pending live gates. | Health metrics, exercise, sedentary tracking, Coach digest/publish dry-run, Windows logger validation, and deterministic checks are recorded in `docs/reviews/M4.md`. | Blocked by Windows logger live startup/sleep-wake/60-minute alert evidence, Coach live publish, one-week compass-health hash proof, and Section 0/mock-mode recheck. | M4 live owner to collect real-use Windows, Coach, compass-health hash, and closure recheck evidence. |
| M5 | Deterministic complete. | Second adapter genericity proof with zero `src/engine/` diff, backup/restore drill, read-only ops dashboard, final verification, `docs/reviews/M5.md`, and four M5 checkpoints are recorded. | No M5-specific live gate is closed here; earlier M1-M4 live/Section 0 gates remain pending as listed above. | Status-sync/closure owner may treat M5 deterministic evidence as complete while leaving earlier gates open. |

## Summary

- M5 deterministic complete.
- M1 and M3 strict closure remain blocked by Section 0.
- M2 remains blocked by live Multica/scheduler/pi-harness/cost/mastery evidence.
- M4 remains blocked by Windows logger evidence, Coach live publish, one-week compass-health hash proof, and Section 0/mock-mode recheck.
- `docs/AUDIT-MANUAL.md` is an existing untracked workspace file and is intentionally excluded from this status sync; it must remain unstaged unless explicitly requested.
