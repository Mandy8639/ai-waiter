import { describe, expect, it } from "vitest";
import { resolveAiProviderGate } from "../e2e/ai-provider-gate";

describe("resolveAiProviderGate", () => {
  it("requires ANTHROPIC_API_KEY when AI_PROVIDER=anthropic", () => {
    expect(
      resolveAiProviderGate({
        AI_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "sk-ant-real",
      }),
    ).toEqual({
      hasRealAiProvider: true,
      skipReason: expect.stringContaining("ANTHROPIC_API_KEY"),
    });

    expect(
      resolveAiProviderGate({ AI_PROVIDER: "anthropic" }).hasRealAiProvider,
    ).toBe(false);
  });

  it("requires OPENROUTER_API_KEY when AI_PROVIDER=openrouter", () => {
    expect(
      resolveAiProviderGate({
        AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "sk-or-real",
      }),
    ).toEqual({
      hasRealAiProvider: true,
      skipReason: expect.stringContaining("OPENROUTER_API_KEY"),
    });

    expect(
      resolveAiProviderGate({ AI_PROVIDER: "openrouter" }).hasRealAiProvider,
    ).toBe(false);
  });

  it("never requires the other provider's key", () => {
    const result = resolveAiProviderGate({
      AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-real",
      ANTHROPIC_API_KEY: undefined,
    });
    expect(result.hasRealAiProvider).toBe(true);
  });

  it("skips with a clear reason for an unrecognized AI_PROVIDER value, never defaulting", () => {
    const result = resolveAiProviderGate({
      AI_PROVIDER: "some-typo",
      ANTHROPIC_API_KEY: "sk-ant-real",
      OPENROUTER_API_KEY: "sk-or-real",
    });
    expect(result.hasRealAiProvider).toBe(false);
    expect(result.skipReason).toContain("some-typo");
  });

  it("skips with a clear reason when AI_PROVIDER is unset", () => {
    const result = resolveAiProviderGate({});
    expect(result.hasRealAiProvider).toBe(false);
    expect(result.skipReason).toMatch(/not "anthropic" or "openrouter"/);
  });
});
