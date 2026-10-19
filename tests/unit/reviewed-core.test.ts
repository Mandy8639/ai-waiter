import { describe, expect, it } from "vitest";
import {
  allergenSignature,
  namesFromSignature,
  nutritionSignature,
  restoreMarks,
} from "@/lib/review/reviewed-core";

describe("nutritionSignature", () => {
  it("is the same for the same numbers, however they were typed", () => {
    expect(
      nutritionSignature({ calories: 360, proteinG: 15, carbsG: 17, fatG: 25 }),
    ).toBe(
      nutritionSignature({
        calories: 360,
        proteinG: Number("15.0"),
        carbsG: 17,
        fatG: 25,
      }),
    );
  });

  it("changes when any number changes", () => {
    const a = { calories: 320, proteinG: 6.5, carbsG: 28, fatG: 21 };
    expect(nutritionSignature(a)).not.toBe(
      nutritionSignature({ ...a, proteinG: 6.6 }),
    );
  });
});

describe("allergenSignature", () => {
  it("ignores order, and round-trips", () => {
    expect(allergenSignature(["Wheat", "Milk"])).toBe(
      allergenSignature(new Set(["Milk", "Wheat"])),
    );
    expect(namesFromSignature(allergenSignature(["Soy", "Eggs"]))).toEqual([
      "Eggs",
      "Soy",
    ]);
    expect(namesFromSignature(allergenSignature([]))).toEqual([]);
  });
});

describe("restoreMarks", () => {
  it("keeps only marks the caller still accepts", () => {
    const stored = JSON.stringify({ a: "1|2|3|4", b: "9|9|9|9", c: 5 });
    expect(
      restoreMarks(stored, (id, sig) => id === "a" && sig === "1|2|3|4"),
    ).toEqual({ a: "1|2|3|4" });
  });

  it("treats missing or broken storage as no marks", () => {
    expect(restoreMarks(null, () => true)).toEqual({});
    expect(restoreMarks("{not json", () => true)).toEqual({});
    expect(restoreMarks("[1,2]", () => true)).toEqual({});
  });
});
