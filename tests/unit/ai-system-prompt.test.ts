import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";

describe("buildSystemPrompt", () => {
  it("omits the recent-tool-results section when there's no recent context", () => {
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: true,
    });
    expect(prompt).not.toContain("Recent tool results from this conversation");
  });

  it("includes the recent-tool-results section, verbatim, when provided", () => {
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: true,
      recentToolContext:
        '- get_menu_item: {"ok":true,"data":{"modifierGroups":[{"name":"Spice level"}]}}',
    });
    expect(prompt).toContain("Recent tool results from this conversation");
    expect(prompt).toContain("get_menu_item");
    expect(prompt).toContain("Spice level");
  });

  it("still includes the restaurant name and upselling policy alongside recent tool context", () => {
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: false,
      recentToolContext: "- search_menu: {}",
    });
    expect(prompt).toContain("Test Restaurant");
    expect(prompt).toContain("has not enabled upselling");
  });
});
