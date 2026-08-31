/**
 * Tip parsing, kept out of the "use server" module on purpose.
 *
 * A tip is the only number a diner supplies that ends up on a card charge,
 * so its validation is worth testing directly rather than only through a
 * server action. Following the codebase's extract-the-core convention: no
 * `server-only` import here, so a unit test can call it.
 */

/** A mistyped tip is the likeliest way to be charged an unintended amount. */
export const TIP_MAX = 500;

/** Matches what numeric(10,2) can actually hold: at most two decimal places. */
const TIP_PATTERN = /^\d+(\.\d{1,2})?$/;

export type TipResult =
  { ok: true; value: number } | { ok: false; message: string };

export function parseTip(raw: unknown): TipResult {
  if (raw === null || raw === undefined) return { ok: true, value: 0 };

  const text = String(raw).trim();
  if (text === "") return { ok: true, value: 0 };

  if (!TIP_PATTERN.test(text)) {
    // Rejects rather than rounds. Silently turning 4.567 into 4.57 would
    // charge a number the diner never typed.
    return { ok: false, message: "Enter a tip like 4 or 4.50." };
  }

  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > TIP_MAX) {
    return { ok: false, message: `Tip must be between 0 and ${TIP_MAX}.` };
  }

  return { ok: true, value };
}
