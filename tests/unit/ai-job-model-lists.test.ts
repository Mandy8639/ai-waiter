import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The three jobs must keep three separate model lists.
 *
 * This is a structural test rather than a behavioural one because the
 * thing worth protecting is a decision, not a computation: menu detail
 * suggestion silently borrowed the menu-photo reader's model for months
 * because the code sat next to it, and nothing failed — the call simply
 * used a model chosen for OCR to do a text-only JSON job. A regression
 * here looks like working software.
 */
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("per-job model lists", () => {
  it("keeps the waiter, reader and suggester lists distinct", () => {
    const config = read("src/lib/ai/config.ts");
    expect(config).toContain("DEFAULT_VISION_MODELS");
    expect(config).toContain("DEFAULT_SUGGESTION_MODELS");
    expect(config).toContain("MENU_SUGGESTION_MODEL");
    expect(config).toContain("MENU_IMPORT_VISION_MODEL");
  });

  it("does not put the failed model back in the waiter list", () => {
    // nemotron-3-ultra called a tool on 1 of 4 menu questions while
    // shipping as a production fallback. It passed an earlier, laxer
    // probe — which is the argument for re-vetting, and for this test.
    const config = read("src/lib/ai/config.ts");
    const waiterList = config.slice(
      config.indexOf("openrouter: ["),
      config.indexOf("};", config.indexOf("openrouter: [")),
    );
    expect(waiterList).not.toContain("nemotron-3-ultra");
  });

  it("never sends `model` and `models` together on any menu-import call", () => {
    // The singular field wins and the fallback list is silently ignored —
    // no error, no warning. Already asserted for the chat path in
    // ai-provider-openrouter-model-call.test.ts; these are the two other
    // paths that talk to OpenRouter directly.
    for (const file of [
      "src/lib/menu-import/vision.ts",
      "src/lib/menu-import/suggest-actions.ts",
    ]) {
      const source = read(file);
      const body = source.slice(source.indexOf("JSON.stringify({"));
      expect(body, `${file} must send models[]`).toContain("models:");
      expect(
        /^\s*model:/m.test(body),
        `${file} must not also send a singular model`,
      ).toBe(false);
    }
  });

  it("gives the suggester a list that is not just the reader's", () => {
    // They may overlap — dots-3 is vetted for both — but one must not be
    // defined as the other.
    const config = read("src/lib/ai/config.ts");
    // Scoped to each array LITERAL, not to the rest of the file — the
    // aiConfig block below legitimately names both constants, which is
    // what made the first version of this assertion fail on correct code.
    const literal = (name: string) => {
      const start = config.indexOf(`export const ${name} = [`);
      return config.slice(start, config.indexOf("];", start));
    };
    const suggestion = literal("DEFAULT_SUGGESTION_MODELS");
    const vision = literal("DEFAULT_VISION_MODELS");
    expect(suggestion).not.toContain("DEFAULT_VISION_MODELS");
    expect(vision).toContain("nemotron-3-nano-omni");
    // Overlap is fine — dots-3 is vetted for both — being identical is not.
    expect(suggestion).not.toBe(vision);
  });
});
