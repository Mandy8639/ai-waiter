// What one AI use cost: OpenRouter's figures added up across calls, the
// listed price when it gives none, and null rather than 0 when unknown
// (src/lib/ai/usage-core.ts).
import { describe, expect, it } from "vitest";
import { addCall, newTally, readUsage, tallyCost } from "@/lib/ai/usage-core";

const reply = (usage: Record<string, unknown> | undefined) => ({
  model: "m/one",
  usage,
});

describe("readUsage", () => {
  it("reads tokens and OpenRouter's cost", () => {
    expect(
      readUsage(
        reply({ prompt_tokens: 1200, completion_tokens: 80, cost: 0.0021 }),
      ),
    ).toEqual({ tokensIn: 1200, tokensOut: 80, costUsd: 0.0021 });
  });

  it("is null without a usage block", () => {
    expect(readUsage(reply(undefined))).toBeNull();
    expect(readUsage(null)).toBeNull();
  });
});

describe("a tally across one use's calls", () => {
  it("adds up a waiter turn's tool-calling rounds", () => {
    const tally = newTally();
    addCall(
      tally,
      reply({ prompt_tokens: 1000, completion_tokens: 50, cost: 0.002 }),
      "m/one",
    );
    addCall(
      tally,
      reply({ prompt_tokens: 1300, completion_tokens: 120, cost: 0.003 }),
      "m/two",
    );
    expect(tally).toMatchObject({
      calls: 2,
      model: "m/two",
      tokensIn: 2300,
      tokensOut: 170,
    });
    expect(tallyCost(tally, null)).toEqual({
      costUsd: 0.005,
      estimated: false,
    });
  });

  it("is free when OpenRouter says so", () => {
    const tally = newTally();
    addCall(
      tally,
      reply({ prompt_tokens: 900, completion_tokens: 40, cost: 0 }),
    );
    expect(tallyCost(tally, null)).toEqual({ costUsd: 0, estimated: false });
  });

  it("prices calls without a cost from the listed price, and says so", () => {
    const tally = newTally();
    addCall(
      tally,
      reply({ prompt_tokens: 1000, completion_tokens: 100, cost: 0.001 }),
    );
    addCall(tally, reply({ prompt_tokens: 2000, completion_tokens: 500 }));
    expect(
      tallyCost(tally, { promptPrice: 0.000001, completionPrice: 0.000004 }),
    ).toEqual({ costUsd: 0.001 + 0.002 + 0.002, estimated: true });
  });

  it("is unknown, not zero, when it can't be priced", () => {
    const noPrice = newTally();
    addCall(noPrice, reply({ prompt_tokens: 2000, completion_tokens: 500 }));
    expect(tallyCost(noPrice, null)).toEqual({
      costUsd: null,
      estimated: false,
    });

    const noUsage = newTally();
    addCall(noUsage, reply(undefined));
    expect(tallyCost(noUsage, { promptPrice: 1, completionPrice: 1 })).toEqual({
      costUsd: null,
      estimated: false,
    });
  });
});
