import type { AgentDryRunPlan, AgentEndpointPlan, AgentIntendedAction } from "./dry-run.js";
import { redactEndpointReference, redactText } from "./http-clients.js";

export type AgentExecutionMode = "dry-run" | "live";
export type AgentExecutionStatus = "planned" | "completed" | "blocked";

export type ExecutableAgentPlan = AgentDryRunPlan;

export interface AgentReadResult {
  readonly endpoint: AgentEndpointPlan;
  readonly status: number;
  readonly body: unknown;
}

export interface AgentPublishResult {
  readonly action: AgentIntendedAction;
  readonly id: string;
  readonly url?: string;
}

export interface AgentPublishFailure {
  readonly action: AgentIntendedAction;
  readonly message: string;
}

export interface AgentExecutionResult {
  readonly mode: AgentExecutionMode;
  readonly status: AgentExecutionStatus;
  readonly reads: readonly AgentReadResult[];
  readonly publishedActions: readonly AgentPublishResult[];
  readonly publishFailures: readonly AgentPublishFailure[];
  readonly blocker?: AgentIntendedAction;
}

export interface AgentReadClient {
  read(endpoint: AgentEndpointPlan): Promise<AgentReadResult>;
}

export interface AgentBoardClient {
  publish(action: AgentIntendedAction): Promise<AgentPublishResult>;
}

export interface AgentExecutionClients {
  readonly readClient?: AgentReadClient;
  readonly boardClient?: AgentBoardClient;
}

export async function executeAgentPlan(
  plan: ExecutableAgentPlan,
  mode: AgentExecutionMode,
  clients: AgentExecutionClients = {}
): Promise<AgentExecutionResult> {
  if (mode === "dry-run") {
    return {
      mode,
      status: "planned",
      reads: [],
      publishedActions: [],
      publishFailures: []
    };
  }

  const readClient = requireClient(clients.readClient, "readClient");
  const boardClient = requireClient(clients.boardClient, "boardClient");
  const reads: AgentReadResult[] = [];

  for (const endpoint of plan.externalReads) {
    try {
      reads.push(await readClient.read(endpoint));
    } catch (error) {
      const blocker = createAgentBlockerAction(plan, endpoint, error);
      let publishedBlocker: AgentPublishResult | undefined;
      let publishFailure: AgentPublishFailure | undefined;
      try {
        publishedBlocker = await boardClient.publish(blocker);
      } catch (publishError) {
        publishFailure = createPublishFailure(blocker, publishError, "Agent blocker publish failed");
      }

      return {
        mode,
        status: "blocked",
        reads,
        publishedActions: publishedBlocker === undefined ? [] : [publishedBlocker],
        publishFailures: publishFailure === undefined ? [] : [publishFailure],
        blocker
      };
    }
  }

  const publishedActions: AgentPublishResult[] = [];
  for (const action of plan.intendedActions) {
    try {
      publishedActions.push(await boardClient.publish(action));
    } catch (error) {
      return {
        mode,
        status: "blocked",
        reads,
        publishedActions,
        publishFailures: [createPublishFailure(action, error, "Agent action publish failed")]
      };
    }
  }

  return {
    mode,
    status: "completed",
    reads,
    publishedActions,
    publishFailures: []
  };
}

function createPublishFailure(
  action: AgentIntendedAction,
  error: unknown,
  prefix: "Agent action publish failed" | "Agent blocker publish failed"
): AgentPublishFailure {
  return {
    action: redactedAction(action),
    message: `${prefix}: ${redactText(errorMessage(error))}`
  };
}

function redactedAction(action: AgentIntendedAction): AgentIntendedAction {
  return {
    target: action.target,
    type: action.type,
    title: redactText(action.title),
    body: redactText(action.body),
    checklist: action.checklist.map((item) => redactText(item)),
    sourceEndpoints: action.sourceEndpoints.map((endpoint) => redactEndpointReference(endpoint))
  };
}

export function createAgentBlockerAction(
  plan: AgentDryRunPlan,
  endpoint: AgentEndpointPlan,
  error: unknown
): AgentIntendedAction {
  const message = redactText(error instanceof Error ? error.message : String(error));
  const sourceEndpoint = redactEndpointReference(`${endpoint.method} ${endpoint.url}`);

  return {
    target: "multica",
    type: "add_comment",
    title: `Agent blocked for ${plan.date}`,
    body: [
      `Dry-run board target: ${plan.multicaBoard}.`,
      `Failed read: ${sourceEndpoint}`,
      `Reason: ${message}`,
      "The agent stopped before publishing normal actions."
    ].join("\n"),
    checklist: ["Inspect source endpoint", "Restore the source system", "Rerun the agent after the blocker is resolved"],
    sourceEndpoints: [sourceEndpoint]
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireClient<T>(client: T | undefined, name: string): T {
  if (client === undefined) {
    throw new Error(`Agent live execution requires ${name}.`);
  }

  return client;
}
