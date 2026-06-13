export type EngineHealthMode = "mock" | "configured";

export interface EngineHealth {
  status: "ok";
  mode: EngineHealthMode;
}

export interface EngineHealthEnv {
  LLM_PROVIDER?: string;
  DEEPSEEK_API_KEY?: string;
  QWEN_API_KEY?: string;
}

export function getEngineHealth(env: EngineHealthEnv = process.env as EngineHealthEnv): EngineHealth {
  return {
    status: "ok",
    mode: hasConfiguredProvider(env) ? "configured" : "mock"
  };
}

function hasConfiguredProvider(env: EngineHealthEnv): boolean {
  if (env.LLM_PROVIDER === "deepseek") {
    return hasValue(env.DEEPSEEK_API_KEY);
  }

  if (env.LLM_PROVIDER === "qwen") {
    return hasValue(env.QWEN_API_KEY);
  }

  return false;
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
