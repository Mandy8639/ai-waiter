// @vitest-environment node
//
// Live verification of callOpenRouterModel's error handling — a real Node
// HTTP server on localhost stands in for OpenRouter, so `fetch`, the real
// `AbortSignal.timeout`, and the DOMException/status-code branches all run
// for real. This is deliberately NOT just a mocked-error unit test: the
// timeout case previously had no coverage at all (see the Item-6
// production-reliability audit — "structurally correct but never
// empirically observed firing"), and a mock can't prove the real
// AbortSignal.timeout()/fetch interaction actually behaves as assumed.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { callOpenRouterModel } from "@/lib/ai/providers/openrouter-model-call";
import { AiProviderError } from "@/lib/ai/provider-error";

let server: Server | undefined;

function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a bound TCP address");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

const baseParams = {
  apiKey: "test-key",
  model: "test-model",
  maxOutputTokens: 100,
  messages: [],
  tools: [],
};

describe("callOpenRouterModel — live HTTP behavior", () => {
  it("really times out: a server that never responds triggers category 'timeout' near the configured deadline", async () => {
    // Accepts the connection but never calls res.end() — the request hangs
    // until AbortSignal.timeout() fires, exactly like a stalled upstream.
    const endpoint = await listen(() => {});
    const start = Date.now();

    const error = await callOpenRouterModel({
      ...baseParams,
      endpoint,
      requestTimeoutMs: 100,
    }).catch((e: unknown) => e);

    const elapsedMs = Date.now() - start;
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).category).toBe("timeout");
    expect((error as AiProviderError).message).toContain("100ms");
    // Bounded, not exact: must not return instantly (proves the abort is
    // actually what ended the request) and must not hang far past the
    // configured deadline (proves the abort actually fires, not just the
    // message text claiming it did).
    expect(elapsedMs).toBeGreaterThanOrEqual(90);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("classifies a real connection failure as 'network_error'", async () => {
    // Bind and immediately close, so the port is real but nothing is
    // listening — fetch rejects with a genuine ECONNREFUSED, not a mock.
    const endpoint = await listen(() => {});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    const error = await callOpenRouterModel({
      ...baseParams,
      endpoint,
      requestTimeoutMs: 5000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).category).toBe("network_error");
  });

  it("classifies a real 429 response as 'rate_limited'", async () => {
    const endpoint = await listen((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
    });

    const error = await callOpenRouterModel({
      ...baseParams,
      endpoint,
      requestTimeoutMs: 5000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).category).toBe("rate_limited");
  });

  it("classifies a real 500 response as 'http_error'", async () => {
    const endpoint = await listen((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server error" }));
    });

    const error = await callOpenRouterModel({
      ...baseParams,
      endpoint,
      requestTimeoutMs: 5000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).category).toBe("http_error");
  });

  it("classifies a real malformed JSON body as 'unknown'", async () => {
    const endpoint = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{not valid json");
    });

    const error = await callOpenRouterModel({
      ...baseParams,
      endpoint,
      requestTimeoutMs: 5000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).category).toBe("unknown");
  });

  it("parses a real successful response end-to-end", async () => {
    const endpoint = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "Here you go." },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });

    const result = await callOpenRouterModel({
      ...baseParams,
      endpoint,
      requestTimeoutMs: 5000,
    });

    expect(result.content).toEqual([{ type: "text", text: "Here you go." }]);
  });
});

describe("model fallback — the `models` preference list", () => {
  /**
   * Captures the request body the real fetch actually sends, because the
   * bug this guards against is invisible in behavior: sending `model`
   * alongside `models` makes OpenRouter silently ignore the fallback list
   * and serve (or fail on) the primary only. Verified live against the
   * real API before this was written.
   */
  async function captureBody(
    params: Partial<Parameters<typeof callOpenRouterModel>[0]>,
  ): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    const endpoint = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        captured = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "served/by-fallback",
            choices: [
              {
                message: { role: "assistant", content: "hi" },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
    });
    await callOpenRouterModel({
      ...baseParams,
      endpoint,
      requestTimeoutMs: 5_000,
      ...params,
    });
    return captured;
  }

  it("sends `model` alone when no fallbacks are configured", async () => {
    const body = await captureBody({ fallbackModels: [] });
    expect(body.model).toBe("test-model");
    expect(body.models).toBeUndefined();
  });

  it("sends `model` alone when fallbackModels is omitted entirely", async () => {
    const body = await captureBody({});
    expect(body.model).toBe("test-model");
    expect(body.models).toBeUndefined();
  });

  it("sends `models` with the primary first, and NEVER `model` alongside it", async () => {
    const body = await captureBody({
      fallbackModels: ["backup-a", "backup-b"],
    });
    expect(body.models).toEqual(["test-model", "backup-a", "backup-b"]);
    // The whole point: `model` present here would silently disable fallback.
    expect(body.model).toBeUndefined();
  });

  it("reports the model that actually served, not the one requested first", async () => {
    const endpoint = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "served/by-fallback",
          choices: [
            {
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    const result = await callOpenRouterModel({
      ...baseParams,
      endpoint,
      requestTimeoutMs: 5_000,
      fallbackModels: ["backup-a"],
    });
    expect(result.servedModel).toBe("served/by-fallback");
  });

  it("leaves servedModel undefined when the provider doesn't report one", async () => {
    const endpoint = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    const result = await callOpenRouterModel({
      ...baseParams,
      endpoint,
      requestTimeoutMs: 5_000,
    });
    expect(result.servedModel).toBeUndefined();
  });
});
