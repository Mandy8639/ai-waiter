import { describe, expect, it } from "vitest";
import {
  cleanTarget,
  parseDuration,
  parseStaffCommand,
} from "@/lib/staff-assistant/parse-core";

/**
 * The staff assistant's built-in phrases: how a kitchen says it. Anything
 * not here goes to the model, whose reading is always confirmed first.
 */

describe("sold out", () => {
  it.each([
    ["86 the salmon", "salmon"],
    ["86 salmon", "salmon"],
    ["86'd salmon", "salmon"],
    ["eighty-six the lamb chops", "lamb chops"],
    ["The oat milk is out", "oat milk"],
    ["oat milk's out", "oat milk"],
    ["we're out of garlic naan", "garlic naan"],
    ["out of mango lassi!", "mango lassi"],
    ["ran out of samosas", "samosas"],
    ["no more paneer tikka", "paneer tikka"],
    ["mark the butter chicken sold out", "butter chicken"],
    ["Butter chicken is sold out for today", "butter chicken"],
    ["samosas are all gone", "samosas"],
    ["sold out of chai", "chai"],
    ["“Masala Dosa” is finished", "masala dosa"],
  ])("%s", (text, target) => {
    expect(parseStaffCommand(text)).toEqual({
      kind: "sold_out",
      target,
      until: "next_opening",
    });
  });

  it("is sold out until someone says otherwise when told so", () => {
    expect(parseStaffCommand("86 the salmon until further notice")).toEqual({
      kind: "sold_out",
      target: "salmon",
      until: "manual",
    });
    expect(
      parseStaffCommand("mark the lobster sold out for good"),
    ).toMatchObject({ target: "lobster", until: "manual" });
  });
});

describe("back in stock", () => {
  it.each([
    ["salmon is back", "salmon"],
    ["the salmon's back on", "salmon"],
    ["bring back the salmon", "salmon"],
    ["un-86 salmon", "salmon"],
    ["un86 salmon", "salmon"],
    ["mark oat milk available", "oat milk"],
    ["oat milk is available again", "oat milk"],
    ["we have naan again", "naan"],
    ["samosas are back in stock", "samosas"],
    // As typed on Nashta's phone, 2026-10-18.
    ["Noodles available", "noodles"],
    ["naan back in stock", "naan"],
    ["salmon back", "salmon"],
    ["bring the salmon back", "salmon"],
  ])("%s", (text, target) => {
    expect(parseStaffCommand(text)).toEqual({ kind: "back", target });
  });
});

describe("pausing orders", () => {
  it.each([
    ["pause ordering for an hour", 60],
    ["Pause orders for 30 minutes", 30],
    ["stop taking orders for half an hour", 30],
    ["pause new orders for 2 hours", 120],
    ["hold orders 45 min", 45],
    ["pause orders for 1.5 hours", 90],
    ["pause ordering", null],
    ["stop orders", null],
  ])("%s", (text, minutes) => {
    expect(parseStaffCommand(text)).toEqual({ kind: "pause", minutes });
  });

  it.each([
    "resume ordering",
    "unpause",
    "resume orders",
    "turn on ordering",
    "start taking orders",
    "orders back on",
  ])("%s resumes", (text) => {
    expect(parseStaffCommand(text)).toEqual({ kind: "resume" });
  });
});

describe("running behind", () => {
  it.each([
    ["kitchen is slammed, add 15 minutes", 15],
    ["add 20 minutes to the wait", 20],
    ["we're running 25 mins behind", 25],
    ["10 minute delay", 10],
    ["we're slammed", 15],
  ])("%s", (text, extraMinutes) => {
    expect(parseStaffCommand(text)).toEqual({ kind: "busy", extraMinutes });
  });

  it.each(["back to normal", "we've caught up", "clear the delay"])(
    "%s",
    (text) => {
      expect(parseStaffCommand(text)).toEqual({ kind: "busy_off" });
    },
  );
});

describe("prices", () => {
  it.each([
    ["make the mango lassi $5.50", "mango lassi", 5.5],
    ["change mango lassi to $6", "mango lassi", 6],
    ["set the price of mango lassi to 5.50", "mango lassi", 5.5],
    ["change the samosa price to $4.25", "samosa", 4.25],
    ["price of chai to $3", "chai", 3],
    ["mango lassi is now $5.50", "mango lassi", 5.5],
    ["the chai costs 3.25 now", "chai", 3.25],
  ])("%s", (text, target, price) => {
    expect(parseStaffCommand(text)).toEqual({
      kind: "set_price",
      target,
      price,
    });
  });

  it("never reads a duration as a price", () => {
    expect(parseStaffCommand("pause orders for 30").kind).toBe("pause");
    expect(parseStaffCommand("make it 15 minutes").kind).not.toBe("set_price");
  });
});

describe("questions and the rest", () => {
  it.each(["what's sold out?", "status", "what are we out of"])(
    "%s",
    (text) => {
      expect(parseStaffCommand(text)).toEqual({ kind: "status" });
    },
  );

  it.each(["help", "what can you do?"])("%s", (text) => {
    expect(parseStaffCommand(text)).toEqual({ kind: "help" });
  });

  it.each([
    "",
    "   ",
    "how were sales yesterday",
    "can you swap the dinner menu for brunch tomorrow",
    "delete the salmon",
  ])("%j is left for the model", (text) => {
    expect(parseStaffCommand(text)).toEqual({ kind: "unknown" });
  });
});

describe("helpers", () => {
  it("reads durations", () => {
    expect(parseDuration("for an hour")).toBe(60);
    expect(parseDuration("for 90 mins")).toBe(90);
    expect(parseDuration("2 hrs")).toBe(120);
    expect(parseDuration("for a bit")).toBeNull();
  });

  it("tidies a target", () => {
    expect(cleanTarget("the salmon please")).toBe("salmon");
    expect(cleanTarget("all the naan for today")).toBe("naan");
    expect(cleanTarget("our chai, please")).toBe("chai");
  });
});
