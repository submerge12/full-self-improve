import { executeAgentDay, type AgentDayRunReport } from "./day-runner.js";
import type {
  AgentDayDryRunPlan,
  AgentDryRunPlan,
  AgentEndpointPlan,
  AgentIntendedAction,
  AgentPhase,
  AgentRole
} from "./dry-run.js";
import type { AgentBoardClient, AgentPublishResult, AgentReadClient } from "./executor.js";
import { redactEndpointReference, redactText } from "./http-clients.js";

export interface AgentFailureSmokeEndpointSelector {
  readonly role?: AgentRole;
  readonly phase?: AgentPhase;
  readonly method?: AgentEndpointPlan["method"];
  readonly urlIncludes?: string;
}

export interface AgentFailureSmokeInput {
  readonly plan: AgentDayDryRunPlan;
  readonly failedEndpoint?: AgentFailureSmokeEndpointSelector;
  readonly simulatedError?: Error;
}

export interface AgentFailureSmokeFailedEndpoint {
  readonly role: AgentRole;
  readonly phase: AgentPhase;
  readonly method: AgentEndpointPlan["method"];
  readonly url: string;
  readonly purpose: string;
}

export interface AgentFailureSmokeReport {
  readonly mode: "offline-failure-smoke";
  readonly date: string;
  readonly status: AgentDayRunReport["status"];
  readonly failedEndpoint: AgentFailureSmokeFailedEndpoint;
  readonly blockerPublished: boolean;
  readonly blocker?: AgentIntendedAction;
  readonly blockerTitle?: string;
  readonly blockerBody?: string;
  readonly blockerSourceEndpoints: readonly string[];
  readonly publishedActions: readonly AgentIntendedAction[];
  readonly dayRunReport: AgentDayRunReport;
  readonly totals: AgentDayRunReport["totals"];
  readonly fakeClientEvents: readonly string[];
  readonly nonCompletionNotice: string;
}

interface MatchedEndpoint {
  readonly plan: AgentDryRunPlan;
  readonly endpoint: AgentEndpointPlan;
}

const DEFAULT_SELECTOR: Required<AgentFailureSmokeEndpointSelector> = {
  role: "scholar",
  phase: "morning-plan",
  method: "GET",
  urlIncludes: "/api/plan/today"
};

const DEFAULT_SIMULATED_ERROR = new Error("Simulated source endpoint failure for offline failure smoke.");

const NON_COMPLETION_NOTICE = [
  "This offline failure smoke does not kill real API services.",
  "It does not call Multica.",
  "It does not prove live blocker behavior.",
  "It does not close M2."
].join(" ");

export async function createAgentFailureSmokeReport(
  input: AgentFailureSmokeInput
): Promise<AgentFailureSmokeReport> {
  const selector = input.failedEndpoint ?? DEFAULT_SELECTOR;
  const matched = selectEndpoint(input.plan, selector);
  const failedEndpointKey = endpointKey(matched.endpoint);
  const fakeEvents: string[] = [];
  const simulatedError = input.simulatedError ?? DEFAULT_SIMULATED_ERROR;
  const boardClient = createFakeBoardClient(fakeEvents);

  const dayRunReport = sanitizeDayRunReport(
    await executeAgentDay(input.plan, "live", {
      readClient: createFakeReadClient(failedEndpointKey, simulatedError, fakeEvents),
      boardClient
    })
  );
  const blocker = dayRunReport.blockers[0];

  return {
    mode: "offline-failure-smoke",
    date: input.plan.date,
    status: dayRunReport.status,
    failedEndpoint: {
      role: matched.plan.role,
      phase: matched.plan.phase,
      method: matched.endpoint.method,
      url: redactEndpointUrl(matched.endpoint.url),
      purpose: redactText(matched.endpoint.purpose)
    },
    blockerPublished: dayRunReport.publishedActions.some((publish) => publish.action.title === blocker?.title),
    ...(blocker === undefined ? {} : { blocker, blockerTitle: blocker.title, blockerBody: blocker.body }),
    blockerSourceEndpoints: blocker?.sourceEndpoints ?? [],
    publishedActions: dayRunReport.publishedActions.map((publish) => publish.action),
    dayRunReport,
    totals: dayRunReport.totals,
    fakeClientEvents: fakeEvents.map((event) => redactText(event)),
    nonCompletionNotice: NON_COMPLETION_NOTICE
  };
}

function createFakeReadClient(failedEndpointKey: string, simulatedError: Error, events: string[]): AgentReadClient {
  return {
    async read(endpoint) {
      events.push(`read:${redactEndpointReference(endpointKey(endpoint))}`);
      if (endpointKey(endpoint) === failedEndpointKey) {
        throw simulatedError;
      }

      return {
        endpoint: sanitizeEndpoint(endpoint),
        status: 200,
        body: { ok: true }
      };
    }
  };
}

function createFakeBoardClient(events: string[]): AgentBoardClient {
  const publishedActions: AgentIntendedAction[] = [];

  return {
    async publish(action): Promise<AgentPublishResult> {
      const redactedAction = sanitizeAction(action);
      publishedActions.push(redactedAction);
      events.push(`publish:${redactedAction.title}`);

      return {
        action: redactedAction,
        id: `offline-smoke-${publishedActions.length}`
      };
    }
  };
}

function selectEndpoint(
  plan: AgentDayDryRunPlan,
  selector: AgentFailureSmokeEndpointSelector
): MatchedEndpoint {
  for (const agentPlan of plan.sequence) {
    for (const endpoint of agentPlan.externalReads) {
      if (endpointMatches(agentPlan, endpoint, selector)) {
        return { plan: agentPlan, endpoint };
      }
    }
  }

  throw new Error("No endpoint matched failure smoke selector.");
}

function endpointMatches(
  plan: AgentDryRunPlan,
  endpoint: AgentEndpointPlan,
  selector: AgentFailureSmokeEndpointSelector
): boolean {
  return (
    (selector.role === undefined || selector.role === plan.role) &&
    (selector.phase === undefined || selector.phase === plan.phase) &&
    (selector.method === undefined || selector.method === endpoint.method) &&
    (selector.urlIncludes === undefined || endpoint.url.includes(selector.urlIncludes))
  );
}

function sanitizeDayRunReport(report: AgentDayRunReport): AgentDayRunReport {
  return {
    ...report,
    entries: report.entries.map((entry) => ({
      ...entry,
      reads: entry.reads.map((read) => ({ ...read, endpoint: sanitizeEndpoint(read.endpoint) })),
      publishedActions: entry.publishedActions.map((publish) => ({
        ...publish,
        action: sanitizeAction(publish.action)
      })),
      publishFailures: entry.publishFailures.map((failure) => ({
        action: sanitizeAction(failure.action),
        message: redactText(failure.message)
      })),
      ...(entry.blocker === undefined ? {} : { blocker: sanitizeAction(entry.blocker) })
    })),
    reads: report.reads.map((read) => ({ ...read, endpoint: sanitizeEndpoint(read.endpoint) })),
    publishedActions: report.publishedActions.map((publish) => ({ ...publish, action: sanitizeAction(publish.action) })),
    publishFailures: report.publishFailures.map((failure) => ({
      action: sanitizeAction(failure.action),
      message: redactText(failure.message)
    })),
    blockers: report.blockers.map((blocker) => sanitizeAction(blocker))
  };
}

function sanitizeEndpoint(endpoint: AgentEndpointPlan): AgentEndpointPlan {
  return {
    method: endpoint.method,
    url: redactEndpointUrl(endpoint.url),
    purpose: redactText(endpoint.purpose)
  };
}

function sanitizeAction(action: AgentIntendedAction): AgentIntendedAction {
  return {
    target: action.target,
    type: action.type,
    title: redactText(action.title),
    body: redactText(action.body),
    checklist: action.checklist.map((item) => redactText(item)),
    sourceEndpoints: action.sourceEndpoints.map((endpoint) => redactEndpointReference(endpoint))
  };
}

function endpointKey(endpoint: AgentEndpointPlan): string {
  return `${endpoint.method} ${endpoint.url}`;
}

function redactEndpointUrl(url: string): string {
  const redacted = redactEndpointReference(url);
  return redacted.replace(/^[A-Z]+\s+/u, "");
}
