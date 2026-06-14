export const AGENT_ROLES = ["librarian", "scholar", "nutritionist"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_PHASES = ["nightly-ingest", "morning-plan", "evening-mastery", "daily-meals"] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

export type AgentActionType = "create_task" | "add_comment";

export interface AgentDryRunInput {
  readonly role: AgentRole;
  readonly phase?: AgentPhase;
  readonly date: string;
  readonly knowledgeLoopBaseUrl?: string;
  readonly compassHealthBaseUrl?: string;
  readonly nutritionistMealReadUrlTemplate?: string;
  readonly adapterId?: string;
  readonly multicaBoard?: string;
}

export interface AgentDayDryRunInput {
  readonly date: string;
  readonly knowledgeLoopBaseUrl?: string;
  readonly compassHealthBaseUrl?: string;
  readonly nutritionistMealReadUrlTemplate?: string;
  readonly adapterId?: string;
  readonly multicaBoard?: string;
}

export interface AgentEndpointPlan {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly purpose: string;
  readonly jsonBody?: Record<string, unknown>;
}

export interface AgentIntendedAction {
  readonly target: "multica";
  readonly type: AgentActionType;
  readonly title: string;
  readonly body: string;
  readonly checklist: readonly string[];
  readonly sourceEndpoints: readonly string[];
}

export interface AgentDryRunPlan {
  readonly mode: "dry-run";
  readonly role: AgentRole;
  readonly phase: AgentPhase;
  readonly date: string;
  readonly multicaBoard: string;
  readonly externalReads: readonly AgentEndpointPlan[];
  readonly externalWrites: readonly [];
  readonly intendedActions: readonly AgentIntendedAction[];
  readonly llmCost: {
    readonly estimatedUsd: number;
    readonly source: "dry-run-no-llm";
  };
}

export interface AgentDayDryRunPlan {
  readonly mode: "dry-run";
  readonly date: string;
  readonly multicaBoard: string;
  readonly sequence: readonly AgentDryRunPlan[];
  readonly externalReads: readonly AgentEndpointPlan[];
  readonly externalWrites: readonly [];
  readonly intendedActions: readonly AgentIntendedAction[];
  readonly llmCost: {
    readonly estimatedUsd: number;
    readonly source: "dry-run-no-llm";
  };
}

const DEFAULT_KNOWLEDGE_LOOP_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_COMPASS_HEALTH_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_NUTRITIONIST_MEAL_READ_URL_TEMPLATE = "/api/meal-plan/today?date={date}";
const DEFAULT_ADAPTER_ID = "holly-vault";
const DEFAULT_MULTICA_BOARD = "daily-plan";

const ROLE_PHASES = {
  librarian: ["nightly-ingest"],
  scholar: ["morning-plan", "evening-mastery"],
  nutritionist: ["daily-meals"]
} as const satisfies Record<AgentRole, readonly AgentPhase[]>;

export function createAgentDryRunPlan(input: AgentDryRunInput): AgentDryRunPlan {
  assertDate(input.date);
  const phase = normalizePhase(input.role, input.phase);
  const multicaBoard = input.multicaBoard ?? DEFAULT_MULTICA_BOARD;

  return {
    mode: "dry-run",
    role: input.role,
    phase,
    date: input.date,
    multicaBoard,
    externalReads: externalReadsFor(input, phase),
    externalWrites: [],
    intendedActions: intendedActionsFor(input, phase, multicaBoard),
    llmCost: {
      estimatedUsd: 0,
      source: "dry-run-no-llm"
    }
  };
}

export function createAgentDayDryRunPlan(input: AgentDayDryRunInput): AgentDayDryRunPlan {
  assertDate(input.date);
  const multicaBoard = input.multicaBoard ?? DEFAULT_MULTICA_BOARD;
  const baseInput = {
    date: input.date,
    ...(input.knowledgeLoopBaseUrl === undefined ? {} : { knowledgeLoopBaseUrl: input.knowledgeLoopBaseUrl }),
    ...(input.compassHealthBaseUrl === undefined ? {} : { compassHealthBaseUrl: input.compassHealthBaseUrl }),
    ...(input.nutritionistMealReadUrlTemplate === undefined
      ? {}
      : { nutritionistMealReadUrlTemplate: input.nutritionistMealReadUrlTemplate }),
    ...(input.adapterId === undefined ? {} : { adapterId: input.adapterId }),
    multicaBoard
  };
  const sequence = [
    createAgentDryRunPlan({ ...baseInput, role: "librarian", phase: "nightly-ingest" }),
    createAgentDryRunPlan({ ...baseInput, role: "scholar", phase: "morning-plan" }),
    createAgentDryRunPlan({ ...baseInput, role: "nutritionist", phase: "daily-meals" }),
    createAgentDryRunPlan({ ...baseInput, role: "scholar", phase: "evening-mastery" })
  ];

  return {
    mode: "dry-run",
    date: input.date,
    multicaBoard,
    sequence,
    externalReads: sequence.flatMap((plan) => plan.externalReads),
    externalWrites: [],
    intendedActions: sequence.flatMap((plan) => plan.intendedActions),
    llmCost: {
      estimatedUsd: sequence.reduce((total, plan) => total + plan.llmCost.estimatedUsd, 0),
      source: "dry-run-no-llm"
    }
  };
}

export function parseAgentRole(value: string): AgentRole {
  if ((AGENT_ROLES as readonly string[]).includes(value)) {
    return value as AgentRole;
  }

  throw new Error(`Invalid agent role "${value}". Expected one of: ${AGENT_ROLES.join(", ")}.`);
}

export function parseAgentPhase(value: string): AgentPhase {
  if ((AGENT_PHASES as readonly string[]).includes(value)) {
    return value as AgentPhase;
  }

  throw new Error(`Invalid agent phase "${value}". Expected one of: ${AGENT_PHASES.join(", ")}.`);
}

function normalizePhase(role: AgentRole, phase: AgentPhase | undefined): AgentPhase {
  const allowed: readonly AgentPhase[] = ROLE_PHASES[role];
  const resolved = phase ?? allowed[0];
  if (!allowed.includes(resolved)) {
    throw new Error(`Agent role ${role} cannot run phase ${resolved}. Expected one of: ${allowed.join(", ")}.`);
  }

  return resolved;
}

function externalReadsFor(input: AgentDryRunInput, phase: AgentPhase): AgentEndpointPlan[] {
  const knowledgeLoopBaseUrl = trimTrailingSlash(input.knowledgeLoopBaseUrl ?? DEFAULT_KNOWLEDGE_LOOP_BASE_URL);
  const compassHealthBaseUrl = trimTrailingSlash(input.compassHealthBaseUrl ?? DEFAULT_COMPASS_HEALTH_BASE_URL);
  const adapterId = encodeURIComponent(input.adapterId ?? DEFAULT_ADAPTER_ID);

  if (phase === "nightly-ingest") {
    return [
      {
        method: "POST",
        url: `${knowledgeLoopBaseUrl}/api/ingest/run?adapter=${adapterId}`,
        purpose: "Run incremental knowledge ingest and collect source/chunk/concept/page counts."
      }
    ];
  }

  if (phase === "morning-plan") {
    return [
      {
        method: "GET",
        url: `${knowledgeLoopBaseUrl}/api/plan/today`,
        purpose: "Fetch or create today's learning queue for the Scholar task checklist."
      }
    ];
  }

  if (phase === "evening-mastery") {
    return [
      {
        method: "GET",
        url: `${knowledgeLoopBaseUrl}/api/mastery/summary`,
        purpose: "Fetch mastery rows and weak spots for the evening Scholar report."
      }
    ];
  }

  return [
    {
      method: "GET",
      url: nutritionistMealReadUrlFor({
        compassHealthBaseUrl,
        template: input.nutritionistMealReadUrlTemplate ?? DEFAULT_NUTRITIONIST_MEAL_READ_URL_TEMPLATE,
        date: input.date
      }),
      purpose: "Fetch today's meals through the existing compass-health API."
    },
    {
      method: "POST",
      url: `${compassHealthBaseUrl}/api/meal-engine/procurement`,
      purpose: "Fetch today's shopping/procurement list through the existing compass-health API.",
      jsonBody: { start_date: input.date }
    }
  ];
}

function nutritionistMealReadUrlFor(input: {
  readonly compassHealthBaseUrl: string;
  readonly template: string;
  readonly date: string;
}): string {
  if (!input.template.includes("{date}")) {
    throw new Error("nutritionistMealReadUrlTemplate must include {date}.");
  }
  if (input.template.includes("\\")) {
    throw new Error("nutritionistMealReadUrlTemplate must be an http(s) URL or a root-relative URL path.");
  }

  const resolved = input.template.replaceAll("{date}", encodeURIComponent(input.date));
  if (resolved.startsWith("/")) {
    if (resolved.startsWith("//")) {
      throw new Error("nutritionistMealReadUrlTemplate must be an http(s) URL or a root-relative URL path.");
    }

    return new URL(resolved, `${input.compassHealthBaseUrl}/`).toString();
  }

  try {
    const url = new URL(resolved);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    // Fall through to the uniform error below.
  }

  throw new Error("nutritionistMealReadUrlTemplate must be an http(s) URL or a root-relative URL path.");
}

function intendedActionsFor(
  input: AgentDryRunInput,
  phase: AgentPhase,
  multicaBoard: string
): AgentIntendedAction[] {
  const reads = externalReadsFor(input, phase);
  const sourceEndpoints = reads.map((read) => `${read.method} ${read.url}`);

  if (phase === "nightly-ingest") {
    return [
      {
        target: "multica",
        type: "add_comment",
        title: `Librarian ingest report for ${input.date}`,
        body: [
          `Dry-run target board: ${multicaBoard}.`,
          "When live, Librarian posts sources processed, skipped, failed, chunks, concepts, pages, and run id.",
          "Failures become visible blockers instead of silent logs."
        ].join("\n"),
        checklist: ["Run ingest", "Post count summary", "Link trace/run id", "Escalate source failures"],
        sourceEndpoints
      }
    ];
  }

  if (phase === "morning-plan") {
    return [
      {
        target: "multica",
        type: "create_task",
        title: `Scholar study plan for ${input.date}`,
        body: [
          `Dry-run target board: ${multicaBoard}.`,
          "When live, Scholar creates the daily study task from the plan queue and links back to knowledge-loop."
        ].join("\n"),
        checklist: ["Review learn activities", "Complete quiz activities", "Submit teach-back activities"],
        sourceEndpoints
      }
    ];
  }

  if (phase === "evening-mastery") {
    return [
      {
        target: "multica",
        type: "add_comment",
        title: `Scholar mastery report for ${input.date}`,
        body: [
          `Dry-run target board: ${multicaBoard}.`,
          "When live, Scholar posts mastery deltas, weak spots, and tomorrow's recommended focus."
        ].join("\n"),
        checklist: ["Fetch mastery summary", "Summarize weak spots", "Post evening delta"],
        sourceEndpoints
      }
    ];
  }

  return [
    {
      target: "multica",
      type: "create_task",
      title: `Nutrition plan for ${input.date}`,
      body: [
        `Dry-run target board: ${multicaBoard}.`,
        "When live, Nutritionist turns the existing meal API response into today's meals and shopping checklist."
      ].join("\n"),
      checklist: ["Fetch meals", "Post meal checklist", "Post shopping list"],
      sourceEndpoints
    }
  ];
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid agent date "${value}". Expected YYYY-MM-DD.`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid agent date "${value}". Expected YYYY-MM-DD.`);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
