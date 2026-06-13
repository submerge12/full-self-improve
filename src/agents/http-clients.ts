import type { AgentEndpointPlan, AgentIntendedAction } from "./dry-run.js";
import type { AgentBoardClient, AgentPublishResult, AgentReadClient, AgentReadResult } from "./executor.js";

export type AgentFetch = typeof fetch;

export interface FetchAgentReadClientOptions {
  readonly fetch: AgentFetch;
  readonly bearerToken?: string;
}

export interface HttpBoardClientOptions {
  readonly fetch: AgentFetch;
  readonly boardId: string;
  readonly bearerToken?: string;
  readonly createTaskEndpointUrl?: string;
  readonly addCommentEndpointUrl?: string;
}

export class AgentHttpError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AgentHttpError";
    this.status = status;
  }
}

export function createFetchAgentReadClient(options: FetchAgentReadClientOptions): AgentReadClient {
  return {
    async read(endpoint) {
      return readEndpoint(endpoint, options);
    }
  };
}

export function createHttpBoardClient(options: HttpBoardClientOptions): AgentBoardClient {
  return {
    async publish(action) {
      return publishAction(action, options);
    }
  };
}

export function redactEndpointReference(value: string, secrets: readonly string[] = []): string {
  const match = /^([A-Z]+)\s+(.+)$/u.exec(value);
  if (match) {
    return `${match[1]} ${redactUrl(match[2] ?? "", secrets)}`;
  }

  return redactUrl(value, secrets);
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("REDACTED");
    }
  }

  redacted = redacted.replace(
    /\b(authorization\s*[:=]\s*)(bearer\s+)?[^\s;,]+/giu,
    (_, prefix: string, bearer: string | undefined) => `${prefix}${bearer ?? ""}REDACTED`
  );
  redacted = redacted.replace(/\b(cookie\s*[:=]\s*)[^\r\n]*/giu, "$1REDACTED");
  redacted = redacted.replace(
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|auth|session|sid)\s*[:=]\s*)[^\s;,)&]+/giu,
    "$1REDACTED"
  );

  return redacted.replace(
    /([?&][^=\s&]*(?:token|key|secret|authorization|auth|cookie)[^=\s&]*=)[^\s&]+/giu,
    "$1REDACTED"
  );
}

async function readEndpoint(
  endpoint: AgentEndpointPlan,
  options: FetchAgentReadClientOptions
): Promise<AgentReadResult> {
  const secrets = secretsFrom(options.bearerToken);
  const context = `${endpoint.method} ${redactUrl(endpoint.url, secrets)}`;
  let response: Response;

  try {
    response = await options.fetch(endpoint.url, {
      method: endpoint.method,
      headers: headersFor(options.bearerToken)
    });
  } catch (error) {
    throw new AgentHttpError(
      `Agent HTTP read failed: ${context} threw ${redactText(errorMessage(error), secrets)}`
    );
  }

  if (!response.ok) {
    throw new AgentHttpError(
      `Agent HTTP read failed: ${context} returned ${response.status}${statusText(response, secrets)}`,
      response.status
    );
  }

  try {
    const body = await parseResponseBody(response);
    if (isJsonResponse(response) && !isRecord(body)) {
      throw new Error("expected JSON object");
    }

    return {
      endpoint,
      status: response.status,
      body
    };
  } catch (error) {
    throw new AgentHttpError(
      `Agent HTTP read failed: ${context} returned invalid JSON (${redactText(errorMessage(error), secrets)})`,
      response.status
    );
  }
}

async function publishAction(
  action: AgentIntendedAction,
  options: HttpBoardClientOptions
): Promise<AgentPublishResult> {
  const endpointUrl = endpointUrlFor(action, options);
  const secrets = secretsFrom(options.bearerToken);
  let response: Response;

  try {
    response = await options.fetch(endpointUrl, {
      method: "POST",
      headers: headersFor(options.bearerToken, "json"),
      body: JSON.stringify(payloadFor(action, options, secrets))
    });
  } catch (error) {
    throw new AgentHttpError(
      `Agent board publish failed: POST ${redactUrl(endpointUrl, secrets)} threw ${redactText(
        errorMessage(error),
        secrets
      )}`
    );
  }

  if (!response.ok) {
    throw new AgentHttpError(
      `Agent board publish failed: POST ${redactUrl(endpointUrl, secrets)} returned ${response.status}${statusText(
        response,
        secrets
      )}`,
      response.status
    );
  }

  const body = await parseBoardResponse(response, endpointUrl, secrets);
  const id = body.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AgentHttpError(
      `Agent board publish failed: POST ${redactUrl(endpointUrl, secrets)} response missing string id`,
      response.status
    );
  }

  const url = body.url;
  return typeof url === "string" ? { action, id, url } : { action, id };
}

function endpointUrlFor(action: AgentIntendedAction, options: HttpBoardClientOptions): string {
  const endpointUrl = action.type === "create_task" ? options.createTaskEndpointUrl : options.addCommentEndpointUrl;
  if (endpointUrl === undefined) {
    throw new AgentHttpError(`No endpoint configured for Multica action type ${action.type}.`);
  }

  assertHttpUrl(endpointUrl);
  return endpointUrl;
}

function payloadFor(
  action: AgentIntendedAction,
  options: HttpBoardClientOptions,
  secrets: readonly string[]
): Record<string, unknown> {
  return {
    boardId: options.boardId,
    target: action.target,
    type: action.type,
    title: redactText(action.title, secrets),
    body: redactText(action.body, secrets),
    checklist: action.checklist.map((item) => redactText(item, secrets)),
    sourceEndpoints: action.sourceEndpoints.map((endpoint) => redactEndpointReference(endpoint, secrets))
  };
}

async function parseBoardResponse(
  response: Response,
  endpointUrl: string,
  secrets: readonly string[]
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await parseResponseBody(response);
  } catch (error) {
    throw new AgentHttpError(
      `Agent board publish failed: POST ${redactUrl(endpointUrl, secrets)} returned invalid JSON (${redactText(
        errorMessage(error),
        secrets
      )})`,
      response.status
    );
  }

  if (isRecord(body)) {
    return body;
  }

  throw new AgentHttpError(
    `Agent board publish failed: POST ${redactUrl(endpointUrl, secrets)} response must be a JSON object`,
    response.status
  );
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }

  if (isJsonResponse(response)) {
    return JSON.parse(text);
  }

  return text;
}

function headersFor(bearerToken: string | undefined, bodyKind?: "json"): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json"
  };
  if (bodyKind === "json") {
    headers["Content-Type"] = "application/json";
  }
  if (bearerToken !== undefined && bearerToken.length > 0) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  return headers;
}

function redactUrl(value: string, secrets: readonly string[] = []): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveQueryKey(key)) {
        url.searchParams.set(key, "REDACTED");
      }
    }

    return redactText(url.toString(), secrets);
  } catch {
    return redactText(value, secrets);
  }
}

function assertHttpUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return;
    }
  } catch {
    // Fall through to the uniform error below.
  }

  throw new AgentHttpError("Multica board endpoint must be an http or https URL.");
}

function isSensitiveQueryKey(value: string): boolean {
  return /token|key|secret|authorization|auth|cookie/iu.test(value);
}

function isJsonResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

function statusText(response: Response, secrets: readonly string[]): string {
  return response.statusText.length > 0 ? ` ${redactText(response.statusText, secrets)}` : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function secretsFrom(value: string | undefined): readonly string[] {
  return value === undefined ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
