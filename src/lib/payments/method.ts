/**
 * How each payment method reads to a person. The database stores short
 * codes (order_payments_method_valid); these are what Reports, the CSV
 * export and a diner's receipt show instead.
 *
 *   card           a card on the diner's own phone, through Stripe.
 *   cash           notes taken by staff and recorded on Settle up.
 *   card_terminal  the restaurant's own card machine at the register,
 *                  recorded on Settle up. Nothing went through Stripe.
 *   comp           $0, recorded by the database when a manager's voids,
 *                  comps or discounts leave nothing to pay (20261113090000).
 */
export type InPersonMethod = "cash" | "card_terminal";

const LABELS: Record<string, string> = {
  card: "Card",
  cash: "Cash",
  card_terminal: "Card machine",
  comp: "Comped",
};

export function paymentMethodLabel(method: string): string {
  return LABELS[method] ?? method;
}

/** The payments staff record themselves, and so may also reverse. */
export function isInPersonMethod(method: string): method is InPersonMethod {
  return method === "cash" || method === "card_terminal";
}
