import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A static scan of src/lib/ai/config.ts, in the same spirit as
 * tests/unit/migrations-safe-writes.test.ts: config.ts has
 * `import "server-only"` and so cannot be imported here (see
 * ai-config.test.ts's header for why), but the default it ships is a real
 * product decision worth pinning, and a regex over the source is enough to
 * pin it.
 *
 * The rule this enforces exists because of a live production incident:
 * `AI_MODEL` was set to `openrouter/free`, OpenRouter's ROUTER ALIAS, which
 * resolves to a different model per request. One of those routes told a
 * customer "Added one chicken tikka masala ($19.99) to your order" while
 * never calling add_item_to_cart — the cart stayed empty. A default whose
 * behavior can't be reproduced between two requests can't be reasoned
 * about at all, so the alias must never become the shipped default.
 */
const configSource = readFileSync(
  join(process.cwd(), "src/lib/ai/config.ts"),
  "utf8",
);

function defaultModelsFor(provider: "anthropic" | "openrouter"): string[] {
  const block = configSource.match(
    new RegExp(`${provider}:\\s*\\[([^\\]]*)\\]`, "m"),
  );
  expect(block, `no default model list found for ${provider}`).toBeTruthy();
  const models = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(models.length, `empty model list for ${provider}`).toBeGreaterThan(0);
  return models;
}

describe("default model preference list per provider", () => {
  it("finds a list for both providers — guards the guard", () => {
    expect(defaultModelsFor("anthropic").length).toBeGreaterThan(0);
    expect(defaultModelsFor("openrouter").length).toBeGreaterThan(0);
  });

  it("never ships an OpenRouter router alias, at any position in the list", () => {
    // Position matters: an alias buried as a fallback is just as capable of
    // routing to a model that fabricates tool calls as one in first place.
    for (const model of defaultModelsFor("openrouter")) {
      expect(model, `${model} is a router alias`).not.toMatch(/^openrouter\//);
    }
  });

  it("pins every OpenRouter entry to a specific free model", () => {
    for (const model of defaultModelsFor("openrouter")) {
      // ":free" keeps AI_PROVIDER=openrouter genuinely cost-free, which is
      // the entire reason this provider exists (docs/ai.md#openrouter).
      expect(model).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+:free$/);
    }
  });

  it("ships at least one fallback, so a single model outage isn't an outage", () => {
    // google/gemma-4-26b-a4b-it:free went from working default to permanent
    // 429 with no code change — see docs/ai.md#model-fallback.
    expect(defaultModelsFor("openrouter").length).toBeGreaterThanOrEqual(2);
  });

  it("has no duplicate entries — a repeated model is a wasted fallback slot", () => {
    const models = defaultModelsFor("openrouter");
    expect(new Set(models).size).toBe(models.length);
  });

  it("draws fallbacks from different vendors, which don't fail together", () => {
    const vendors = defaultModelsFor("openrouter").map((m) => m.split("/")[0]);
    expect(new Set(vendors).size).toBeGreaterThan(1);
  });

  it("keeps the Anthropic default on a current Claude model", () => {
    for (const model of defaultModelsFor("anthropic")) {
      expect(model).toMatch(/^claude-/);
    }
  });
});
