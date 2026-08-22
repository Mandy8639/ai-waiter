import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Static-analysis check on the provider source files, not an import-based
 * one — src/lib/ai/providers/anthropic.ts and openrouter.ts both have
 * `import "server-only"` (see tests/unit/ai-tool-surface.test.ts's header
 * comment for why that means this file must read source as text, not
 * import it). Verifies spec requirements 10/11 directly: AI_PROVIDER=openrouter
 * must never require ANTHROPIC_API_KEY, and AI_PROVIDER=anthropic must
 * never require OPENROUTER_API_KEY — checked as a structural fact about
 * the source (neither provider file even mentions the other provider's
 * env var), not just an assumption about runtime behavior.
 */
const PROVIDERS_DIR = resolve(__dirname, "../../src/lib/ai/providers");

/** Strips /* *\/ and // comments so substring checks below can't false-positive on explanatory prose (see tests/unit/ai-tool-surface.test.ts for the same issue/fix). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(file: string): string {
  return stripComments(readFileSync(resolve(PROVIDERS_DIR, file), "utf8"));
}

describe("AI provider isolation (spec requirements 10/11)", () => {
  it("the Anthropic provider never reads OPENROUTER_API_KEY", () => {
    expect(readSource("anthropic.ts")).not.toContain("OPENROUTER_API_KEY");
  });

  it("the OpenRouter provider never reads ANTHROPIC_API_KEY", () => {
    expect(readSource("openrouter.ts")).not.toContain("ANTHROPIC_API_KEY");
  });

  it("the provider factory only ever checks the ONE selected provider's isConfigured(), never both", () => {
    const source = readSource("index.ts");
    // Both provider constructors are referenced (one is selected), but the
    // factory must not call isConfigured() on both candidates — only the
    // one aiConfig.provider actually names.
    expect(source).toContain("createAnthropicProvider");
    expect(source).toContain("createOpenRouterProvider");
    expect(source.match(/\.isConfigured\(\)/g)?.length).toBe(1);
  });

  it("neither provider file imports the Supabase admin/service-role client", () => {
    for (const file of ["anthropic.ts", "openrouter.ts", "index.ts"]) {
      const source = readSource(file);
      expect(
        source.includes("supabase/admin") ||
          source.includes("createAdminClient"),
        `${file} must never use the admin client`,
      ).toBe(false);
    }
  });
});
