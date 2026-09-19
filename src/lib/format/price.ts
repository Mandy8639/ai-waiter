/**
 * Formatting a price for display, in the restaurant's own currency.
 *
 * Every diner-facing price used to be formatted as USD regardless of the
 * restaurant's `currency` column, while the AI waiter (which reads the
 * currency from the database) quoted the right one — so a restaurant
 * pricing in euros would have seen a chat saying €9.99 next to a menu
 * saying $9.99. One formatter, fed the restaurant's currency, removes the
 * disagreement.
 *
 * The locale is pinned rather than left to the runtime default. These
 * strings are rendered on the server and again in client components; a
 * server in one locale and a phone in another would format the same number
 * differently, which React reports as a hydration mismatch. The app's copy
 * is English, so the numbers follow it.
 *
 * Pure and free of `server-only`, per this codebase's extract-the-core
 * convention, so it can be unit-tested and used on either side.
 */

const LOCALE = "en-US";
const CURRENCY_CODE = /^[A-Z]{3}$/;

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat | null {
  if (!CURRENCY_CODE.test(currency)) return null;
  let formatter = formatters.get(currency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(LOCALE, {
        style: "currency",
        currency,
      });
    } catch {
      // A syntactically valid code the runtime does not know — rare, but
      // a menu should not crash over it.
      return null;
    }
    formatters.set(currency, formatter);
  }
  return formatter;
}

export function formatPrice(amount: number, currency = "USD"): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const formatter = formatterFor(currency);
  if (formatter) return formatter.format(value);
  // Never guess a symbol for a code we cannot format: show the code itself.
  return `${value.toFixed(2)} ${currency}`;
}
