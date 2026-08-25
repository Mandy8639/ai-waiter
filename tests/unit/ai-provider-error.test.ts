import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  AiProviderError,
  categorizeAiError,
  categorizeAnthropicError,
} from "@/lib/ai/provider-error";

describe("categorizeAiError", () => {
  it("returns the category of an AiProviderError", () => {
    const error = new AiProviderError("boom", "rate_limited");
    expect(categorizeAiError(error)).toBe("rate_limited");
  });

  it("returns 'unknown' for a plain Error", () => {
    expect(categorizeAiError(new Error("boom"))).toBe("unknown");
  });

  it("returns 'unknown' for a non-Error thrown value", () => {
    expect(categorizeAiError("boom")).toBe("unknown");
    expect(categorizeAiError(undefined)).toBe("unknown");
  });
});

describe("categorizeAnthropicError", () => {
  it("classifies APIConnectionTimeoutError as timeout", () => {
    const error = new Anthropic.APIConnectionTimeoutError({
      message: "Request timed out",
    });
    expect(categorizeAnthropicError(error)).toBe("timeout");
  });

  it("classifies RateLimitError as rate_limited", () => {
    const error = new Anthropic.RateLimitError(
      429,
      {},
      "Rate limited",
      new Headers(),
    );
    expect(categorizeAnthropicError(error)).toBe("rate_limited");
  });

  it("classifies a plain APIConnectionError (non-timeout) as network_error", () => {
    const error = new Anthropic.APIConnectionError({
      message: "Connection failed",
    });
    expect(categorizeAnthropicError(error)).toBe("network_error");
  });

  it("classifies other APIError subclasses as http_error", () => {
    const error = new Anthropic.BadRequestError(
      400,
      {},
      "Bad request",
      new Headers(),
    );
    expect(categorizeAnthropicError(error)).toBe("http_error");

    const serverError = new Anthropic.InternalServerError(
      500,
      {},
      "Server error",
      new Headers(),
    );
    expect(categorizeAnthropicError(serverError)).toBe("http_error");
  });

  it("classifies a non-SDK error as unknown", () => {
    expect(categorizeAnthropicError(new Error("plain error"))).toBe("unknown");
    expect(categorizeAnthropicError("not even an error")).toBe("unknown");
  });
});
