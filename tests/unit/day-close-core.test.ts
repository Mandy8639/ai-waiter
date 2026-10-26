import { describe, expect, it } from "vitest";
import {
  dayCloseMethodLabel,
  expectedCash,
  overShortLabel,
  parseCash,
  type DayCloseSummary,
} from "@/lib/reports/day-close-core";
import { dayCloseDoc } from "@/lib/printing/documents";
import { docToText } from "@/lib/printing/star-commands";

const summary: DayCloseSummary = {
  from: "2026-10-26T04:00:00Z",
  to: "2026-10-27T03:30:00Z",
  currency: "USD",
  payments: { count: 3, sales: 90, tips: 12, gross: 102, refunds: 5, net: 97 },
  by_method: [
    {
      method: "card_in_person",
      count: 1,
      sales: 40,
      tips: 6,
      refunds: 0,
      net: 46,
    },
    { method: "cash", count: 2, sales: 50, tips: 6, refunds: 5, net: 51 },
  ],
  cash: { taken: 56, refunded: 5 },
  adjustments: {
    void: { count: 0, amount: 0 },
    comp: { count: 1, amount: 7.5 },
    discount: { count: 0, amount: 0 },
  },
  reversed: { count: 0, amount: 0 },
  orders: 3,
  staff: [{ email: "sam@example.com", count: 3, cash: 56, total: 102 }],
};

const money = (v: number) => `$${v.toFixed(2)}`;

describe("end of day", () => {
  it("expects the float plus cash taken, less cash handed back", () => {
    expect(expectedCash(100, summary)).toBe(151);
  });

  it("says over, short or even, to the cent", () => {
    expect(overShortLabel(2, money)).toBe("Over $2.00");
    expect(overShortLabel(-1.5, money)).toBe("Short $1.50");
    expect(overShortLabel(0.001, money)).toBe("Even");
  });

  it("reads typed cash, refusing nonsense and negatives", () => {
    expect(parseCash("120.5")).toBe(120.5);
    expect(parseCash("")).toBeNull();
    expect(parseCash("-3")).toBeNull();
    expect(parseCash("abc")).toBeNull();
  });

  it("names a card taken at the restaurant apart from one paid online", () => {
    expect(dayCloseMethodLabel("card_in_person")).toBe("Card (in person)");
    expect(dayCloseMethodLabel("cash")).toBe("Cash");
  });

  it("prints the close with the drawer count and the difference", () => {
    const lines = docToText(
      dayCloseDoc(
        {
          id: "c1",
          periodStart: summary.from,
          periodEnd: summary.to,
          openingFloat: 100,
          countedCash: 150,
          expectedCash: 151,
          overShort: -1,
          note: "Gave change twice",
          summary,
        },
        {
          restaurant: {
            name: "Spice Route",
            address: null,
            phone: null,
            timeZone: "America/New_York",
          },
        },
      ),
      48,
    );
    const row = (left: string, right: string) =>
      lines.some((l) => l.startsWith(left) && l.endsWith(right));
    expect(lines.some((l) => l.includes("END OF DAY"))).toBe(true);
    expect(row("Net", "$97.00")).toBe(true);
    expect(row("Card (in person) (1)", "$46.00")).toBe(true);
    expect(row("Comps (1)", "-$7.50")).toBe(true);
    expect(row("Expected", "$151.00")).toBe(true);
    expect(row("Over / short", "Short $1.00")).toBe(true);
    expect(lines.some((l) => l.includes("Gave change twice"))).toBe(true);
  });
});
