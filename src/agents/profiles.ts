import type { AgentPhase, AgentRole } from "./dry-run.js";

export type AgentPolicyCapability = "read-only" | "write" | "destructive" | "network";
export type AgentPolicyDecision = "allow" | "ask" | "deny";

export interface KnowledgeLoopAgentProfile {
  readonly role: AgentRole;
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly supportedPhases: readonly AgentPhase[];
  readonly dryRunCommand: readonly string[];
  readonly policy: {
    readonly defaults: Record<AgentPolicyCapability, AgentPolicyDecision>;
  };
  readonly model: {
    readonly provider: "mock";
    readonly modelId: "dry-run-no-llm";
  };
  readonly context: {
    readonly compactionInstructions: string;
  };
}

const SAFE_POLICY_DEFAULTS = {
  "read-only": "allow",
  write: "deny",
  destructive: "deny",
  network: "ask"
} as const satisfies Record<AgentPolicyCapability, AgentPolicyDecision>;

export const M2_AGENT_PROFILES = [
  createProfile({
    role: "librarian",
    name: "knowledge-loop-librarian",
    description: "Runs the nightly knowledge ingest dry-run profile and reports source-processing blockers.",
    supportedPhases: ["nightly-ingest"],
    systemPrompt: [
      "You are the knowledge-loop Librarian agent.",
      "Use configured HTTP interfaces to trigger ingest and summarize source, chunk, concept, and page counts.",
      "Dry-run mode prints intended Multica comments and performs no external writes.",
      "Surface source failures as visible blockers instead of silent logs."
    ].join("\n")
  }),
  createProfile({
    role: "scholar",
    name: "knowledge-loop-scholar",
    description: "Runs morning study-plan and evening mastery dry-run profiles for the learning loop.",
    supportedPhases: ["morning-plan", "evening-mastery"],
    systemPrompt: [
      "You are the knowledge-loop Scholar agent.",
      "Use configured HTTP interfaces to fetch today's plan and the evening mastery summary.",
      "Dry-run mode prints intended Multica tasks or comments and performs no external writes.",
      "Keep learner-facing claims grounded in knowledge-loop source links."
    ].join("\n")
  }),
  createProfile({
    role: "nutritionist",
    name: "knowledge-loop-nutritionist",
    description: "Runs the daily meal dry-run profile through the existing compass-health HTTP API.",
    supportedPhases: ["daily-meals"],
    systemPrompt: [
      "You are the knowledge-loop Nutritionist agent.",
      "Use configured HTTP interfaces to fetch today's meals and shopping list from compass-health.",
      "Dry-run mode prints intended Multica tasks and performs no external writes.",
      "Do not read or write another project directory as an integration path."
    ].join("\n")
  })
] as const satisfies readonly KnowledgeLoopAgentProfile[];

export function listM2AgentProfiles(): readonly KnowledgeLoopAgentProfile[] {
  return M2_AGENT_PROFILES;
}

export function getM2AgentProfile(role: AgentRole): KnowledgeLoopAgentProfile {
  const profile = M2_AGENT_PROFILES.find((candidate) => candidate.role === role);
  if (profile === undefined) {
    throw new Error(`No M2 agent profile exists for role ${role}.`);
  }

  return profile;
}

export function validateM2AgentProfile(profile: KnowledgeLoopAgentProfile): string[] {
  const errors: string[] = [];
  const defaults = profile.policy.defaults;

  if (defaults.write === "allow") {
    errors.push(`${profile.name} must not allow write by default.`);
  }
  if (defaults.destructive !== "deny") {
    errors.push(`${profile.name} must deny destructive by default.`);
  }
  if (defaults.network !== "ask") {
    errors.push(`${profile.name} must ask before network access.`);
  }

  return errors;
}

function createProfile(input: {
  readonly role: AgentRole;
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly supportedPhases: readonly AgentPhase[];
}): KnowledgeLoopAgentProfile {
  return {
    ...input,
    dryRunCommand: ["npm", "run", "kl", "--", "agent", "--dry-run", "--role", input.role, "--date", "<YYYY-MM-DD>"],
    policy: {
      defaults: SAFE_POLICY_DEFAULTS
    },
    model: {
      provider: "mock",
      modelId: "dry-run-no-llm"
    },
    context: {
      compactionInstructions:
        "Preserve the current M2 role, phase, planned reads, intended Multica actions, blockers, and verification evidence."
    }
  };
}
