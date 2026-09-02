import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePaymentError } from "@/lib/payments/errors";

/**
 * Every payment error code the database can raise must have copy written
 * for it.
 *
 * This exists because the twelve REFUND_* codes shipped without any, so
 * every refund failure — the wrong role, too large an amount, a payment
 * that never settled — showed the same "Something went wrong. Please try
 * again." That is the worst possible message for a money operation: it
 * tells the reader nothing about which rule they hit, or whether trying
 * again could ever work.
 *
 * Reading the migrations rather than listing codes here is the point. A
 * hand-kept list would drift the moment someone adds a code, which is
 * exactly how the gap appeared in the first place.
 */

const GENERIC = "Something went wrong. Please try again.";
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function codesRaisedInMigrations(): string[] {
  const codes = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const match of sql.matchAll(
      /raise exception '((?:PAYMENT|REFUND)_[A-Z_]+)/g,
    )) {
      codes.add(match[1]);
    }
  }
  return [...codes].sort();
}

describe("payment error copy", () => {
  const codes = codesRaisedInMigrations();

  it("finds the codes to check", () => {
    // Guards the guard: a broken regex would make every assertion below
    // pass over an empty list.
    expect(codes.length).toBeGreaterThan(30);
  });

  it.each(codes)("has copy for %s", (code) => {
    expect(parsePaymentError(`${code}: some detail`)).not.toBe(GENERIC);
  });

  it("still falls back for an unrecognised code", () => {
    expect(parsePaymentError("PAYMENT_SOMETHING_NEW: detail")).toBe(GENERIC);
  });

  it("falls back for a message with no code at all", () => {
    expect(parsePaymentError("connection terminated unexpectedly")).toBe(
      GENERIC,
    );
  });
});
