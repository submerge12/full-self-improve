import { redactText } from "./http-clients.js";

const COACH_DIGEST_ROUTE_ID = "health.coach-digest.generate";

export class CoachReportRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoachReportRenderError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CoachReportRenderContext {
  readonly date: string;
  readonly sourceEndpointLabel?: string;
}

export function renderCoachHealthDigestBody(summaryBody: unknown, context: CoachReportRenderContext): string {
  const date = requireIsoDate(context.date, "context.date");
  const source = formatSourceEndpointLabel(context.sourceEndpointLabel);
  const renderedMarkdown = parseRenderedMarkdown(summaryBody);
  if (containsSecretLikeText(renderedMarkdown)) {
    throw new CoachReportRenderError("summaryBody.data.result.renderedMarkdown contains secret-like text.");
  }

  return [
    "Coach health digest",
    `Date: ${redactText(date)}`,
    ...(source === undefined ? [] : [`Source: ${source}`]),
    "",
    renderedMarkdown
  ].join("\n");
}

function parseRenderedMarkdown(summaryBody: unknown): string {
  const body = requireRecord(summaryBody, "summaryBody");
  if (body.ok !== true || body.routeId !== COACH_DIGEST_ROUTE_ID) {
    throw new CoachReportRenderError("summaryBody must be a health.coach-digest.generate success body.");
  }

  const data = requireRecord(body.data, "summaryBody.data");
  const result = requireRecord(data.result, "summaryBody.data.result");
  return requireNonEmptyString(result.renderedMarkdown, "summaryBody.data.result.renderedMarkdown");
}

function formatSourceEndpointLabel(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const label = requireNonEmptyString(value, "context.sourceEndpointLabel");
  const match = /^([A-Z]+)\s+(.+)$/u.exec(label);
  if (match) {
    return `${match[1]} ${redactEndpointTarget(match[2] ?? "")}`;
  }

  return redactEndpointTarget(label);
}

function redactEndpointTarget(value: string): string {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return redactRelativeEndpoint(value);
  }

  return redactReportText(value);
}

function redactRelativeEndpoint(value: string): string {
  try {
    const url = new URL(value, "https://knowledge-loop.local");
    redactSensitiveSearchParams(url);
    url.pathname = redactSensitivePathname(url.pathname);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return redactReportText(value);
  }
}

function containsSecretLikeText(value: string): boolean {
  return redactReportText(value) !== value;
}

function redactReportText(value: string): string {
  return redactText(redactEmbeddedUrls(value));
}

function redactEmbeddedUrls(value: string): string {
  return value.replace(/\b(?:https?|file):\/\/[^\s;,)]*/giu, (url) => redactReportUrl(url));
}

function redactReportUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username.length > 0) {
      url.username = "REDACTED";
    }
    if (url.password.length > 0) {
      url.password = "REDACTED";
    }
    url.pathname = redactSensitivePathname(url.pathname);
    redactSensitiveSearchParams(url);
    return url.toString();
  } catch {
    return "URL_REDACTED";
  }
}

function redactSensitiveSearchParams(url: URL): void {
  for (const key of Array.from(url.searchParams.keys())) {
    if (isSensitiveToken(key)) {
      url.searchParams.set(key, "REDACTED");
    }
  }
}

function redactSensitivePathname(pathname: string): string {
  const segments = pathname.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (isSensitiveToken(safeDecodePathSegment(segments[index] ?? "")) && (segments[index + 1]?.length ?? 0) > 0) {
      segments[index + 1] = "REDACTED";
    }
  }

  return segments.join("/");
}

function safeDecodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSensitiveToken(value: string): boolean {
  return /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization|auth|cookie|session|sid|password)$/iu.test(
    value
  );
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoachReportRenderError(`${path} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function requireIsoDate(value: unknown, path: string): string {
  const text = requireNonEmptyString(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (match === null) {
    throw new CoachReportRenderError(`${path} must be an ISO date.`);
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
  if (normalized !== text) {
    throw new CoachReportRenderError(`${path} must be an ISO date.`);
  }

  return text;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CoachReportRenderError(`${path} must be a non-empty string.`);
  }

  return value;
}
