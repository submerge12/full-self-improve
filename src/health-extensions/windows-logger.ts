import { assertIsoInstant, assertSafeText, type SedentaryState } from "./schema.js";
import type { WindowsLoggerHeartbeatKind } from "./windows-logger-contract.js";

export interface WindowsLoggerConfig {
  readonly loggerId: string;
  readonly pollIntervalMs: number;
  readonly idleThresholdMs: number;
  readonly sleepWakeGapMs: number;
  readonly heartbeatIntervalMs: number;
  readonly healthApiBaseUrl: string;
  readonly bearerToken?: string;
  readonly visibleAlert: {
    readonly channel: "stdout" | "powershell";
    readonly title: string;
  };
}

export interface IdleState {
  readonly now: string;
  readonly idleMs: number;
}

export type IdleStateReader = () => MaybePromise<IdleState>;

export interface IdleStateProvider {
  readonly read: IdleStateReader;
}

export interface VisibleAlertPayload {
  readonly title: string;
  readonly body: string;
}

export type VisibleAlertShow = (alert: VisibleAlertPayload) => MaybePromise<void>;

export interface VisibleAlertClient {
  readonly show: VisibleAlertShow;
}

export interface WindowsLoggerSpanPostInput {
  readonly sourceId: string;
  readonly spanStart: string;
  readonly spanEnd: string;
  readonly state: SedentaryState;
  readonly confidence?: number;
  readonly receivedAt?: string;
}

export interface WindowsLoggerHeartbeatPostInput {
  readonly sourceId: string;
  readonly heartbeatAt: string;
  readonly kind: WindowsLoggerHeartbeatKind;
  readonly loggerVersion?: string;
}

export interface WindowsLoggerSpanPostResult {
  readonly reminderEligible: boolean;
  readonly reminderText?: string;
}

export type WindowsLoggerSpanPostFn = (
  input: WindowsLoggerSpanPostInput
) => MaybePromise<WindowsLoggerSpanPostResult>;

export interface WindowsLoggerSpanPoster {
  readonly post: WindowsLoggerSpanPostFn;
}

export type WindowsLoggerHeartbeatPostFn = (input: WindowsLoggerHeartbeatPostInput) => MaybePromise<void>;

export interface WindowsLoggerHeartbeatPoster {
  readonly post: WindowsLoggerHeartbeatPostFn;
}

export interface WindowsHealthLogger {
  readonly tick: () => Promise<void>;
  readonly start: WindowsLoggerAsyncVoid;
  readonly stop: WindowsLoggerAsyncVoid;
}

export type WindowsLoggerAsyncVoid = () => Promise<void>;

export interface WindowsLoggerFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json?: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
}

export type WindowsLoggerFetch = (url: string, init?: RequestInit) => Promise<WindowsLoggerFetchResponse>;

export interface WindowsLoggerOutput {
  readonly write: (text: string) => unknown;
}

export interface WindowsHealthLoggerOptions {
  readonly config: WindowsLoggerConfig;
  readonly idleStateProvider: IdleStateProvider;
  readonly spanPoster?: WindowsLoggerSpanPoster | WindowsLoggerSpanPostFn;
  readonly heartbeatPoster?: WindowsLoggerHeartbeatPoster | WindowsLoggerHeartbeatPostFn;
  readonly visibleAlertClient?: VisibleAlertClient;
  readonly now?: () => Date;
  readonly fetch?: WindowsLoggerFetch;
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (timer: unknown) => void;
  readonly stdout?: WindowsLoggerOutput;
  readonly onError?: (error: Error) => void;
}

export interface WindowsLoggerStartupCommandInput {
  readonly scriptPath: string;
  readonly configPath: string;
  readonly taskName?: string;
}

type MaybePromise<T> = T | Promise<T>;

interface LoggerState {
  openIdleSpanStart?: string;
  lastObservedAt?: string;
  lastHeartbeatAt?: string;
  timer?: unknown;
}

const STARTUP_TASK_NAME = "knowledge-loop-health-windows-logger";

export function createWindowsHealthLogger(options: WindowsHealthLoggerOptions): WindowsHealthLogger {
  const config = loadWindowsLoggerConfig(options.config);
  const fetcher = options.fetch ?? defaultFetch;
  const state: LoggerState = {};
  const spanPoster = normalizeSpanPoster(options.spanPoster ?? createDefaultSpanPoster(config, fetcher));
  const heartbeatPoster = normalizeHeartbeatPoster(options.heartbeatPoster ?? createDefaultHeartbeatPoster(config, fetcher));
  const visibleAlertClient = options.visibleAlertClient ?? createDefaultVisibleAlertClient(config, options.stdout);
  const timerStart = options.setInterval ?? defaultSetInterval;
  const timerStop = options.clearInterval ?? defaultClearInterval;
  const tick = async (): Promise<void> => tickLogger(config, options, state, spanPoster, heartbeatPoster, visibleAlertClient);

  return {
    tick,
    start: async () => {
      if (state.timer !== undefined) {
        return;
      }
      state.timer = timerStart(() => runIntervalTick(tick, options.onError), config.pollIntervalMs);
    },
    stop: async () => {
      if (state.timer === undefined) {
        return;
      }
      timerStop(state.timer);
      state.timer = undefined;
    }
  };
}

export function renderWindowsLoggerStartupCommand(input: WindowsLoggerStartupCommandInput): string {
  const scriptPath = assertCommandSegment(input.scriptPath, "scriptPath");
  const configPath = assertCommandSegment(input.configPath, "configPath");
  const taskName = input.taskName === undefined ? STARTUP_TASK_NAME : assertCommandSegment(input.taskName, "taskName");

  return `schtasks /Create /TN ${taskName} /SC ONLOGON /TR "npm exec tsx ${scriptPath} -- --config ${configPath}" /F`;
}

export function loadWindowsLoggerConfig(value: unknown): WindowsLoggerConfig {
  const payload = assertRecord(value, "config");
  const visibleAlert = assertVisibleAlert(payload.visibleAlert);
  const bearerToken = optionalBearerToken(payload.bearerToken);

  return {
    loggerId: assertPayloadText(payload.loggerId, "loggerId"),
    pollIntervalMs: positiveInteger(payload.pollIntervalMs, "pollIntervalMs"),
    idleThresholdMs: positiveInteger(payload.idleThresholdMs, "idleThresholdMs"),
    sleepWakeGapMs: positiveInteger(payload.sleepWakeGapMs, "sleepWakeGapMs"),
    heartbeatIntervalMs: positiveInteger(payload.heartbeatIntervalMs, "heartbeatIntervalMs"),
    healthApiBaseUrl: assertHealthApiBaseUrl(payload.healthApiBaseUrl),
    ...(bearerToken === undefined ? {} : { bearerToken }),
    visibleAlert
  };
}

async function tickLogger(
  config: WindowsLoggerConfig,
  options: WindowsHealthLoggerOptions,
  state: LoggerState,
  spanPoster: WindowsLoggerSpanPoster,
  heartbeatPoster: WindowsLoggerHeartbeatPoster,
  visibleAlertClient: VisibleAlertClient
): Promise<void> {
  const idleState = normalizeIdleState(await options.idleStateProvider.read(), options.now);
  const recoveredAfterGap = await closeForSleepWakeGap(config, state, spanPoster, heartbeatPoster, idleState.now);
  if (!recoveredAfterGap) {
    await postHeartbeatIfDue(config, state, heartbeatPoster, idleState.now);
  }
  await updateIdleSpan(config, state, spanPoster, visibleAlertClient, idleState);
  state.lastObservedAt = idleState.now;
}

async function closeForSleepWakeGap(
  config: WindowsLoggerConfig,
  state: LoggerState,
  spanPoster: WindowsLoggerSpanPoster,
  heartbeatPoster: WindowsLoggerHeartbeatPoster,
  observedAt: string
): Promise<boolean> {
  if (state.lastObservedAt === undefined || elapsedMs(state.lastObservedAt, observedAt) < config.sleepWakeGapMs) {
    return false;
  }
  await closeOpenIdleSpan(config, state, spanPoster, state.lastObservedAt);
  await postHeartbeat(config, state, heartbeatPoster, observedAt, "logger_recovered_after_gap");
  return true;
}

async function updateIdleSpan(
  config: WindowsLoggerConfig,
  state: LoggerState,
  spanPoster: WindowsLoggerSpanPoster,
  visibleAlertClient: VisibleAlertClient,
  idleState: Required<IdleState>
): Promise<void> {
  if (idleState.idleMs >= config.idleThresholdMs) {
    state.openIdleSpanStart ??= instantFromMs(Date.parse(idleState.now) - idleState.idleMs);
    return;
  }
  const result = await closeOpenIdleSpan(config, state, spanPoster, idleState.now);
  if (result?.reminderEligible === true) {
    await visibleAlertClient.show({ title: config.visibleAlert.title, body: alertBodyFor(result) });
  }
}

async function closeOpenIdleSpan(
  config: WindowsLoggerConfig,
  state: LoggerState,
  spanPoster: WindowsLoggerSpanPoster,
  spanEnd: string
): Promise<WindowsLoggerSpanPostResult | undefined> {
  const spanStart = state.openIdleSpanStart;
  state.openIdleSpanStart = undefined;
  if (spanStart === undefined || spanEnd <= spanStart) {
    return undefined;
  }
  return spanPoster.post(createIdleSpan(config.loggerId, spanStart, spanEnd));
}

async function postHeartbeatIfDue(
  config: WindowsLoggerConfig,
  state: LoggerState,
  heartbeatPoster: WindowsLoggerHeartbeatPoster,
  heartbeatAt: string
): Promise<void> {
  if (state.lastHeartbeatAt !== undefined && elapsedMs(state.lastHeartbeatAt, heartbeatAt) < config.heartbeatIntervalMs) {
    return;
  }
  await postHeartbeat(config, state, heartbeatPoster, heartbeatAt, "logger_heartbeat");
}

async function postHeartbeat(
  config: WindowsLoggerConfig,
  state: LoggerState,
  heartbeatPoster: WindowsLoggerHeartbeatPoster,
  heartbeatAt: string,
  kind: WindowsLoggerHeartbeatKind
): Promise<void> {
  await heartbeatPoster.post({ sourceId: config.loggerId, heartbeatAt, kind });
  state.lastHeartbeatAt = heartbeatAt;
}

function createDefaultSpanPoster(config: WindowsLoggerConfig, fetcher: WindowsLoggerFetch): WindowsLoggerSpanPoster {
  return {
    post: async (span) => {
      await postJson(fetcher, endpointUrl(config.healthApiBaseUrl, "/api/health/sedentary/spans"), span, config);
      const result = await postJson(fetcher, endpointUrl(config.healthApiBaseUrl, "/api/health/break-reminders/evaluate"), {
        from: span.spanStart,
        to: span.spanEnd,
        thresholdMinutes: thresholdMinutes(config.idleThresholdMs),
        evaluatedAt: span.spanEnd,
        deliveryChannel: config.visibleAlert.channel
      }, config);
      return reminderResultFromApi(result);
    }
  };
}

function createDefaultHeartbeatPoster(config: WindowsLoggerConfig, fetcher: WindowsLoggerFetch): WindowsLoggerHeartbeatPoster {
  return {
    post: async (heartbeat) => {
      await postJson(fetcher, endpointUrl(config.healthApiBaseUrl, "/api/health/metrics"), heartbeatMetric(heartbeat), config);
    }
  };
}

function createDefaultVisibleAlertClient(config: WindowsLoggerConfig, output?: WindowsLoggerOutput): VisibleAlertClient {
  const stdout = output ?? process.stdout;
  if (config.visibleAlert.channel === "powershell") {
    throw new Error("visibleAlertClient is required for powershell visible alerts");
  }
  return {
    show: ({ body }) => {
      stdout.write(`${singleLine(body)}\n`);
    }
  };
}

async function postJson(
  fetcher: WindowsLoggerFetch,
  url: string,
  body: unknown,
  config: WindowsLoggerConfig
): Promise<unknown> {
  const response = await fetcher(url, {
    method: "POST",
    headers: requestHeaders(config.bearerToken),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Windows logger HTTP post failed with status ${response.status}`);
  }
  return response.json === undefined ? undefined : response.json();
}

function requestHeaders(bearerToken: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` })
  };
}

function reminderResultFromApi(value: unknown): WindowsLoggerSpanPostResult {
  const result = nestedRecord(value, "data", "result");
  const eligible = result?.status === "eligible";
  const reminderText = optionalNestedText(result, "reminder", "reason") ?? optionalTextField(result, "reminderText");
  return {
    reminderEligible: eligible,
    ...(eligible && reminderText !== undefined ? { reminderText } : {})
  };
}

function heartbeatMetric(heartbeat: WindowsLoggerHeartbeatPostInput): Record<string, string | number> {
  const recovered = heartbeat.kind === "logger_recovered_after_gap";
  return {
    metricKey: recovered ? "windows-logger-recovered-after-gap" : "windows-logger-heartbeat",
    metricLabel: recovered ? "Windows logger recovered after gap" : "Windows logger heartbeat",
    value: 1,
    unit: "event",
    observedAt: heartbeat.heartbeatAt,
    note: `sourceId=${heartbeat.sourceId}; kind=${heartbeat.kind}`
  };
}

function normalizeSpanPoster(poster: WindowsLoggerSpanPoster | WindowsLoggerSpanPostFn): WindowsLoggerSpanPoster {
  return typeof poster === "function" ? { post: poster } : poster;
}

function normalizeHeartbeatPoster(
  poster: WindowsLoggerHeartbeatPoster | WindowsLoggerHeartbeatPostFn
): WindowsLoggerHeartbeatPoster {
  return typeof poster === "function" ? { post: poster } : poster;
}

function normalizeIdleState(value: IdleState, now: (() => Date) | undefined): Required<IdleState> {
  if (!Number.isFinite(value.idleMs) || value.idleMs < 0) {
    throw new Error("idleMs must be a non-negative finite number");
  }
  return {
    idleMs: value.idleMs,
    now: assertIsoInstant(value.now ?? (now ?? (() => new Date()))().toISOString(), "now")
  };
}

function createIdleSpan(loggerId: string, spanStart: string, spanEnd: string): WindowsLoggerSpanPostInput {
  return {
    sourceId: `${loggerId}:idle:${spanStart}`,
    spanStart,
    spanEnd,
    state: "idle",
    confidence: 1,
    receivedAt: spanEnd
  };
}

function assertVisibleAlert(value: unknown): WindowsLoggerConfig["visibleAlert"] {
  const payload = assertRecord(value, "visibleAlert");
  if (payload.channel !== "stdout" && payload.channel !== "powershell") {
    throw new Error("visibleAlert.channel must be stdout or powershell");
  }
  return {
    channel: payload.channel,
    title: assertPayloadText(payload.title, "visibleAlert.title")
  };
}

function assertHealthApiBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("healthApiBaseUrl must be an HTTP(S) base URL without credentials");
  }
  return normalizeHealthApiBaseUrl(value);
}

function normalizeHealthApiBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username.length > 0 || url.password.length > 0) {
      throw new Error("invalid base URL");
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("healthApiBaseUrl must be an HTTP(S) base URL without credentials");
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function optionalBearerToken(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("bearerToken must be non-empty");
  }
  return value.trim();
}

function assertPayloadText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be text`);
  }
  return assertSafeText(value, field);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function endpointUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function nestedRecord(value: unknown, firstKey: string, secondKey: string): Record<string, unknown> | undefined {
  const first = isRecord(value) ? value[firstKey] : undefined;
  const second = isRecord(first) ? first[secondKey] : undefined;
  return isRecord(second) ? second : undefined;
}

function optionalNestedText(
  value: Record<string, unknown> | undefined,
  firstKey: string,
  secondKey: string
): string | undefined {
  const first = value?.[firstKey];
  const second = isRecord(first) ? first[secondKey] : undefined;
  return typeof second === "string" && second.trim().length > 0 ? second.trim() : undefined;
}

function optionalTextField(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const text = value?.[field];
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertCommandSegment(value: string, field: string): string {
  const text = assertSafeText(value, field);
  if (text.includes('"')) {
    throw new Error(`${field} must not contain double quotes`);
  }
  return text;
}

function thresholdMinutes(idleThresholdMs: number): number {
  return Math.max(1, Math.ceil(idleThresholdMs / 60_000));
}

function alertBodyFor(result: WindowsLoggerSpanPostResult): string {
  return result.reminderText?.trim() || "Time for a break.";
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function elapsedMs(start: string, end: string): number {
  return Date.parse(end) - Date.parse(start);
}

function instantFromMs(value: number): string {
  return new Date(value).toISOString();
}

function runIntervalTick(tick: () => Promise<void>, onError: ((error: Error) => void) | undefined): void {
  void tick().catch((error: unknown) => {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  });
}

function defaultFetch(url: string, init?: RequestInit): Promise<WindowsLoggerFetchResponse> {
  return globalThis.fetch(url, init);
}

function defaultSetInterval(callback: () => void, intervalMs: number): unknown {
  return globalThis.setInterval(callback, intervalMs);
}

function defaultClearInterval(timer: unknown): void {
  globalThis.clearInterval(timer as ReturnType<typeof globalThis.setInterval>);
}
