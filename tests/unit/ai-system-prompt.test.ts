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

  it("separates how the dish IS from how this diner wants it", () => {
    // Two facts that share a word and must not share a meaning: the menu's
    // spice_level answers "is this spicy?", the line's spicePreference
    // answers "make mine hot".
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: false,
    });
    expect(prompt).toMatch(/spicePreference for heat/);
    expect(prompt).toMatch(/Only when they actually asked/);
    expect(prompt).toMatch(/different thing from the dish's own spice level/);
  });

  it("forbids inferring a currency from the cuisine", () => {
    // Observed live: asked to recommend from an Indian menu, the model
    // quoted "₹9.99" for dishes the app prices at $9.99.
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: false,
    });
    expect(prompt).toMatch(/State prices in that currency and no other/);
    expect(prompt).toMatch(/Do not infer a currency from the cuisine/);
  });

  it("answers 'what do you recommend' with a question, not a dish", () => {
    // A waiter asked this doesn't name a dish — they ask what the person
    // feels like eating, because the honest answer depends on who is
    // asking. Without this the model picks something arbitrary and calls
    // it a recommendation.
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: false,
    });
    expect(prompt).toContain("When someone asks what you recommend");
    expect(prompt).toMatch(/what is their appetite saying/);
    expect(prompt).toMatch(/One question, then listen/);
  });

  it("routes the mood answer through the restaurant's own categories", () => {
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: false,
    });
    expect(prompt).toMatch(/search_menu takes a category filter/);
    expect(prompt).toMatch(/call get_restaurant_info to see them/);
    // The dishes named must come from a search, not from what the model
    // knows about the cuisine.
    expect(prompt).toMatch(/must come from a search you just ran/);
  });

  it("does not let a recommendation become a sales pitch", () => {
    const prompt = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: false,
    });
    expect(prompt).toMatch(/name two or three that genuinely fit/);
    expect(prompt).toMatch(/let them choose/);
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
