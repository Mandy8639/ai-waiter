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

function defaultModelFor(provider: "anthropic" | "openrouter"): string {
  const match = configSource.match(
    new RegExp(`${provider}:\\s*"([^"]+)"`, "m"),
  );
  expect(match, `no default model found for ${provider}`).toBeTruthy();
  return match![1];
}

describe("default model per provider", () => {
  it("finds a default for both providers — guards the guard", () => {
    expect(defaultModelFor("anthropic").length).toBeGreaterThan(0);
    expect(defaultModelFor("openrouter").length).toBeGreaterThan(0);
  });

  it("never ships an OpenRouter router alias as the default", () => {
    // "openrouter/free" and any sibling alias resolve to a different model
    // per request — see this file's header for the production incident.
    expect(defaultModelFor("openrouter")).not.toMatch(/^openrouter\//);
  });

  it("pins a specific, free OpenRouter model so the provider works untuned", () => {
    const model = defaultModelFor("openrouter");
    // ":free" keeps `AI_PROVIDER=openrouter` genuinely cost-free, which is
    // the entire reason this provider exists (docs/ai.md#openrouter).
    expect(model).toMatch(/:free$/);
    // vendor/model shape, i.e. an actual pinned model rather than an alias.
    expect(model).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+:free$/);
  });

  it("keeps the Anthropic default on a current Claude model", () => {
    expect(defaultModelFor("anthropic")).toMatch(/^claude-/);
  });
});
