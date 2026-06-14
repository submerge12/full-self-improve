import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import {
  completeExerciseSession,
  createExercisePlanFromTemplate,
  createExerciseTemplate,
  queryExerciseCompletion
} from "./exercise.js";
import { getExerciseSessionById } from "./store.js";

describe("exercise domain", () => {
  test("creates and updates a template by slug with validated default days", () => {
    const db = migratedDb();

    try {
      const created = createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        description: "first week",
        defaultDays: [
          {
            sessionKey: "push",
            dayOffset: 0,
            title: "Push",
            targetMinutes: 20
          }
        ]
      });
      const updated = createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength Updated",
        defaultDays: [
          {
            sessionKey: "pull",
            dayOffset: 2,
            title: "Pull",
            targetReps: 30
          }
        ],
        active: false
      });

      expect(updated.template.id).toBe(created.template.id);
      expect(updated.created).toBe(false);
      expect(updated.template).toMatchObject({
        name: "Starter Strength Updated",
        active: false,
        defaultDays: [{ sessionKey: "pull", dayOffset: 2, title: "Pull", targetReps: 30 }]
      });
      expect(tableCount(db, "exercise_templates")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("rejects invalid template defaults without writing partial rows", () => {
    const db = migratedDb();

    try {
      expect(() =>
        createExerciseTemplate(db, {
          slug: "bad-template",
          name: "Bad Template",
          defaultDays: [
            {
              sessionKey: "duplicate",
              dayOffset: 0,
              title: "Push",
              targetMinutes: 20
            },
            {
              sessionKey: "duplicate",
              dayOffset: 1,
              title: "Pull",
              targetReps: 20
            }
          ]
        })
      ).toThrow("defaultDays sessionKey values must be unique");
      expect(() =>
        createExerciseTemplate(db, {
          slug: "missing-target",
          name: "Missing Target",
          defaultDays: [{ sessionKey: "walk", dayOffset: 0, title: "Walk" }]
        })
      ).toThrow("defaultDays targetMinutes or targetReps is required");
      expect(tableCount(db, "exercise_templates")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("creates a Monday weekly plan from template days and rejects duplicate active plans", () => {
    const db = migratedDb();

    try {
      createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [
          { sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 },
          { sessionKey: "pull", dayOffset: 2, title: "Pull", targetReps: 30 }
        ]
      });

      expect(() =>
        createExercisePlanFromTemplate(db, {
          templateSlug: "starter-strength",
          weekStart: "2026-06-16"
        })
      ).toThrow("weekStart must be a Monday");
      expect(tableCount(db, "exercise_plans")).toBe(0);

      const result = createExercisePlanFromTemplate(db, {
        templateSlug: "starter-strength",
        weekStart: "2026-06-15"
      });

      expect(result.plan).toMatchObject({ weekStart: "2026-06-15", status: "active" });
      expect(result.sessions).toMatchObject([
        {
          templateSessionKey: "push",
          scheduledFor: "2026-06-15T00:00:00.000Z",
          status: "planned",
          durationMinutes: 20
        },
        {
          templateSessionKey: "pull",
          scheduledFor: "2026-06-17T00:00:00.000Z",
          status: "planned"
        }
      ]);
      expect(result.sessions[1]?.durationMinutes).toBeUndefined();
      expect(() =>
        createExercisePlanFromTemplate(db, {
          templateSlug: "starter-strength",
          weekStart: "2026-06-15"
        })
      ).toThrow("active exercise plan already exists for weekStart");
      expect(tableCount(db, "exercise_plans")).toBe(1);
      expect(tableCount(db, "exercise_sessions")).toBe(2);
    } finally {
      db.close();
    }
  });

  test("rolls back plan and sessions when session insertion fails", () => {
    const db = migratedDb();

    try {
      createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [
          { sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 },
          { sessionKey: "pull", dayOffset: 2, title: "Pull", targetReps: 30 }
        ]
      });
      db.prepare(
        `CREATE TRIGGER exercise_session_abort_second
         BEFORE INSERT ON exercise_sessions
         WHEN (SELECT COUNT(*) FROM exercise_sessions) = 1
         BEGIN
           SELECT RAISE(ABORT, 'session insert forced failure');
         END`
      ).run();

      expect(() =>
        createExercisePlanFromTemplate(db, {
          templateSlug: "starter-strength",
          weekStart: "2026-06-15"
        })
      ).toThrow("session insert forced failure");
      expect(tableCount(db, "exercise_plans")).toBe(0);
      expect(tableCount(db, "exercise_sessions")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("completes planned sessions and lists ad hoc sessions outside the planned denominator", () => {
    const db = migratedDb();

    try {
      createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [
          { sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 },
          { sessionKey: "pull", dayOffset: 2, title: "Pull", targetReps: 30 }
        ]
      });
      const plan = createExercisePlanFromTemplate(db, {
        templateSlug: "starter-strength",
        weekStart: "2026-06-15"
      });

      const completed = completeExerciseSession(db, {
        sessionId: plan.sessions[0]!.id,
        completedAt: "2026-06-15T09:00:00.000Z",
        durationMinutes: 22,
        intensity: "moderate",
        note: "felt solid"
      });
      const adHoc = completeExerciseSession(db, {
        completedAt: "2026-06-16T12:00:00.000Z",
        durationMinutes: 10,
        intensity: "low",
        note: "walk"
      });
      const summary = queryExerciseCompletion(db, {
        from: "2026-06-15",
        to: "2026-06-22"
      });

      expect(completed.session).toMatchObject({
        id: plan.sessions[0]!.id,
        status: "completed",
        completedAt: "2026-06-15T09:00:00.000Z",
        durationMinutes: 22,
        intensity: "moderate"
      });
      expect(adHoc.session).toMatchObject({ status: "ad_hoc", completedAt: "2026-06-16T12:00:00.000Z" });
      expect(summary).toMatchObject({
        planned: 2,
        completed: 1,
        missed: 1,
        rate: 0.5
      });
      expect(summary.sessions).toMatchObject([{ status: "completed" }, { status: "missed" }]);
      expect(summary.adHocSessions).toMatchObject([{ id: adHoc.session.id, status: "ad_hoc" }]);
    } finally {
      db.close();
    }
  });

  test("rejects completing planned sessions before their scheduled date without mutating the row", () => {
    const db = migratedDb();

    try {
      createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [{ sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 }]
      });
      const plan = createExercisePlanFromTemplate(db, {
        templateSlug: "starter-strength",
        weekStart: "2026-06-15"
      });

      expect(() =>
        completeExerciseSession(db, {
          sessionId: plan.sessions[0]!.id,
          completedAt: "2026-06-14T23:59:59.000Z",
          durationMinutes: 20,
          intensity: "moderate"
        })
      ).toThrow("completedAt cannot be before scheduledFor");

      expect(getExerciseSessionById(db, plan.sessions[0]!.id)).toMatchObject({
        id: plan.sessions[0]!.id,
        status: "planned"
      });
      expect(getExerciseSessionById(db, plan.sessions[0]!.id)?.completedAt).toBeUndefined();
      const summary = queryExerciseCompletion(db, {
        from: "2026-06-15",
        to: "2026-06-16"
      });
      expect(summary).toMatchObject({
        planned: 1,
        completed: 0,
        missed: 1,
        rate: 0,
        sessions: [{ id: plan.sessions[0]!.id, status: "missed" }]
      });
      expect(summary.sessions[0]?.completedAt).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("preserves planned session fields when completion omits optional fields", () => {
    const db = migratedDb();

    try {
      createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [{ sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 }]
      });
      const plan = createExercisePlanFromTemplate(db, {
        templateSlug: "starter-strength",
        weekStart: "2026-06-15"
      });

      const result = completeExerciseSession(db, {
        sessionId: plan.sessions[0]!.id,
        completedAt: "2026-06-15T09:00:00.000Z"
      });

      expect(result.session).toMatchObject({
        id: plan.sessions[0]!.id,
        status: "completed",
        templateSessionKey: "push",
        scheduledFor: "2026-06-15T00:00:00.000Z",
        completedAt: "2026-06-15T09:00:00.000Z",
        durationMinutes: 20
      });
    } finally {
      db.close();
    }
  });

  test("completes a planned session by plan id and template session key", () => {
    const db = migratedDb();

    try {
      createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [
          { sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 },
          { sessionKey: "pull", dayOffset: 2, title: "Pull", targetReps: 30 }
        ]
      });
      const plan = createExercisePlanFromTemplate(db, {
        templateSlug: "starter-strength",
        weekStart: "2026-06-15"
      });

      const result = completeExerciseSession(db, {
        planId: plan.plan.id,
        templateSessionKey: "pull",
        completedAt: "2026-06-17T09:00:00.000Z",
        intensity: "high"
      } as Parameters<typeof completeExerciseSession>[1]);

      expect(result.session).toMatchObject({
        id: plan.sessions[1]!.id,
        planId: plan.plan.id,
        templateSessionKey: "pull",
        scheduledFor: "2026-06-17T00:00:00.000Z",
        completedAt: "2026-06-17T09:00:00.000Z",
        status: "completed",
        intensity: "high"
      });
      expect(getExerciseSessionById(db, plan.sessions[0]!.id)).toMatchObject({ status: "planned" });
      expect(tableCount(db, "exercise_sessions")).toBe(2);
    } finally {
      db.close();
    }
  });

  test("rejects incomplete or mixed completion target modes before mutation", () => {
    const db = migratedDb();

    try {
      createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [{ sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 }]
      });
      const plan = createExercisePlanFromTemplate(db, {
        templateSlug: "starter-strength",
        weekStart: "2026-06-15"
      });
      const invalidTargets: readonly Parameters<typeof completeExerciseSession>[1][] = [
        {
          planId: plan.plan.id,
          completedAt: "2026-06-15T09:00:00.000Z"
        } as Parameters<typeof completeExerciseSession>[1],
        {
          templateSessionKey: "push",
          completedAt: "2026-06-15T09:00:00.000Z"
        } as Parameters<typeof completeExerciseSession>[1],
        {
          sessionId: plan.sessions[0]!.id,
          planId: plan.plan.id,
          completedAt: "2026-06-15T09:00:00.000Z"
        } as Parameters<typeof completeExerciseSession>[1],
        {
          sessionId: plan.sessions[0]!.id,
          templateSessionKey: "push",
          completedAt: "2026-06-15T09:00:00.000Z"
        } as Parameters<typeof completeExerciseSession>[1]
      ];

      for (const input of invalidTargets) {
        expect(() => completeExerciseSession(db, input)).toThrow("completion target must be sessionId, planId with templateSessionKey, or omitted");
      }
      expect(getExerciseSessionById(db, plan.sessions[0]!.id)).toMatchObject({ status: "planned" });
      expect(tableCount(db, "exercise_sessions")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("rejects missing plan/template completion targets without writing ad hoc rows", () => {
    const db = migratedDb();

    try {
      createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [{ sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 }]
      });
      const plan = createExercisePlanFromTemplate(db, {
        templateSlug: "starter-strength",
        weekStart: "2026-06-15"
      });

      expect(() =>
        completeExerciseSession(db, {
          planId: plan.plan.id,
          templateSessionKey: "pull",
          completedAt: "2026-06-17T09:00:00.000Z"
        } as Parameters<typeof completeExerciseSession>[1])
      ).toThrow("planned exercise session not found");
      expect(getExerciseSessionById(db, plan.sessions[0]!.id)).toMatchObject({ status: "planned" });
      expect(tableCount(db, "exercise_sessions")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("preserves previous completion metadata when re-completion omits optional fields", () => {
    const db = migratedDb();

    try {
      createExerciseTemplate(db, {
        slug: "starter-strength",
        name: "Starter Strength",
        defaultDays: [{ sessionKey: "push", dayOffset: 0, title: "Push", targetMinutes: 20 }]
      });
      const plan = createExercisePlanFromTemplate(db, {
        templateSlug: "starter-strength",
        weekStart: "2026-06-15"
      });

      completeExerciseSession(db, {
        sessionId: plan.sessions[0]!.id,
        completedAt: "2026-06-15T09:00:00.000Z",
        durationMinutes: 25,
        intensity: "high",
        note: "first completion"
      });
      const recompleted = completeExerciseSession(db, {
        sessionId: plan.sessions[0]!.id,
        completedAt: "2026-06-15T10:00:00.000Z"
      });

      expect(recompleted.session).toMatchObject({
        id: plan.sessions[0]!.id,
        status: "completed",
        templateSessionKey: "push",
        scheduledFor: "2026-06-15T00:00:00.000Z",
        completedAt: "2026-06-15T10:00:00.000Z",
        durationMinutes: 25,
        intensity: "high",
        note: "first completion"
      });
    } finally {
      db.close();
    }
  });

  test("validates completion inputs before writing session rows", () => {
    const db = migratedDb();

    try {
      expect(() =>
        completeExerciseSession(db, {
          completedAt: "2026-06-16T12:00:00.000Z",
          durationMinutes: 0,
          intensity: "low"
        })
      ).toThrow("durationMinutes must be a positive integer");
      expect(() =>
        completeExerciseSession(db, {
          completedAt: "2026-06-16T12:00:00.000Z",
          durationMinutes: 10,
          intensity: "extreme" as "low"
        })
      ).toThrow("intensity must be low, moderate, or high");
      expect(tableCount(db, "exercise_sessions")).toBe(0);
    } finally {
      db.close();
    }
  });
});

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function tableCount(db: Database.Database, tableName: "exercise_plans" | "exercise_sessions" | "exercise_templates"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}
