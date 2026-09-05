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

  it("lets the waiter talk about how a dish is made, from stored data only", () => {
    // The point of the product: a waiter who cannot answer "what's in it?"
    // or "how long does it take?" is not doing the job. The prompt has to
    // permit that explicitly, because every other rule in it says "don't
    // say things about the menu".
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: false,
    });
    expect(prompt).toContain("Talking about the food");
    expect(prompt).toMatch(/how it's cooked/);
    expect(prompt).toMatch(/ingredients/);
    expect(prompt).toMatch(/preparationTimeMinutes/);
    expect(prompt).toMatch(/portionNote/);
  });

  it("draws the line at reciting a recipe it cannot source", () => {
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: false,
    });
    expect(prompt).toMatch(
      /Do not give quantities, recipe steps, cooking temperatures/,
    );
    expect(prompt).toMatch(/not teaching someone to cook it/);
    // And an empty field must not be filled in by estimating.
    expect(prompt).toMatch(/that is not an invitation to estimate/);
  });

  it("keeps the appetite hedge in a portion answer", () => {
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: false,
    });
    expect(prompt).toMatch(/flattening that into "serves 2"/);
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
