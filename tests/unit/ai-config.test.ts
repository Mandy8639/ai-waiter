import { describe, expect, it } from "vitest";
import { envInt, envFloat, envList } from "@/lib/env-helpers";

// These test the parsing primitives src/lib/ai/config.ts (and, as of
// Batch 8, src/lib/customer/rate-limit.ts and src/lib/orders/rate-limit.ts)
// build every tunable from. config.ts itself has `import "server-only"`,
// which throws unconditionally outside Next.js's RSC bundling — see
// src/lib/env-helpers.ts's own header comment for why it's split out,
// matching how every other test file in this project avoids importing
// server-only-guarded modules directly.

describe("envInt", () => {
  it("returns the fallback when unset", () => {
    expect(envInt("AI_TEST_UNSET_INT", 42)).toBe(42);
  });

  it("parses a valid positive integer", () => {
    process.env.AI_TEST_INT = "7";
    expect(envInt("AI_TEST_INT", 1)).toBe(7);
    delete process.env.AI_TEST_INT;
  });

  it("falls back for a non-numeric value rather than producing NaN", () => {
    process.env.AI_TEST_INT = "not-a-number";
    const result = envInt("AI_TEST_INT", 9);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(9);
    delete process.env.AI_TEST_INT;
  });

  it("falls back for zero or a negative value", () => {
    process.env.AI_TEST_INT = "-5";
    expect(envInt("AI_TEST_INT", 3)).toBe(3);
    process.env.AI_TEST_INT = "0";
    expect(envInt("AI_TEST_INT", 3)).toBe(3);
    delete process.env.AI_TEST_INT;
  });
});

describe("envFloat", () => {
  it("returns the fallback when unset", () => {
    expect(envFloat("AI_TEST_UNSET_FLOAT", 0.5)).toBe(0.5);
  });

  it("parses a valid float", () => {
    process.env.AI_TEST_FLOAT = "0.7";
    expect(envFloat("AI_TEST_FLOAT", 0.1)).toBeCloseTo(0.7);
    delete process.env.AI_TEST_FLOAT;
  });

  it("falls back for a non-numeric value", () => {
    process.env.AI_TEST_FLOAT = "not-a-float";
    expect(envFloat("AI_TEST_FLOAT", 0.4)).toBe(0.4);
    delete process.env.AI_TEST_FLOAT;
  });

  it("allows zero (a valid temperature)", () => {
    process.env.AI_TEST_FLOAT = "0";
    expect(envFloat("AI_TEST_FLOAT", 0.4)).toBe(0);
    delete process.env.AI_TEST_FLOAT;
  });
});

describe("envList", () => {
  it("returns the fallback when unset", () => {
    expect(envList("AI_TEST_UNSET_LIST", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("parses a single value into a one-entry list", () => {
    process.env.AI_TEST_LIST = "solo-model";
    expect(envList("AI_TEST_LIST", ["x"])).toEqual(["solo-model"]);
    delete process.env.AI_TEST_LIST;
  });

  it("splits on commas and trims surrounding whitespace", () => {
    process.env.AI_TEST_LIST = " first , second ,third ";
    expect(envList("AI_TEST_LIST", ["x"])).toEqual([
      "first",
      "second",
      "third",
    ]);
    delete process.env.AI_TEST_LIST;
  });

  it("drops empty entries from stray or trailing commas", () => {
    process.env.AI_TEST_LIST = "first,,second,";
    expect(envList("AI_TEST_LIST", ["x"])).toEqual(["first", "second"]);
    delete process.env.AI_TEST_LIST;
  });

  it("drops duplicates, preserving first-seen order", () => {
    // Sending the same model twice in OpenRouter's `models` array buys
    // nothing and makes the logged preference list harder to read.
    process.env.AI_TEST_LIST = "a,b,a,c,b";
    expect(envList("AI_TEST_LIST", ["x"])).toEqual(["a", "b", "c"]);
    delete process.env.AI_TEST_LIST;
  });

  it("falls back when the value is only separators and whitespace", () => {
    process.env.AI_TEST_LIST = " , , ";
    expect(envList("AI_TEST_LIST", ["fallback"])).toEqual(["fallback"]);
    delete process.env.AI_TEST_LIST;
  });
});
