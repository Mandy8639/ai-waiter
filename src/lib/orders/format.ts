/** Orders carry their own currency (copied from the restaurant at submission time — see docs/database.md#orders-batch-5), so formatting always uses the order's value, never a hardcoded "USD". */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
