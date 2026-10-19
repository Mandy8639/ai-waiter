import { describe, expect, it } from "vitest";
import { OPENROUTER_MAX_MODELS, openRouterModels } from "@/lib/ai/model-list";
import { readFileSync } from "node:fs";

/**
 * OpenRouter refuses more than three models per request with a 400 — the
 * suggester's four-model list failed every call until 2026-10-18.
 */
describe("openRouterModels", () => {
  it("never sends more than three, keeping preference order", () => {
    expect(openRouterModels(["a", "b", "c", "d", "e"])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(OPENROUTER_MAX_MODELS).toBe(3);
  });

  it("drops duplicates and blanks before counting", () => {
    expect(openRouterModels(["a", "a", "", "b"])).toEqual(["a", "b"]);
  });

  it("is used by every call that sends a models list", () => {
    for (const file of [
      "src/lib/menu-import/suggest-actions.ts",
      "src/lib/menu-import/vision.ts",
      "src/lib/staff-assistant/interpret.ts",
      "src/lib/ai/free-draft.ts",
      "src/lib/ai/providers/openrouter-model-call.ts",
    ]) {
      expect(readFileSync(file, "utf8"), file).toContain("openRouterModels(");
    }
  });
});
