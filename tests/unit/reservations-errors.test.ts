import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReservationError } from "@/lib/reservations/errors";

/**
 * The reservations counterpart to tests/unit/payments-errors.test.ts, and
 * for the same reason: twelve REFUND_* codes once shipped with no copy at
 * all, so every failure rendered the same useless sentence. Reading the
 * migrations rather than listing codes here is the point — a hand-kept
 * list drifts the moment someone adds a code.
 */

const GENERIC = "Something went wrong. Please try again.";
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function reservationCodesInMigrations(): string[] {
  const codes = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const match of sql.matchAll(
      /raise exception '(RESERVATION_[A-Z_]+)/g,
    )) {
      codes.add(match[1]);
    }
  }
  return [...codes].sort();
}

describe("reservation error copy", () => {
  const codes = reservationCodesInMigrations();

  it("finds the codes to check", () => {
    // Guards the guard: a broken regex would make every assertion below
    // pass over an empty list.
    expect(codes.length).toBeGreaterThan(10);
  });

  it.each(codes)("has copy for %s", (code) => {
    expect(parseReservationError(`${code}: some detail`)).not.toBe(GENERIC);
  });

  it("still falls back for an unrecognised code", () => {
    expect(parseReservationError("RESERVATION_SOMETHING_NEW: detail")).toBe(
      GENERIC,
    );
  });

  it("falls back for a message with no code at all", () => {
    expect(parseReservationError("connection terminated")).toBe(GENERIC);
  });
});
