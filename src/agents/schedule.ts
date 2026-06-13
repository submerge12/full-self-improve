import type { AgentDayDryRunPlan } from "./dry-run.js";

export interface AgentScheduleTimingInput {
  readonly now: string;
  readonly timezone: string;
  readonly dailyAt: string;
}

export interface AgentScheduleTiming {
  readonly timezone: string;
  readonly dailyAt: string;
  readonly now: string;
  readonly due: boolean;
  readonly date: string;
  readonly window: {
    readonly startsAt: string;
    readonly endsBefore: string;
  };
}

export interface AgentScheduleArgvOptions {
  readonly configPath?: string;
  readonly knowledgeLoopBaseUrl?: string;
  readonly compassHealthBaseUrl?: string;
  readonly adapterId?: string;
  readonly multicaBoard?: string;
}

export interface AgentScheduleReportInput {
  readonly timing: AgentScheduleTiming;
  readonly plan: AgentDayDryRunPlan;
  readonly argvOptions?: AgentScheduleArgvOptions;
}

export interface AgentScheduleDryRunReport extends AgentScheduleTiming {
  readonly wouldRun: {
    readonly command: "agent-day";
    readonly mode: "dry-run";
    readonly argv: readonly string[];
  };
  readonly plan: AgentDayDryRunPlan;
}

interface LocalDateTimeParts {
  readonly date: string;
  readonly hour: number;
  readonly minute: number;
}

interface DailyAtParts {
  readonly hour: number;
  readonly minute: number;
  readonly minutes: number;
}

export function createAgentScheduleTiming(input: AgentScheduleTimingInput): AgentScheduleTiming {
  const dailyAt = parseDailyAt(input.dailyAt);
  const now = parseNow(input.now);
  assertTimeZone(input.timezone);
  const local = localDateTimeParts(now, input.timezone);
  const date = local.date;

  return {
    timezone: input.timezone,
    dailyAt: input.dailyAt,
    now: input.now,
    due: local.hour * 60 + local.minute >= dailyAt.minutes,
    date,
    window: {
      startsAt: zonedTimestamp(date, dailyAt, input.timezone),
      endsBefore: zonedTimestamp(addDays(date, 1), dailyAt, input.timezone)
    }
  };
}

export function createAgentScheduleReport(input: AgentScheduleReportInput): AgentScheduleDryRunReport {
  return {
    ...input.timing,
    wouldRun: {
      command: "agent-day",
      mode: "dry-run",
      argv: agentDayDryRunArgv(input.plan.date, input.argvOptions)
    },
    plan: input.plan
  };
}

function agentDayDryRunArgv(date: string, options: AgentScheduleArgvOptions | undefined): string[] {
  const argv = ["agent-day", "--dry-run", "--date", date];
  pushOptional(argv, "--config", options?.configPath);
  pushOptional(argv, "--knowledge-loop-url", options?.knowledgeLoopBaseUrl);
  pushOptional(argv, "--compass-health-url", options?.compassHealthBaseUrl);
  pushOptional(argv, "--adapter", options?.adapterId);
  pushOptional(argv, "--board", options?.multicaBoard);

  return argv;
}

function pushOptional(argv: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) {
    argv.push(flag, value);
  }
}

function parseDailyAt(value: string): DailyAtParts {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (match === null) {
    throw new Error(`Invalid agent schedule --daily-at "${value}". Expected HH:mm.`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return {
    hour,
    minute,
    minutes: hour * 60 + minute
  };
}

function parseNow(value: string): Date {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (match === null) {
    throw new Error(`Agent schedule --now must be a valid ISO timestamp with an explicit offset.`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Agent schedule --now must be a valid ISO timestamp with an explicit offset.`);
  }
  assertValidCalendarDateTime(match);

  return parsed;
}

function assertTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid agent schedule timezone "${timezone}".`);
  }
}

function localDateTimeParts(value: Date, timezone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";

  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
    minute: Number(part("minute"))
  };
}

function zonedTimestamp(date: string, dailyAt: DailyAtParts, timezone: string): string {
  return `${date}T${pad2(dailyAt.hour)}:${pad2(dailyAt.minute)}:00${offsetForLocalTime(date, dailyAt, timezone)}`;
}

function offsetForLocalTime(date: string, dailyAt: DailyAtParts, timezone: string): string {
  const targetParts = dateParts(date);
  const targetUtcMillis = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day, dailyAt.hour, dailyAt.minute);
  let instantMillis = targetUtcMillis;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offsetMillis = localUtcMillis(localDateTimeParts(new Date(instantMillis), timezone)) - instantMillis;
    instantMillis = targetUtcMillis - offsetMillis;
  }

  const offsetMillis = localUtcMillis(localDateTimeParts(new Date(instantMillis), timezone)) - instantMillis;
  return formatOffset(offsetMillis);
}

function assertValidCalendarDateTime(match: RegExpExecArray): void {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const asUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day ||
    asUtc.getUTCHours() !== hour ||
    asUtc.getUTCMinutes() !== minute ||
    asUtc.getUTCSeconds() !== second
  ) {
    throw new Error(`Agent schedule --now must be a valid ISO timestamp with an explicit offset.`);
  }
}

function localUtcMillis(parts: LocalDateTimeParts): number {
  const parsed = dateParts(parts.date);
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day, parts.hour, parts.minute);
}

function dateParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return {
    year: year ?? 0,
    month: month ?? 0,
    day: day ?? 0
  };
}

function formatOffset(offsetMillis: number): string {
  if (offsetMillis === 0) {
    return "Z";
  }

  const sign = offsetMillis < 0 ? "-" : "+";
  const totalMinutes = Math.abs(Math.round(offsetMillis / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);

  return parsed.toISOString().slice(0, 10);
}
