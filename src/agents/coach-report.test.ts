import { describe, expect, test } from "vitest";

import { CoachReportRenderError, renderCoachHealthDigestBody } from "./coach-report.js";

describe("coach health digest renderer", () => {
  test("renders a valid coach digest success body with source date and markdown", () => {
    const body = renderCoachHealthDigestBody(
      successBody("# Coach daily health digest\n\n- Availability: available"),
      {
        date: "2026-06-15",
        sourceEndpointLabel: "POST /api/health/coach-digest/generate"
      }
    );

    expect(body).toContain("Date: 2026-06-15");
    expect(body).toContain("Source: POST /api/health/coach-digest/generate");
    expect(body).toContain("Coach daily health digest");
    expect(body).toContain("- Availability: available");
  });

  test("throws a typed error for wrong routeId", () => {
    expect(() =>
      renderCoachHealthDigestBody(
        {
          ok: true,
          routeId: "mastery.summary",
          data: {
            result: {
              renderedMarkdown: "# Coach daily health digest"
            }
          }
        },
        { date: "2026-06-15" }
      )
    ).toThrow(/health\.coach-digest\.generate success body/);
  });

  test("throws for API bodies where ok is not true", () => {
    expect(() =>
      renderCoachHealthDigestBody(
        {
          ok: false,
          routeId: "health.coach-digest.generate",
          data: {
            result: {
              renderedMarkdown: "# Coach daily health digest"
            }
          }
        },
        { date: "2026-06-15" }
      )
    ).toThrow(/success body/);
  });

  test("throws for missing or blank renderedMarkdown", () => {
    expect(() =>
      renderCoachHealthDigestBody(
        {
          ok: true,
          routeId: "health.coach-digest.generate",
          data: {
            result: {}
          }
        },
        { date: "2026-06-15" }
      )
    ).toThrow(/renderedMarkdown/);

    expect(() => renderCoachHealthDigestBody(successBody("   "), { date: "2026-06-15" })).toThrow(
      /renderedMarkdown/
    );
  });

  test("throws for blank dates", () => {
    expect(() => renderCoachHealthDigestBody(successBody("# Coach daily health digest"), { date: " " })).toThrow(
      /context.date/
    );
  });

  test("throws for non-object bodies", () => {
    expect(() => renderCoachHealthDigestBody(null, { date: "2026-06-15" })).toThrow(/summaryBody/);
    expect(() => renderCoachHealthDigestBody([], { date: "2026-06-15" })).toThrow(/summaryBody/);
    expect(() => renderCoachHealthDigestBody("not an object", { date: "2026-06-15" })).toThrow(/summaryBody/);
  });

  test("throws for secret-like text in digest body without echoing the secret", () => {
    const secret = "real-bearer-token";

    expect(() =>
      renderCoachHealthDigestBody(successBody(`# Coach daily health digest\nAuthorization: Bearer ${secret}`), {
        date: "2026-06-15"
      })
    ).toThrow(/secret-like text/);

    try {
      renderCoachHealthDigestBody(successBody(`# Coach daily health digest\nAuthorization: Bearer ${secret}`), {
        date: "2026-06-15"
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CoachReportRenderError);
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret);
    }
  });

  test("throws for credential URLs with malformed path encoding without echoing credentials", () => {
    const password = "url-password";
    const renderedMarkdown = `# Coach daily health digest\nhttps://user:${password}@example.test/api/%E0%A4%A/token/value`;

    expect(() => renderCoachHealthDigestBody(successBody(renderedMarkdown), { date: "2026-06-15" })).toThrow(
      CoachReportRenderError
    );

    try {
      renderCoachHealthDigestBody(successBody(renderedMarkdown), { date: "2026-06-15" });
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(password);
    }
  });
});

function successBody(renderedMarkdown: string): Record<string, unknown> {
  return {
    ok: true,
    routeId: "health.coach-digest.generate",
    data: {
      result: {
        renderedMarkdown
      }
    }
  };
}
