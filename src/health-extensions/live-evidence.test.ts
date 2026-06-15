import { describe, expect, test } from "vitest";

import { validateM4LiveReviewEvidence, validateWindowsLoggerLiveEvidence } from "./live-evidence.js";

const validEvidence = {
  contractStatus: "observed_live_alert_pending_review",
  evidenceMode: "live-observation",
  date: "2026-06-14",
  logger: {
    loggerId: "knowledge-loop-windows",
    startupObserved: true,
    startupCommand:
      'schtasks /Create /TN knowledge-loop-health-windows-logger /SC ONLOGON /TR "npm exec tsx scripts/health-windows-logger.ts -- --config config/health/windows-logger.example.json" /F',
    sleepWakeSurvived: true,
    version: "health-windows-logger/0.1.0"
  },
  sedentaryStreak: {
    windowStart: "2026-06-14T08:00:00.000Z",
    windowEnd: "2026-06-14T09:05:00.000Z",
    durationMinutes: 65,
    source: "windows-logger:knowledge-loop-windows"
  },
  breakReminder: {
    eligibleAt: "2026-06-14T09:00:00.000Z",
    recordedAt: "2026-06-14T09:03:00.000Z",
    deliveryChannel: "windows-notification",
    visibleAlertObserved: true
  }
};

describe("Windows logger live evidence validation", () => {
  test("accepts valid live observation evidence and returns the gate summary", () => {
    const result = validateWindowsLoggerLiveEvidence(validEvidence);

    expect(result).toEqual({
      errors: [],
      warnings: [],
      summary: {
        longestSedentaryMinutes: 65,
        reminderDelayMinutes: 3,
        liveGate: "windows_logger_alert_observed"
      }
    });
  });

  test("requires startup, sleep/wake survival, and visible alert evidence", () => {
    const result = validateWindowsLoggerLiveEvidence({
      ...validEvidence,
      logger: {
        ...validEvidence.logger,
        startupObserved: false,
        sleepWakeSurvived: false
      },
      breakReminder: {
        ...validEvidence.breakReminder,
        visibleAlertObserved: false
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("logger.startupObserved must be true for the live gate");
    expect(result.errors).toContain("logger.sleepWakeSurvived must be true for the live gate");
    expect(result.errors).toContain("breakReminder.visibleAlertObserved must be true for the live gate");
  });

  test("rejects sedentary streaks shorter than sixty minutes", () => {
    const result = validateWindowsLoggerLiveEvidence({
      ...validEvidence,
      sedentaryStreak: {
        ...validEvidence.sedentaryStreak,
        durationMinutes: 59
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("sedentaryStreak.durationMinutes must be at least 60");
  });

  test("requires the sedentary source to reference the repo-owned logger id", () => {
    const result = validateWindowsLoggerLiveEvidence({
      ...validEvidence,
      sedentaryStreak: {
        ...validEvidence.sedentaryStreak,
        source: "windows-logger:other-host"
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("sedentaryStreak.source must reference logger.loggerId");
  });

  test("rejects reminders recorded more than five minutes after eligibility", () => {
    const result = validateWindowsLoggerLiveEvidence({
      ...validEvidence,
      breakReminder: {
        ...validEvidence.breakReminder,
        recordedAt: "2026-06-14T09:06:00.000Z"
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("breakReminder.recordedAt must be within 5 minutes of eligibleAt");
  });

  test("rejects fake closure fields anywhere in the evidence object", () => {
    const result = validateWindowsLoggerLiveEvidence({
      ...validEvidence,
      m4Complete: true,
      logger: {
        ...validEvidence.logger,
        done: true
      },
      breakReminder: {
        ...validEvidence.breakReminder,
        closed: true
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("fake closure field m4Complete is not accepted");
    expect(result.errors).toContain("fake closure field logger.done is not accepted");
    expect(result.errors).toContain("fake closure field breakReminder.closed is not accepted");
  });

  test("rejects secret-like values without echoing the secret value", () => {
    const secretValue = "Bearer sk-live-secret-token-1234567890";
    const result = validateWindowsLoggerLiveEvidence({
      ...validEvidence,
      breakReminder: {
        ...validEvidence.breakReminder,
        deliveryChannel: secretValue
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("secret-like value detected at breakReminder.deliveryChannel");
    expect(result.errors.join("\n")).not.toContain(secretValue);
    expect(result.errors.join("\n")).not.toContain("sk-live-secret-token-1234567890");
  });

  test("rejects filesystem paths into frozen repositories while allowing relative repo paths", () => {
    const result = validateWindowsLoggerLiveEvidence({
      ...validEvidence,
      logger: {
        ...validEvidence.logger,
        startupCommand:
          'schtasks /Create /TN knowledge-loop-health-windows-logger /SC ONLOGON /TR "npm exec tsx G:\\compass-health\\scripts\\health-windows-logger.ts -- --config C:\\Users\\Holly\\compass-health\\config\\health\\windows-logger.example.json" /F'
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("frozen repository filesystem path detected at logger.startupCommand");

    const piHarnessResult = validateWindowsLoggerLiveEvidence({
      ...validEvidence,
      logger: {
        ...validEvidence.logger,
        startupCommand:
          'schtasks /Create /TN knowledge-loop-health-windows-logger /SC ONLOGON /TR "npm exec tsx G:\\pi-harness\\scripts\\health-windows-logger.ts -- --config G:\\multica-ai-multica-https-github-com\\config\\health\\windows-logger.example.json" /F'
      }
    });

    expect(piHarnessResult.summary).toBeUndefined();
    expect(piHarnessResult.errors).toContain("frozen repository filesystem path detected at logger.startupCommand");
  });
});

const validM4Evidence = {
  contractStatus: "m4_live_review_pending_verification",
  evidenceMode: "live-review",
  windowsLogger: validEvidence,
  coachDigest: {
    date: "2026-06-14",
    snapshotId: 1,
    boardUrl: "http://127.0.0.1:8080/issues/health-digest-1",
    publishedAt: "2026-06-14T20:00:00.000Z"
  },
  compassHealthHashProof: {
    algorithm: "sha256",
    collectedOutsideHealthExtensions: true,
    before: {
      date: "2026-06-14",
      hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    afterOneWeek: {
      date: "2026-06-21",
      hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
};

describe("M4 live review evidence validation", () => {
  test("accepts pending live review evidence without claiming M4 closure", () => {
    const result = validateM4LiveReviewEvidence(validM4Evidence);

    expect(result).toEqual({
      errors: [],
      warnings: [],
      summary: {
        contractStatus: "m4_live_review_pending_verification",
        evidenceMode: "live-review",
        liveGate: "m4_live_review_pending_verification"
      }
    });
  });

  test("requires embedded valid Windows logger live alert evidence", () => {
    const result = validateM4LiveReviewEvidence({
      ...validM4Evidence,
      windowsLogger: {
        ...validEvidence,
        breakReminder: {
          ...validEvidence.breakReminder,
          visibleAlertObserved: false
        }
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain(
      "windowsLogger.breakReminder.visibleAlertObserved must be true for the live gate"
    );
  });

  test("requires Coach digest board URL or board id proof", () => {
    const missingBoardProof = validateM4LiveReviewEvidence({
      ...validM4Evidence,
      coachDigest: {
        date: "2026-06-14",
        snapshotId: 1,
        publishedAt: "2026-06-14T20:00:00.000Z"
      }
    });

    expect(missingBoardProof.summary).toBeUndefined();
    expect(missingBoardProof.errors).toContain("coachDigest must include boardUrl or boardId");

    const fileBoardUrl = validateM4LiveReviewEvidence({
      ...validM4Evidence,
      coachDigest: {
        ...validM4Evidence.coachDigest,
        boardUrl: "file:///G:/knowledge-loop/health-digest-1"
      }
    });

    expect(fileBoardUrl.summary).toBeUndefined();
    expect(fileBoardUrl.errors).toContain("coachDigest.boardUrl must be an HTTP(S) URL");

    const boardIdProof = validateM4LiveReviewEvidence({
      ...validM4Evidence,
      coachDigest: {
        date: "2026-06-14",
        snapshotId: 1,
        boardId: "health-digest-1",
        publishedAt: "2026-06-14T20:00:00.000Z"
      }
    });

    expect(boardIdProof.errors).toEqual([]);
    expect(boardIdProof.summary?.liveGate).toBe("m4_live_review_pending_verification");
  });

  test("rejects filesystem-looking Coach digest board ids", () => {
    const result = validateM4LiveReviewEvidence({
      ...validM4Evidence,
      coachDigest: {
        date: "2026-06-14",
        snapshotId: 1,
        boardId: "C:\\Users\\Holly\\private-board.txt",
        publishedAt: "2026-06-14T20:00:00.000Z"
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("coachDigest.boardId must be an ordinary board id");
  });

  test("requires matching sha256 compass-health hashes at least seven days apart", () => {
    const result = validateM4LiveReviewEvidence({
      ...validM4Evidence,
      compassHealthHashProof: {
        algorithm: "sha512",
        collectedOutsideHealthExtensions: false,
        before: {
          date: "2026-06-14",
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        afterOneWeek: {
          date: "2026-06-20",
          hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("compassHealthHashProof.algorithm must be sha256");
    expect(result.errors).toContain("compassHealthHashProof.collectedOutsideHealthExtensions must be true");
    expect(result.errors).toContain("compassHealthHashProof.before.hash must match afterOneWeek.hash");
    expect(result.errors).toContain("compassHealthHashProof dates must be at least seven days apart");
  });

  test("rejects secrets, filesystem paths, and fake closure fields in M4 evidence", () => {
    const result = validateM4LiveReviewEvidence({
      ...validM4Evidence,
      m4Closed: true,
      coachDigest: {
        ...validM4Evidence.coachDigest,
        boardId: "token=abcdef1234567890"
      },
      compassHealthHashProof: {
        ...validM4Evidence.compassHealthHashProof,
        before: {
          ...validM4Evidence.compassHealthHashProof.before,
          hash: "G:\\compass-health\\knowledge-loop.db"
        }
      }
    });

    expect(result.summary).toBeUndefined();
    expect(result.errors).toContain("fake closure field m4Closed is not accepted");
    expect(result.errors).toContain("secret-like value detected at coachDigest.boardId");
    expect(result.errors).toContain("frozen repository filesystem path detected at compassHealthHashProof.before.hash");
  });
});
