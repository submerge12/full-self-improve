import { describe, expect, it } from "vitest";

import { getEngineHealth } from "./health.js";

describe("getEngineHealth", () => {
  it("reports mock mode when provider is unset and no LLM API keys are configured", () => {
    expect(getEngineHealth({})).toEqual({
      status: "ok",
      mode: "mock"
    });
  });

  it("reports mock mode when provider is blank even if provider keys are present", () => {
    expect(
      getEngineHealth({
        LLM_PROVIDER: "   ",
        DEEPSEEK_API_KEY: "deepseek-key",
        QWEN_API_KEY: "qwen-key"
      })
    ).toEqual({
      status: "ok",
      mode: "mock"
    });
  });

  it("reports configured mode when deepseek is selected with a deepseek key", () => {
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

  it("reports configured mode when qwen is selected with a qwen key", () => {
    expect(
      getEngineHealth({
        LLM_PROVIDER: "qwen",
        QWEN_API_KEY: "test-key"
      })
    ).toEqual({
      status: "ok",
      mode: "configured"
    });
  });

  it("reports mock mode when selected provider does not match the available key", () => {
    expect(
      getEngineHealth({
        LLM_PROVIDER: "deepseek",
        QWEN_API_KEY: "test-key"
      })
    ).toEqual({
      status: "ok",
      mode: "mock"
    });
  });

  it("reports mock mode when selected provider key is blank", () => {
    expect(
      getEngineHealth({
        LLM_PROVIDER: "qwen",
        QWEN_API_KEY: "   "
      })
    ).toEqual({
      status: "ok",
      mode: "mock"
    });
  });

  it("reports mock mode when provider is unsupported", () => {
    expect(
      getEngineHealth({
        LLM_PROVIDER: "openai",
        DEEPSEEK_API_KEY: "deepseek-key",
        QWEN_API_KEY: "qwen-key"
      })
    ).toEqual({
      status: "ok",
      mode: "mock"
    });
  });

  it("reports mock mode when provider casing does not exactly match a supported provider", () => {
    expect(
      getEngineHealth({
        LLM_PROVIDER: "QWEN",
        QWEN_API_KEY: "test-key"
      })
    ).toEqual({
      status: "ok",
      mode: "mock"
    });
  });

  it("reports mock mode when provider has surrounding whitespace", () => {
    expect(
      getEngineHealth({
        LLM_PROVIDER: " qwen ",
        QWEN_API_KEY: "test-key"
      })
    ).toEqual({
      status: "ok",
      mode: "mock"
    });
  });
});
