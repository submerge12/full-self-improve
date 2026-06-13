import type { AgentDayDryRunPlan, AgentDryRunPlan, AgentPhase, AgentRole, AgentIntendedAction } from "./dry-run.js";
import {
  executeAgentPlan,
  type AgentExecutionClients,
  type AgentExecutionMode,
  type AgentExecutionStatus,
  type AgentPublishFailure,
  type AgentPublishResult,
  type AgentReadResult
} from "./executor.js";
import { redactText } from "./http-clients.js";

export type AgentLlmCostSource = "dry-run-no-llm" | "not_configured" | "pi-harness-live" | "cost_unavailable" | "mixed";

export interface AgentLlmCostSnapshot {
  readonly estimatedUsd: number;
  readonly source: Exclude<AgentLlmCostSource, "mixed">;
  readonly currency?: "USD";
  readonly detail?: string;
}

export interface AgentCostClient {
  readCost(plan: AgentDryRunPlan): Promise<AgentLlmCostSnapshot>;
}

export interface AgentDayExecutionClients extends AgentExecutionClients {
  readonly costClient?: AgentCostClient;
}

export interface AgentDayRunEntry {
  readonly role: AgentRole;
  readonly phase: AgentPhase;
  readonly status: AgentExecutionStatus;
  readonly reads: readonly AgentReadResult[];
  readonly publishedActions: readonly AgentPublishResult[];
  readonly publishFailures: readonly AgentPublishFailure[];
  readonly blocker?: AgentIntendedAction;
  readonly llmCost: {
    readonly estimatedUsd: number;
    readonly source: Exclude<AgentLlmCostSource, "mixed">;
    readonly currency?: "USD";
    readonly detail?: string;
  };
}

export interface AgentDayRunReport {
  readonly mode: AgentExecutionMode;
  readonly date: string;
  readonly multicaBoard: string;
  readonly status: AgentExecutionStatus;
  readonly entries: readonly AgentDayRunEntry[];
  readonly skipped: readonly AgentDaySkippedEntry[];
  readonly reads: readonly AgentReadResult[];
  readonly publishedActions: readonly AgentPublishResult[];
  readonly publishFailures: readonly AgentPublishFailure[];
  readonly blockers: readonly AgentIntendedAction[];
  readonly totals: {
    readonly reads: number;
    readonly publishedActions: number;
    readonly publishFailures: number;
    readonly blockers: number;
  };
  readonly llmCost: {
    readonly estimatedUsd: number;
    readonly source: AgentLlmCostSource;
    readonly currency?: "USD";
    readonly perAgent: ReadonlyArray<{
      readonly role: AgentRole;
      readonly phase: AgentPhase;
      readonly estimatedUsd: number;
      readonly source: Exclude<AgentLlmCostSource, "mixed">;
      readonly currency?: "USD";
      readonly detail?: string;
    }>;
  };
}

export interface AgentDaySkippedEntry {
  readonly role: AgentRole;
  readonly phase: AgentPhase;
  readonly reason: string;
}

export async function executeAgentDay(
  plan: AgentDayDryRunPlan,
  mode: AgentExecutionMode,
  clients: AgentDayExecutionClients = {}
): Promise<AgentDayRunReport> {
  const entries: AgentDayRunEntry[] = [];

  for (const agentPlan of plan.sequence) {
    const result = await executeAgentPlan(agentPlan, mode, clients);
    const llmCost = await costFor(agentPlan, mode, clients.costClient);
    entries.push(
      entryFor(agentPlan, result.status, result.reads, result.publishedActions, result.publishFailures, result.blocker, llmCost)
    );
  }

  const blockers = entries.flatMap((entry) => (entry.blocker === undefined ? [] : [entry.blocker]));
  const reads = entries.flatMap((entry) => entry.reads);
  const publishedActions = entries.flatMap((entry) => entry.publishedActions);
  const publishFailures = entries.flatMap((entry) => entry.publishFailures);
  const status = statusFor(mode, blockers, publishFailures);

  return {
    mode,
    date: plan.date,
    multicaBoard: plan.multicaBoard,
    status,
    entries,
    skipped: [],
    reads,
    publishedActions,
    publishFailures,
    blockers,
    totals: {
      reads: reads.length,
      publishedActions: publishedActions.length,
      publishFailures: publishFailures.length,
      blockers: blockers.length
    },
    llmCost: costReportFor(entries)
  };
}

function costReportFor(entries: readonly AgentDayRunEntry[]): AgentDayRunReport["llmCost"] {
  const perAgent = entries.map((entry) => ({
        role: entry.role,
        phase: entry.phase,
        estimatedUsd: entry.llmCost.estimatedUsd,
        source: entry.llmCost.source,
        ...(entry.llmCost.currency === undefined ? {} : { currency: entry.llmCost.currency }),
        ...(entry.llmCost.detail === undefined ? {} : { detail: entry.llmCost.detail })
      }));
  const sources = new Set(perAgent.map((entry) => entry.source));
  const firstCurrency = perAgent[0]?.currency;
  const singleCurrency =
    firstCurrency !== undefined && perAgent.every((entry) => entry.currency === firstCurrency) ? firstCurrency : undefined;

  return {
    estimatedUsd: roundCost(perAgent.reduce((total, entry) => total + entry.estimatedUsd, 0)),
    source: sources.size === 1 ? perAgent[0]?.source ?? "not_configured" : "mixed",
    perAgent,
    ...(singleCurrency === undefined ? {} : { currency: singleCurrency })
  };
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function entryFor(
  plan: AgentDryRunPlan,
  status: AgentExecutionStatus,
  reads: readonly AgentReadResult[],
  publishedActions: readonly AgentPublishResult[],
  publishFailures: readonly AgentPublishFailure[],
  blocker: AgentIntendedAction | undefined,
  llmCost: AgentLlmCostSnapshot
): AgentDayRunEntry {
  return {
    role: plan.role,
    phase: plan.phase,
    status,
    reads,
    publishedActions,
    publishFailures,
    ...(blocker === undefined ? {} : { blocker }),
    llmCost
  };
}

async function costFor(
  plan: AgentDryRunPlan,
  mode: AgentExecutionMode,
  costClient: AgentCostClient | undefined
): Promise<AgentLlmCostSnapshot> {
  if (mode === "dry-run") {
    return plan.llmCost;
  }

  if (costClient === undefined) {
    return {
      estimatedUsd: 0,
      source: "not_configured",
      currency: "USD",
      detail: "No pi-harness cost snapshot client is configured for this run."
    };
  }

  try {
    return redactedCostSnapshot(await costClient.readCost(plan));
  } catch (error) {
    return {
      estimatedUsd: 0,
      source: "cost_unavailable",
      currency: "USD",
      detail: `Cost snapshot unavailable: ${redactText(error instanceof Error ? error.message : String(error))}`
    };
  }
}

function redactedCostSnapshot(snapshot: AgentLlmCostSnapshot): AgentLlmCostSnapshot {
  return {
    estimatedUsd: snapshot.estimatedUsd,
    source: snapshot.source,
    ...(snapshot.currency === undefined ? {} : { currency: snapshot.currency }),
    ...(snapshot.detail === undefined ? {} : { detail: redactText(snapshot.detail) })
  };
}

function statusFor(
  mode: AgentExecutionMode,
  blockers: readonly AgentIntendedAction[],
  publishFailures: readonly AgentPublishFailure[]
): AgentExecutionStatus {
  if (mode === "dry-run") {
    return "planned";
  }

  return blockers.length === 0 && publishFailures.length === 0 ? "completed" : "blocked";
}
