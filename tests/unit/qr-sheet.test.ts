import { describe, expect, it } from "vitest";
import {
  QR_CARDS_PER_PAGE,
  qrCardLabel,
  qrSheetPages,
} from "@/lib/tables/qr-sheet-core";

/**
 * The printable QR sheet (/dashboard/tables/print): which tables print,
 * in what order, how many to an A4 page, and what's written under each.
 */

const table = (n: string, opts: { active?: boolean; name?: string } = {}) => ({
  id: `t${n}`,
  tableNumber: n,
  displayName: opts.name ?? null,
  isActive: opts.active ?? true,
});

describe("qrSheetPages", () => {
  it("prints only active tables, in number order (2 before 10)", () => {
    const pages = qrSheetPages([
      table("10"),
      table("2"),
      table("3", { active: false }),
      table("1"),
    ]);
    expect(pages.flat().map((t) => t.tableNumber)).toEqual(["1", "2", "10"]);
  });

  it("puts six on an A4 page and starts a new page after that", () => {
    const tables = Array.from({ length: 14 }, (_, i) => table(String(i + 1)));
    const pages = qrSheetPages(tables);
    expect(QR_CARDS_PER_PAGE).toBe(6);
    expect(pages.map((p) => p.length)).toEqual([6, 6, 2]);
  });

  it("has nothing to print when no table is active", () => {
    expect(qrSheetPages([table("1", { active: false })])).toEqual([]);
    expect(qrSheetPages([])).toEqual([]);
  });
});

describe("qrCardLabel", () => {
  it("names the table, and its display name when it has one", () => {
    expect(qrCardLabel(table("4"))).toBe("Table 4");
    expect(qrCardLabel(table("4", { name: "Window" }))).toBe(
      "Table 4 · Window",
    );
  });
});
