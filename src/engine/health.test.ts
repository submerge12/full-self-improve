import { describe, expect, it } from "vitest";

import { getEngineHealth } from "./health.js";

describe("getEngineHealth", () => {
  it("reports mock mode when no LLM API keys are configured", () => {
    expect(getEngineHealth({})).toEqual({
      status: "ok",
      mode: "mock"
    });
  });

  it("reports configured mode when a provider key is available", () => {
    expect(
      getEngineHealth({
        LLM_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "test-key"
      })
    ).toEqual({
      status: "ok",
      mode: "configured"
    });
  });
});
