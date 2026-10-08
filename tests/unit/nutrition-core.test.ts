import { describe, expect, it } from "vitest";
import {
  atwaterCalories,
  estimatePrompt,
  nutritionMismatch,
  nutritionState,
  nutritionSummary,
  parseEstimateReply,
  parseNutrition,
} from "@/lib/nutrition/core";

describe("parseNutrition", () => {
  it("accepts typed numbers and rounds grams to one decimal", () => {
    expect(
      parseNutrition({
        calories: "520",
        proteinG: "18.04",
        carbsG: " 64 ",
        fatG: "21.25",
      }),
    ).toEqual({
      ok: true,
      value: { calories: 520, proteinG: 18, carbsG: 64, fatG: 21.3 },
    });
  });

  it("refuses blanks, words, fractional calories and impossible amounts", () => {
    const base = { calories: "520", proteinG: "18", carbsG: "64", fatG: "21" };
    for (const bad of [
      { ...base, fatG: "" },
      { ...base, proteinG: "lots" },
      { ...base, calories: "520.5" },
      { ...base, calories: "52000" },
      { ...base, calories: "-1" },
      { ...base, carbsG: "640" },
      { ...base, fatG: "-2" },
    ]) {
      expect(parseNutrition(bad).ok).toBe(false);
    }
  });

  it("matches the database's limits at the edges", () => {
    expect(
      parseNutrition({ calories: 5000, proteinG: 500, carbsG: 0, fatG: 0 }).ok,
    ).toBe(true);
    expect(
      parseNutrition({ calories: 5001, proteinG: 0, carbsG: 0, fatG: 0 }).ok,
    ).toBe(false);
  });
});

describe("do the numbers add up", () => {
  it("works out calories at 4/4/9", () => {
    expect(atwaterCalories({ proteinG: 18, carbsG: 64, fatG: 21 })).toBe(517);
  });

  it("lets real labels through and flags a typo", () => {
    // A real label: off by a few percent (fibre, rounding).
    expect(
      nutritionMismatch({ calories: 540, proteinG: 18, carbsG: 64, fatG: 21 })
        .mismatch,
    ).toBe(false);
    // A dropped digit.
    expect(
      nutritionMismatch({ calories: 52, proteinG: 18, carbsG: 64, fatG: 21 }),
    ).toEqual({ expected: 517, mismatch: true });
    // A small drink: 30 kcal of slack, not 20%.
    expect(
      nutritionMismatch({ calories: 30, proteinG: 0, carbsG: 2, fatG: 0 })
        .mismatch,
    ).toBe(false);
  });
});

describe("display", () => {
  it("summarises without trailing .0", () => {
    expect(
      nutritionSummary({ calories: 520, proteinG: 18, carbsG: 64.5, fatG: 21 }),
    ).toBe("520 kcal · 18 g protein · 64.5 g carbs · 21 g fat");
  });

  it("knows missing, draft and confirmed", () => {
    expect(nutritionState(null)).toBe("missing");
    expect(nutritionState({ confirmedAt: null })).toBe("draft");
    expect(nutritionState({ confirmedAt: "2026-10-08T12:00:00Z" })).toBe(
      "confirmed",
    );
  });
});

describe("AI estimates", () => {
  const dishes = [
    {
      key: "d0",
      name: "Masala Dosa",
      description: "Crisp rice crepe, potato filling",
      category: "South Indian",
    },
    { key: "d1", name: "Chef's Special", description: null, category: null },
    { key: "d2", name: "Mango Lassi", description: null, category: "Drinks" },
    { key: "d3", name: "Pav Bhaji", description: null, category: null },
  ];

  it("sends only what the dish says about itself", () => {
    const { system, user } = estimatePrompt(dishes);
    expect(system).toMatch(/ONLY a JSON object/);
    expect(system).toMatch(/null/);
    expect(JSON.parse(user)).toEqual({
      d0: {
        dish: "Masala Dosa",
        description: "Crisp rice crepe, potato filling",
        section: "South Indian",
      },
      d1: { dish: "Chef's Special" },
      d2: { dish: "Mango Lassi", section: "Drinks" },
      d3: { dish: "Pav Bhaji" },
    });
  });

  it("keeps sensible estimates and drops nulls, nonsense and numbers that don't add up", () => {
    const reply = `Here you go:
    {"d0": {"calories": 387.6, "protein_g": 8, "carbs_g": 58, "fat_g": 13.4},
     "d1": null,
     "d2": {"calories": 900, "protein_g": 7, "carbs_g": 45, "fat_g": 4},
     "d3": {"calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}}`;
    const out = parseEstimateReply(reply, dishes);
    expect([...out.keys()]).toEqual(["d0"]);
    expect(out.get("d0")).toEqual({
      calories: 388,
      proteinG: 8,
      carbsG: 58,
      fatG: 13.4,
    });
  });

  it("returns nothing for a reply that isn't JSON", () => {
    expect(parseEstimateReply("Sorry, I can't help.", dishes).size).toBe(0);
    expect(parseEstimateReply("{not json}", dishes).size).toBe(0);
  });
});
