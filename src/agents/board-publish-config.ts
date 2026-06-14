export interface BoardPublishConfigSummary {
  readonly contractStatus: "inferred_live_smoke_pending";
  readonly apiBaseUrl: string;
  readonly appBaseUrl: string;
  readonly workspaceSlug: string;
  readonly actions: readonly ["create_task", "add_comment"];
  readonly commentRequiresIssueId: boolean;
}

export interface BoardPublishConfigValidationResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly summary?: BoardPublishConfigSummary;
}

export const BOARD_PUBLISH_CONFIG_LIVE_CLIENT_WARNING =
  "board publish config is an offline candidate; agent-day --live currently uses explicit endpoint flags and built-in Multica issue/comment payloads rather than reading this config file.";

interface BoardPublishConfig {
  readonly contractStatus: "inferred_live_smoke_pending";
  readonly apiBaseUrl: string;
  readonly appBaseUrl: string;
  readonly workspace: {
    readonly slug: string;
    readonly id: string;
  };
  readonly actions: {
    readonly create_task: {
      readonly method: string;
      readonly endpointUrl: string;
      readonly payload: {
        readonly title?: unknown;
        readonly description?: unknown;
        readonly status?: unknown;
        readonly priority?: unknown;
      };
    };
    readonly add_comment: {
      readonly method: string;
      readonly endpointTemplate: string;
      readonly payload: {
        readonly content?: unknown;
        readonly type?: unknown;
      };
    };
  };
}

export function validateBoardPublishConfig(value: unknown): BoardPublishConfigValidationResult {
  const errors: string[] = [];
  const warnings = [BOARD_PUBLISH_CONFIG_LIVE_CLIENT_WARNING];
  collectUnsafeValues(value, [], errors);
  const config = parseConfig(value, errors);
  if (config === undefined) {
    return { errors, warnings };
  }

  validateContract(config, errors);
  validateActions(config, errors);

  return errors.length === 0
    ? {
        errors,
        warnings,
        summary: {
          contractStatus: config.contractStatus,
          apiBaseUrl: config.apiBaseUrl,
          appBaseUrl: config.appBaseUrl,
          workspaceSlug: config.workspace.slug,
          actions: ["create_task", "add_comment"],
          commentRequiresIssueId: config.actions.add_comment.endpointTemplate.includes("{issueId}")
        }
      }
    : { errors, warnings };
}

function parseConfig(value: unknown, errors: string[]): BoardPublishConfig | undefined {
  if (!isRecord(value)) {
    errors.push("board publish config must be a JSON object.");
    return undefined;
  }
  if (!isRecord(value.workspace)) {
    errors.push("board publish config workspace must be a JSON object.");
    return undefined;
  }
  if (!isRecord(value.actions)) {
    errors.push("board publish config actions must be a JSON object.");
    return undefined;
  }
  if (!isRecord(value.actions.create_task)) {
    errors.push("board publish config actions.create_task must be a JSON object.");
    return undefined;
  }
  if (!isRecord(value.actions.add_comment)) {
    errors.push("board publish config actions.add_comment must be a JSON object.");
    return undefined;
  }

  return value as unknown as BoardPublishConfig;
}

function validateContract(config: BoardPublishConfig, errors: string[]): void {
  if (config.contractStatus !== "inferred_live_smoke_pending") {
    errors.push("board publish config contractStatus must stay inferred_live_smoke_pending until a real smoke passes.");
  }
  validateRequiredString(config.apiBaseUrl, "apiBaseUrl", errors);
  validateRequiredString(config.appBaseUrl, "appBaseUrl", errors);
  validateRequiredString(config.workspace.slug, "workspace.slug", errors);
  validateRequiredString(config.workspace.id, "workspace.id", errors, true);
  validateHttpUrl(config.apiBaseUrl, "apiBaseUrl", errors);
  validateHttpUrl(config.appBaseUrl, "appBaseUrl", errors);
}

function validateActions(config: BoardPublishConfig, errors: string[]): void {
  const createTask = config.actions.create_task;
  const addComment = config.actions.add_comment;

  if (createTask.method !== "POST") {
    errors.push("board publish config actions.create_task.method must be POST.");
  }
  validateRequiredString(createTask.endpointUrl, "actions.create_task.endpointUrl", errors);
  validateHttpUrl(createTask.endpointUrl, "actions.create_task.endpointUrl", errors);
  if (!isRecord(createTask.payload)) {
    errors.push("board publish config actions.create_task.payload must be a JSON object.");
  } else {
    if (createTask.payload.title !== "$action.title") {
      errors.push("board publish config actions.create_task.payload.title must be $action.title.");
    }
    if (createTask.payload.description !== "$action.body") {
      errors.push("board publish config actions.create_task.payload.description must be $action.body.");
    }
    if (createTask.payload.status !== undefined && createTask.payload.status !== "todo") {
      errors.push("board publish config actions.create_task.payload.status must be todo when present.");
    }
    if (
      createTask.payload.priority !== undefined &&
      (typeof createTask.payload.priority !== "string" ||
        !["none", "low", "medium", "high", "urgent"].includes(createTask.payload.priority))
    ) {
      errors.push(
        "board publish config actions.create_task.payload.priority must be one of none, low, medium, high, urgent when present."
      );
    }
  }

  if (addComment.method !== "POST") {
    errors.push("board publish config actions.add_comment.method must be POST.");
  }
  validateRequiredString(addComment.endpointTemplate, "actions.add_comment.endpointTemplate", errors);
  validateHttpUrl(addComment.endpointTemplate, "actions.add_comment.endpointTemplate", errors);
  if (!addComment.endpointTemplate.includes("{issueId}")) {
    errors.push("board publish config actions.add_comment.endpointTemplate must include {issueId}.");
  }
  if (!isRecord(addComment.payload)) {
    errors.push("board publish config actions.add_comment.payload must be a JSON object.");
  } else {
    if (addComment.payload.content !== "$action.body") {
      errors.push("board publish config actions.add_comment.payload.content must be $action.body.");
    }
    if (addComment.payload.type !== undefined && addComment.payload.type !== "comment") {
      errors.push("board publish config actions.add_comment.payload.type must be comment when present.");
    }
  }
}

function validateRequiredString(
  value: unknown,
  path: string,
  errors: string[],
  allowEmpty = false
): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    errors.push(`board publish config ${path} must be a ${allowEmpty ? "string" : "non-empty string"}.`);
  }
}

function validateHttpUrl(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string") {
    return;
  }

  try {
    const url = new URL(value.replace("{issueId}", "placeholder"));
    if (url.username.length > 0 || url.password.length > 0) {
      errors.push(`board publish config ${path} must not include URL credentials.`);
      return;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      return;
    }
  } catch {
    // Fall through to the uniform error below.
  }

  errors.push(`board publish config ${path} must be an http or https URL.`);
}

function collectUnsafeValues(value: unknown, pathParts: readonly string[], errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectUnsafeValues(entry, [...pathParts, String(index)], errors));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (/api[_-]?key|bearer|token|secret|cookie|password|authorization|auth/iu.test(key)) {
        errors.push(`board publish config must not contain secret-like key at ${[...pathParts, key].join(".")}.`);
      }
      collectUnsafeValues(nested, [...pathParts, key], errors);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }

  const location = pathParts.join(".");
  if (isSecretLikeValue(value)) {
    errors.push(`board publish config must not contain secret-like value at ${location}.`);
  }
  if (isFilesystemLikeValue(value)) {
    errors.push(`board publish config must not contain filesystem-like value at ${location}.`);
  }
}

function isSecretLikeValue(value: string): boolean {
  return (
    hasUrlCredentials(value) ||
    /\bauthorization\s*[:=]/iu.test(value) ||
    /\bbearer\s+\S+/iu.test(value) ||
    /\bcookie\s*[:=]/iu.test(value) ||
    /[?&][^=\s&]*(?:token|key|secret|authorization|auth|cookie|session|sid|password)[^=\s&]*=[^\s&]+/iu.test(value) ||
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|auth|session|sid|password|private[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s;,)&]+/iu.test(
      value
    )
  );
}

function isFilesystemLikeValue(value: string): boolean {
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    return value.startsWith("file://") || value.includes("G:/") || value.includes("G:\\");
  }

  return (
    /^[A-Z]:[\\/]/iu.test(value) ||
    /^\\\\/u.test(value) ||
    value.startsWith("/") ||
    value.includes("G:/") ||
    value.includes("G:\\") ||
    /(^|[\\/])\.\.([\\/]|$)/u.test(value)
  );
}

function hasUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value.replace("{issueId}", "placeholder"));
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
