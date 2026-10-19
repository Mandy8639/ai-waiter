// AI cost per restaurant: weeks, totals and the words on the Admin page
// and in the Monday email (src/lib/admin/cost-report-core.ts and
// renderWeeklyAiCost in src/lib/email/templates.ts).
import { describe, expect, it } from "vitest";
import {
  costTotals,
  formatSpend,
  parseCostRows,
  perChat,
  weekBounds,
  weekKey,
  weekLabel,
  weeklySubject,
} from "@/lib/admin/cost-report-core";
import { renderWeeklyAiCost } from "@/lib/email/templates";

describe("weekBounds", () => {
  it("runs Monday to Monday in UTC", () => {
    // Wednesday 21 Oct 2026.
    const { thisWeek, lastWeek } = weekBounds(new Date("2026-10-21T15:00:00Z"));
    expect(thisWeek.from.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(lastWeek.from.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(lastWeek.to.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(weekKey(lastWeek)).toBe("2026-10-12");
    expect(weekLabel(lastWeek)).toBe("12–18 Oct");
  });

  it("treats Sunday as the end of the week, and Monday as the start", () => {
    expect(
      weekBounds(new Date("2026-10-25T23:00:00Z")).thisWeek.from.toISOString(),
    ).toBe("2026-10-19T00:00:00.000Z");
    expect(
      weekBounds(new Date("2026-10-19T00:30:00Z")).thisWeek.from.toISOString(),
    ).toBe("2026-10-19T00:00:00.000Z");
  });

  it("names a week across two months with both", () => {
    const { lastWeek } = weekBounds(new Date("2026-11-04T12:00:00Z"));
    expect(weekLabel(lastWeek)).toBe("26 Oct–1 Nov");
  });
});

const rows = parseCostRows([
  {
    restaurant_id: "r1",
    restaurant_name: "Sample Kitchen",
    waiter_chats: "800",
    uses: "820",
    cost_usd: "3.2",
    unpriced: "0",
  },
  {
    restaurant_id: "r2",
    restaurant_name: "Corner Cafe",
    waiter_chats: "50",
    uses: "50",
    cost_usd: "0",
    unpriced: "2",
  },
  {
    restaurant_id: null,
    restaurant_name: null,
    waiter_chats: "0",
    uses: "30",
    cost_usd: "0.2",
    unpriced: "0",
  },
]);

describe("totals", () => {
  it("names platform use, and adds everything up", () => {
    expect(rows[2].name).toBe("Admin Tests and safety checks");
    expect(costTotals(rows)).toEqual({
      costUsd: 3.4000000000000004,
      waiterChats: 850,
      restaurants: 2,
      perChatUsd: 3.4000000000000004 / 850,
      unpriced: 2,
    });
  });

  it("words money and cost per chat", () => {
    expect(formatSpend(3.4)).toBe("$3.40");
    expect(formatSpend(0.004)).toBe("0.4¢");
    expect(formatSpend(0)).toBe("$0.00");
    expect(perChat(rows[0])).toBe("0.4¢");
    expect(perChat(rows[2])).toBe("–");
  });

  it("puts the answer in the subject, as the plan's example does", () => {
    expect(weeklySubject(costTotals(rows))).toBe(
      "Tableside AI last week: $3.40 across 2 restaurants, 0.4¢ per chat",
    );
    expect(weeklySubject(costTotals([]))).toBe(
      "Tableside AI last week: no AI use",
    );
  });
});

describe("the Monday email", () => {
  const message = renderWeeklyAiCost({
    subject: "Tableside AI last week: $3.40 across 2 restaurants",
    weekLabel: "12–18 Oct",
    totalCost: "$3.40",
    waiterChats: 850,
    restaurants: 2,
    perChat: "0.4¢",
    rows: [
      { name: "Sample <Kitchen>", chats: 800, cost: "$3.20" },
      { name: "Corner Cafe", chats: 50, cost: "$0.00" },
    ],
    unpriced: 2,
    adminUrl: "https://tableside.menu/admin",
  });

  it("says what it cost, per chat, and links to the Admin page", () => {
    expect(message.text).toMatch(/cost \$3\.40 in the week of 12–18 Oct/);
    expect(message.text).toMatch(/850 messages, 0\.4¢ each/);
    expect(message.text).toMatch(/2 uses came back without a cost/);
    expect(message.html).toContain("https://tableside.menu/admin");
  });

  it("escapes restaurant names", () => {
    expect(message.html).toContain("Sample &lt;Kitchen&gt;");
    expect(message.html).not.toContain("Sample <Kitchen>");
  });
});
