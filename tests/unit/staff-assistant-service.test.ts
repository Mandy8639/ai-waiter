import { describe, expect, it } from "vitest";
import { parseStaffCommand } from "@/lib/staff-assistant/parse-core";
import {
  greetingText,
  helpText,
  pickExampleOption,
  planIntent,
  serviceText,
  type PlanContext,
} from "@/lib/staff-assistant/plan-core";
import { parseInterpretation } from "@/lib/staff-assistant/interpret-core";

/**
 * Found in the staff app on 2026-10-29: "Hi" and "How many live tables do
 * we have" both got "Sorry, I didn't catch that", and the help list
 * suggested "The Regular is out".
 */

const ctx = (extra: Partial<PlanContext> = {}): PlanContext => ({
  catalog: {
    dishes: [
      {
        id: "d1",
        name: "Punjabi Samosa",
        price: 6,
        available: true,
        backAt: null,
      },
      { id: "d2", name: "Cone Dosa", price: 14, available: true, backAt: null },
    ],
    options: [
      {
        id: "o1",
        name: "Regular",
        groupName: "Size",
        dishName: "Cone Dosa",
        available: true,
      },
      {
        id: "o2",
        name: "Large",
        groupName: "Size",
        dishName: "Cone Dosa",
        available: true,
      },
      {
        id: "o3",
        name: "Extra chutney",
        groupName: "Sides",
        dishName: "Cone Dosa",
        available: true,
      },
    ],
  },
  role: "kitchen",
  state: { pausedUntil: null, busyExtraMinutes: 0 },
  source: "rules",
  timeZone: "America/New_York",
  now: new Date("2026-10-29T23:00:00Z"),
  ...extra,
});

describe("small talk", () => {
  it.each(["Hi", "hello!", "Hey there", "good evening"])(
    "%s is a greeting",
    (text) => {
      expect(parseStaffCommand(text)).toEqual({
        kind: "greeting",
        thanks: false,
      });
    },
  );
  it.each([
    "thanks",
    "Thank you!",
    "ok thanks",
    "Ok",
    "okay",
    "got it",
    "cool",
  ])("%s is an acknowledgement", (text) => {
    expect(parseStaffCommand(text)).toEqual({ kind: "greeting", thanks: true });
  });
  it("answers hello with what it can do, never 'didn't catch that'", () => {
    const plan = planIntent({ kind: "greeting", thanks: false }, ctx());
    expect(plan.type).toBe("answered");
    const text = "text" in plan ? plan.text : "";
    expect(text).toMatch(/^Hi!/);
    expect(text).toContain("86 the Punjabi Samosa");
    expect(text).not.toMatch(/didn't catch/);
    expect(greetingText(true)).toBe("👍 Anything else, just ask.");
  });
  it("never reads a typed 'yes' as done", () => {
    expect(parseStaffCommand("yes").kind).not.toBe("greeting");
  });
  it("doesn't mistake a command that starts with hello", () => {
    expect(parseStaffCommand("hey 86 the cone dosa").kind).not.toBe("greeting");
  });
});

describe("how service is going", () => {
  it.each([
    "How many live tables do we have",
    "how many tables are open?",
    "how busy are we",
    "what's in the kitchen",
    "how's service",
    "anyone waiting?",
    "how many orders are on the board",
  ])("%s", (text) => {
    expect(parseStaffCommand(text)).toEqual({ kind: "service" });
  });

  it("still reads sold-out questions and commands as before", () => {
    expect(parseStaffCommand("what's sold out?")).toEqual({ kind: "status" });
    expect(parseStaffCommand("we're slammed, add 15 minutes").kind).toBe(
      "busy",
    );
  });

  it("the model may classify it too", () => {
    expect(parseInterpretation('{"kind":"service"}')).toEqual({
      kind: "service",
    });
    expect(parseInterpretation('{"kind":"greeting","thanks":false}')).toEqual({
      kind: "greeting",
      thanks: false,
    });
  });

  it("answers with the live numbers", () => {
    const text = serviceText(
      ctx({
        service: {
          inKitchen: { pending: 2, confirmed: 1, preparing: 2, ready: 1 },
          activeTables: ["Table 2", "Table 5", "Table 7", "Patio"],
          recentlyServedTables: 3,
          waiting: ["Table 4 wants the bill"],
        },
        state: { pausedUntil: null, busyExtraMinutes: 15 },
      }),
    );
    expect(text).toBe(
      [
        "Right now:",
        "• 4 tables have an order on the go: Table 2, Table 5, Table 7 and Patio",
        "• 6 orders in the kitchen: 2 new, 1 accepted, 2 cooking, 1 ready",
        "• 3 more tables were served in the last hour",
        "• Waiting for a person: Table 4 wants the bill",
        "Diners are told food is taking 15 minutes longer.",
      ].join("\n"),
    );
  });

  it("says so plainly on a quiet night", () => {
    const text = serviceText(
      ctx({
        service: {
          inKitchen: { pending: 0, confirmed: 0, preparing: 0, ready: 0 },
          activeTables: [],
          recentlyServedTables: 0,
          waiting: [],
        },
      }),
    );
    expect(text).toBe(
      "Right now:\n• No tables have an order on the go.\n• Nobody is waiting for a person.",
    );
  });

  it("is honest when the numbers couldn't be read", () => {
    expect(serviceText(ctx())).toMatch(/couldn't read the kitchen/);
  });
});

describe("examples", () => {
  it("never suggests a size or spice level as 'the X is out'", () => {
    const text = helpText(ctx().catalog);
    expect(text).not.toContain("The Regular is out");
    expect(text).not.toContain("The Large is out");
    expect(text).toContain("The Extra chutney is out");
    expect(text).toContain("How many tables are live?");
  });
  it("skips options in size, spice and 'Choose one' groups, whatever they're called", () => {
    // Square imports a required size as "Choose one": Regular / Family.
    expect(
      pickExampleOption([
        { name: "Family", groupName: "Choose one" },
        { name: "Half plate", groupName: "Portion" },
        { name: "Extra raita", groupName: "Sides" },
      ])?.name,
    ).toBe("Extra raita");
  });

  it("leaves the add-on example out when only generic ones exist", () => {
    expect(
      pickExampleOption([
        { name: "Regular" },
        { name: "Mild" },
        { name: "Hot" },
      ]),
    ).toBeUndefined();
  });
});
