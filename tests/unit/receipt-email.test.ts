import { describe, expect, it } from "vitest";
import { renderReceiptEmail } from "@/lib/email/templates";

const base = {
  restaurantName: "Spice <Route>",
  restaurantAddress: "12 Main St, Newark, NJ",
  currency: "USD",
  paidLabel: "Oct 26, 2026, 7:45 PM",
  methodLabel: "Cash",
  lines: [{ name: "Chicken Biryani", quantity: 2, amount: 25 }],
  amount: 27.5,
  tip: 4,
  refunded: 0,
  net: 31.5,
};

describe("the receipt email", () => {
  it("is the receipt itself: dishes, bill, tip and what was paid", () => {
    const email = renderReceiptEmail(base);
    expect(email.subject).toBe("Your receipt from Spice <Route>");
    expect(email.html).toContain("2 × Chicken Biryani");
    expect(email.html).toContain("$27.50");
    expect(email.html).toContain("Paid · Cash");
    expect(email.html).toContain("$31.50");
    expect(email.text).toContain("Tip  $4.00");
  });

  it("escapes what the restaurant typed", () => {
    const email = renderReceiptEmail(base);
    expect(email.html).toContain("Spice &lt;Route&gt;");
    expect(email.html).not.toContain("<Route>");
  });

  it("shows a refund, and leaves out a tip of nothing", () => {
    const email = renderReceiptEmail({
      ...base,
      tip: 0,
      refunded: 5,
      net: 22.5,
    });
    expect(email.html).toContain("Refunded");
    expect(email.html).toContain("-$5.00");
    expect(email.text).not.toContain("Tip");
  });
});
