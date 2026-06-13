import { describe, expect, test } from "vitest";

import { MasteryReportRenderError, renderScholarMasteryReportBody } from "./mastery-report.js";

describe("scholar mastery report renderer", () => {
  test("renders a valid API success body with source date and diagnosis counts", () => {
    const body = renderScholarMasteryReportBody(
      {
        ok: true,
        routeId: "mastery.summary",
        data: {
          masteryRows: [
            masteryRow("alpha", "Alpha Concept", 0.91),
            masteryRow("beta", "Beta Concept", 0.22)
          ],
          diagnosis: {
            runId: "diagnose-20260613",
            weakSpots: [weakSpot("beta", "Beta Concept", 0.22)]
          }
        }
      },
      { date: "2026-06-13", sourceEndpointLabel: "GET /api/mastery/summary" }
    );

    expect(body).toContain("Date: 2026-06-13");
    expect(body).toContain("Source: GET /api/mastery/summary");
    expect(body).toContain("Mastery rows: 2");
    expect(body).toContain("Weak spots: 1");
    expect(body).toContain("Top weak spot: beta (score 0.22)");
    expect(body).toContain("Diagnosis run: diagnose-20260613");
    expect(body).toContain("Boundary: renderer only; no API call, no Multica call, no live M2 proof.");
  });

  test("rejects direct mastery summary data without the API success wrapper", () => {
    expect(() =>
      renderScholarMasteryReportBody(
        {
          masteryRows: [masteryRow("gamma", "Gamma Concept", 0.45)],
          diagnosis: {
            runId: "direct-run",
            weakSpots: [weakSpot("gamma", "Gamma Concept", 0.45)]
          }
        },
        { date: "2026-06-13" }
      )
    ).toThrow(/mastery.summary success body/);
  });

  test("renders deterministic empty rows and weak spots", () => {
    const body = renderScholarMasteryReportBody(
      {
        ok: true,
        routeId: "mastery.summary",
        data: {
          masteryRows: [],
          diagnosis: {
            weakSpots: []
          }
        }
      },
      { date: "2026-06-13" }
    );

    expect(body).toContain("Mastery rows: 0");
    expect(body).toContain("Weak spots: 0");
    expect(body).toContain("Top weak spot: none");
    expect(body).toContain("Diagnosis run: none");
    expect(body).toContain("Rows: none");
  });

  test("throws a typed error for malformed mastery summary bodies", () => {
    expect(() => renderScholarMasteryReportBody({ ok: true, routeId: "plan.today", data: {} }, { date: "2026-06-13" }))
      .toThrow(MasteryReportRenderError);
    expect(() =>
      renderScholarMasteryReportBody(successBody([{ conceptSlug: "alpha" }]), { date: "2026-06-13" })
    ).toThrow(/masteryRows\[0\]\.conceptName/);
    expect(() => renderScholarMasteryReportBody({ masteryRows: [], diagnosis: {} }, { date: "" })).toThrow(
      /context.date/
    );
  });

  test("redacts bearer headers paths and query secrets from report values", () => {
    const body = renderScholarMasteryReportBody(
      {
        ok: true,
        routeId: "mastery.summary",
        data: {
          masteryRows: [
            masteryRow("alpha?token=real-token", "Authorization: Bearer real-bearer", 0.2),
            masteryRow("G:\\vault\\secret.md", "http://example.test/concept?api_key=real-key", 0.3)
          ],
          diagnosis: {
            runId: "file:///G:/vault/run.json?api_key=real-key",
            weakSpots: [weakSpot("alpha?token=real-token", "Authorization: Bearer real-bearer", 0.2)]
          }
        }
      },
      {
        date: "2026-06-13",
        sourceEndpointLabel: "GET https://user:real-password@local/api/mastery/summary?token=real-token"
      }
    );

    expect(body).toContain("https://REDACTED:REDACTED@local/api/mastery/summary?token=REDACTED");
    expect(body).toContain("token=REDACTED");
    expect(body).toContain("Authorization: Bearer REDACTED");
    expect(body).toContain("PATH_REDACTED");
    expect(body).toContain("api_key=REDACTED");
    expect(body).not.toContain("real-token");
    expect(body).not.toContain("real-password");
    expect(body).not.toContain("real-bearer");
    expect(body).not.toContain("real-key");
    expect(body).not.toContain("G:\\vault");
    expect(body).not.toContain("/home/holly");
  });

  test("redacts URL credentials and sensitive path segments from all report strings", () => {
    const body = renderScholarMasteryReportBody(
      {
        ok: true,
        routeId: "mastery.summary",
        data: {
          masteryRows: [
            masteryRow(
              "https://user:slug-password@example.test/concepts/token/slug-token",
              "https://user:name-password@example.test/concepts/secret/name-secret",
              0.2
            )
          ],
          diagnosis: {
            runId: "https://user:run-password@example.test/runs/session/run-session",
            weakSpots: [
              weakSpot("https://user:weak-password@example.test/concepts/auth/weak-auth", "Weak Concept", 0.2)
            ]
          }
        }
      },
      {
        date: "2026-06-13",
        sourceEndpointLabel: "GET https://user:source-password@local/api/mastery/summary/token/source-token"
      }
    );

    expect(body).toContain("https://REDACTED:REDACTED@example.test/concepts/token/REDACTED");
    expect(body).toContain("https://REDACTED:REDACTED@example.test/concepts/secret/REDACTED");
    expect(body).toContain("https://REDACTED:REDACTED@example.test/runs/session/REDACTED");
    expect(body).toContain("https://REDACTED:REDACTED@local/api/mastery/summary/token/REDACTED");
    expect(body).not.toContain("slug-password");
    expect(body).not.toContain("slug-token");
    expect(body).not.toContain("name-password");
    expect(body).not.toContain("name-secret");
    expect(body).not.toContain("run-password");
    expect(body).not.toContain("run-session");
    expect(body).not.toContain("weak-password");
    expect(body).not.toContain("weak-auth");
    expect(body).not.toContain("source-password");
    expect(body).not.toContain("source-token");
  });

  test("rejects mastery rows with out-of-range scores confidence or attempts", () => {
    expect(() => renderScholarMasteryReportBody(successBody([masteryRow("low", "Low", -0.01)]), { date: "2026-06-13" }))
      .toThrow(/score/);
    expect(() =>
      renderScholarMasteryReportBody(
        successBody([{ ...masteryRow("high-confidence", "High Confidence", 0.5), confidence: 1.01 }]),
        { date: "2026-06-13" }
      )
    ).toThrow(/confidence/);
    expect(() =>
      renderScholarMasteryReportBody(
        successBody([{ ...masteryRow("negative-attempts", "Negative Attempts", 0.5), attemptsN: -1 }]),
        { date: "2026-06-13" }
      )
    ).toThrow(/attemptsN/);
  });
});

function successBody(masteryRows: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    ok: true,
    routeId: "mastery.summary",
    data: {
      masteryRows,
      diagnosis: {
        weakSpots: []
      }
    }
  };
}

function masteryRow(conceptSlug: string, conceptName: string, score: number): Record<string, unknown> {
  return {
    conceptSlug,
    conceptName,
    score,
    confidence: 0.5,
    attemptsN: 2,
    lastSeenAt: "2026-06-12T08:00:00.000Z"
  };
}

function weakSpot(conceptSlug: string, conceptName: string, score: number): Record<string, unknown> {
  return {
    conceptSlug,
    conceptName,
    score,
    confidence: 0.5,
    attemptsN: 2,
    lastSeenAt: "2026-06-12T08:00:00.000Z",
    reasons: [],
    recommendation: "Review"
  };
}
