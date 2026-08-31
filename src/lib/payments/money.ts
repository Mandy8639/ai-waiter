/**
 * The conversion boundary between this app's money and Stripe's.
 *
 * Postgres stores money as `numeric(10,2)` and supabase-js hands it back as
 * a string ("12.34"); Stripe works exclusively in integer minor units
 * (1234). Getting that wrong does not throw — it silently charges the wrong
 * amount — so the conversion lives in one tested place rather than being
 * inlined wherever a charge is created.
 *
 * Deliberately string-based rather than `amount * 100`: in IEEE-754,
 * 12.34 * 100 is 1233.9999999999998, and rounding that happens to work
 * today is the kind of thing that fails on one unlucky value in
 * production. Parsing the digits directly cannot drift.
 *
 * Pure and dependency-free, so it stays unit-testable without a server
 * runtime — the same convention as src/lib/ai/env-helpers.ts.
 */

/** Currencies Stripe treats as having no minor unit at all: ¥500 is charged as 500, not 50000. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/**
 * Currencies with three minor digits. Deliberately unsupported: the orders
 * schema is numeric(10,2), so a third decimal place cannot be represented
 * upstream of here — accepting one would mean quietly charging a rounded
 * amount. Better to refuse loudly at the boundary.
 */
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export class UnsupportedCurrencyError extends Error {
  constructor(currency: string) {
    super(
      `Currency ${currency} uses three decimal places, which orders.numeric(10,2) cannot represent. ` +
        `Supporting it requires widening the money columns first.`,
    );
    this.name = "UnsupportedCurrencyError";
  }
}

export class InvalidAmountError extends Error {
  constructor(amount: string, currency: string) {
    super(`Amount "${amount}" is not valid for ${currency}.`);
    this.name = "InvalidAmountError";
  }
}

/** How many digits after the decimal point this currency's minor unit uses. */
export function minorUnitDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (THREE_DECIMAL_CURRENCIES.has(code))
    throw new UnsupportedCurrencyError(code);
  return ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
}

const AMOUNT_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * "12.34" + USD -> 1234.  "500" + JPY -> 500.
 *
 * Throws rather than rounding when the value carries more precision than
 * the currency can hold, because silently dropping a fraction of a
 * customer's money is worse than a loud failure.
 */
export function toMinorUnits(
  amount: string | number,
  currency: string,
): number {
  const digits = minorUnitDigits(currency);
  const raw =
    typeof amount === "number" ? amount.toFixed(digits) : amount.trim();

  const match = AMOUNT_PATTERN.exec(raw);
  if (!match) throw new InvalidAmountError(String(amount), currency);

  const [, sign, whole, fraction = ""] = match;
  if (fraction.replace(/0+$/, "").length > digits) {
    throw new InvalidAmountError(String(amount), currency);
  }

  const padded = fraction.padEnd(digits, "0").slice(0, digits);
  const combined = Number(`${whole}${padded}`);
  if (!Number.isSafeInteger(combined)) {
    throw new InvalidAmountError(String(amount), currency);
  }

  return sign === "-" ? -combined : combined;
}

/** The inverse, for displaying a Stripe amount back to a person: 1234 + USD -> "12.34". */
export function fromMinorUnits(minorUnits: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  if (!Number.isInteger(minorUnits)) {
    throw new InvalidAmountError(String(minorUnits), currency);
  }

  const negative = minorUnits < 0;
  const absolute = Math.abs(minorUnits)
    .toString()
    .padStart(digits + 1, "0");
  const whole = absolute.slice(0, absolute.length - digits) || "0";
  const fraction =
    digits === 0 ? "" : `.${absolute.slice(absolute.length - digits)}`;

  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * Sums order totals the way money must be summed — in integer minor units,
 * never by adding floats and rounding at the end.
 */
export function sumMinorUnits(
  amounts: (string | number)[],
  currency: string,
): number {
  return amounts.reduce<number>(
    (running, amount) => running + toMinorUnits(amount, currency),
    0,
  );
}
