import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  kitchenTicketHtml,
  ordersToAutoPrint,
  ticketTime,
  type TicketOrder,
} from "@/lib/kitchen/ticket-core";

const order: TicketOrder = {
  orderNumber: 42,
  tableLabel: "Table 5",
  createdAt: "2026-10-15T23:05:00.000Z",
  customerNote: "Birthday — bring the cake last",
  items: [
    {
      quantity: 2,
      itemName: "Butter chicken",
      modifiers: [{ optionName: "Extra naan" }],
      spicePreference: "very_hot",
      notes: "no onions",
    },
    {
      quantity: 1,
      itemName: "Mango lassi",
      modifiers: [],
      spicePreference: null,
      notes: null,
    },
  ],
};

const options = {
  restaurantName: "Nashta",
  timeZone: "America/New_York",
  paper: "80mm" as const,
};

describe("kitchenTicketHtml", () => {
  const html = kitchenTicketHtml(order, options);

  it("leads with what the line needs: order number, table, time, count", () => {
    expect(html).toContain("#42");
    expect(html).toContain("Table 5");
    // 23:05 UTC is 7:05 PM in New York in October.
    expect(html).toContain("7:05 PM");
    expect(html).toContain("3 items");
  });

  it("prints every dish with its add-ons, spice and note", () => {
    expect(html).toContain("Butter chicken");
    expect(html).toContain("+ Extra naan");
    expect(html).toContain("Spice: Very hot");
    expect(html).toContain("Note: no onions");
    expect(html).toContain("Mango lassi");
    expect(html).toContain("Order note:");
  });

  it("sizes the page for the receipt paper", () => {
    expect(html).toContain("size: 80mm auto");
    expect(kitchenTicketHtml(order, { ...options, paper: "58mm" })).toContain(
      "size: 58mm auto",
    );
  });

  it("marks a hand-printed second copy, so it isn't cooked twice", () => {
    expect(html).not.toContain("REPRINT");
    expect(kitchenTicketHtml(order, { ...options, reprint: true })).toContain(
      "REPRINT",
    );
  });

  it("escapes what diners typed", () => {
    const sneaky = kitchenTicketHtml(
      {
        ...order,
        customerNote: "<script>alert(1)</script>",
        items: [{ ...order.items[0], notes: '<img src=x onerror="x">' }],
      },
      options,
    );
    expect(sneaky).not.toContain("<script>alert");
    expect(sneaky).not.toContain("<img");
    expect(sneaky).toContain("&lt;script&gt;");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("ticketTime", () => {
  it("is blank for a bad timestamp rather than 'Invalid Date'", () => {
    expect(ticketTime("not a date", "UTC")).toBe("");
  });
});

describe("ordersToAutoPrint", () => {
  it("prints only new orders still waiting to be accepted", () => {
    const fresh = [
      { id: "a", status: "pending" },
      { id: "b", status: "pending" },
      { id: "c", status: "confirmed" },
    ];
    expect(ordersToAutoPrint(fresh, new Set(["a"])).map((o) => o.id)).toEqual([
      "b",
    ]);
  });

  it("never reprints what was already on the board", () => {
    const fresh = [{ id: "a", status: "pending" }];
    expect(ordersToAutoPrint(fresh, new Set(["a"]))).toEqual([]);
  });
});
