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
    readonly source: "dry-run-no-llm";
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
    readonly source: "dry-run-no-llm";
    readonly perAgent: ReadonlyArray<{
      readonly role: AgentRole;
      readonly phase: AgentPhase;
      readonly estimatedUsd: number;
      readonly source: "dry-run-no-llm";
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
  clients: AgentExecutionClients = {}
): Promise<AgentDayRunReport> {
  const entries: AgentDayRunEntry[] = [];

  for (const agentPlan of plan.sequence) {
    const result = await executeAgentPlan(agentPlan, mode, clients);
    entries.push(
      entryFor(agentPlan, result.status, result.reads, result.publishedActions, result.publishFailures, result.blocker)
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
    llmCost: {
      estimatedUsd: entries.reduce((total, entry) => total + entry.llmCost.estimatedUsd, 0),
      source: "dry-run-no-llm",
      perAgent: entries.map((entry) => ({
        role: entry.role,
        phase: entry.phase,
        estimatedUsd: entry.llmCost.estimatedUsd,
        source: entry.llmCost.source
      }))
    }
  };
}

function entryFor(
  plan: AgentDryRunPlan,
  status: AgentExecutionStatus,
  reads: readonly AgentReadResult[],
  publishedActions: readonly AgentPublishResult[],
  publishFailures: readonly AgentPublishFailure[],
  blocker: AgentIntendedAction | undefined
): AgentDayRunEntry {
  return {
    role: plan.role,
    phase: plan.phase,
    status,
    reads,
    publishedActions,
    publishFailures,
    ...(blocker === undefined ? {} : { blocker }),
    llmCost: plan.llmCost
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
