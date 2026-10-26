import { z } from "zod";

/**
 * Voids, comps and discounts on Settle up (20261113090000): the reasons
 * staff pick from, the shape of a request, and what the database's refusals
 * say to a person. No `server-only`, per the extract-the-core convention.
 *
 *   void      a dish taken off: rung in by mistake, never made, out of stock
 *   comp      a dish given free: it was made, the house is paying for it
 *   discount  money off the whole order, as a percentage or an amount
 */

export type AdjustmentKind = "void" | "comp" | "discount";

export const OTHER_REASON = "Other";

export const ADJUSTMENT_REASONS: Record<AdjustmentKind, string[]> = {
  void: [
    "Entered by mistake",
    "Guest changed their mind",
    "Out of stock",
    OTHER_REASON,
  ],
  comp: ["Quality issue", "Long wait", "On the house", OTHER_REASON],
  discount: [
    "Regular guest",
    "Staff meal",
    "Promotion",
    "Service recovery",
    "Walked out",
    OTHER_REASON,
  ],
};

export const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = {
  void: "Voided",
  comp: "Comped",
  discount: "Discount",
};

const reason = z
  .string()
  .trim()
  .min(1, "Give a reason.")
  .max(200, "Keep the reason under 200 characters.");

export const adjustSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["void", "comp"]),
    restaurantId: z.uuid(),
    orderId: z.uuid(),
    itemId: z.uuid(),
    quantity: z.number().int().min(1).max(999),
    reason,
  }),
  z.object({
    kind: z.literal("discount"),
    restaurantId: z.uuid(),
    orderId: z.uuid(),
    percent: z.number().gt(0).max(100).nullable(),
    amount: z.number().gt(0).max(1_000_000).nullable(),
    reason,
  }),
]);

export type AdjustInput = z.input<typeof adjustSchema>;

/**
 * The reason to store: the picked preset, or what was typed for "Other".
 * Null when "Other" was picked and nothing typed.
 */
export function chosenReason(picked: string, typed: string): string | null {
  if (picked !== OTHER_REASON) return picked;
  const text = typed.trim();
  return text.length > 0 ? text : null;
}

/** A typed money or percent value, or null if it isn't a positive number. */
export function parsePositive(value: string): number | null {
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

const MESSAGES: Record<string, string> = {
  ADJUST_FORBIDDEN:
    "A manager has to approve this: ask them to enter their PIN.",
  ADJUST_CANCELLED: "That order was cancelled.",
  ADJUST_PAYMENT_STARTED:
    "A payment for this order has already started. Finish or cancel it first.",
  ADJUST_SPLIT_OPEN:
    "The guests are splitting this bill on their phones. It can't be changed until the split is cancelled.",
  ADJUST_NOT_FOUND: "That wasn't found. Refresh and try again.",
};

/** What a refusal from adjust_order() / remove_order_adjustment() says to a person. */
export function adjustmentErrorMessage(raw: string): string {
  const match = /^(ADJUST_[A-Z_]+):\s*(.*)$/.exec(raw);
  if (!match) return "Couldn't change the bill. Try again.";
  const [, code, detail] = match;
  if (code === "ADJUST_INVALID") {
    return detail.charAt(0).toUpperCase() + detail.slice(1) + ".";
  }
  return MESSAGES[code] ?? "Couldn't change the bill. Try again.";
}
