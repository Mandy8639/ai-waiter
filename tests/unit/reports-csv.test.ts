import { describe, expect, it } from "vitest";
import {
  csvFilename,
  escapeCsvField,
  toCsv,
  toCsvRow,
} from "@/lib/reports/csv";

/**
 * Escaping is where a CSV export goes wrong, and the failure is quiet: a
 * file that opens, looks plausible, and has the columns shifted by one.
 */

describe("escapeCsvField", () => {
  it("leaves an ordinary value alone", () => {
    expect(escapeCsvField("chicken tikka masala")).toBe("chicken tikka masala");
  });

  it("quotes a value containing a comma, or the columns shift", () => {
    expect(escapeCsvField("Table 1, window")).toBe('"Table 1, window"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvField('the "special"')).toBe('"the ""special"""');
  });

  it("quotes a value containing a newline", () => {
    expect(escapeCsvField("line one\nline two")).toBe('"line one\nline two"');
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });

  it("keeps a zero, which is a real figure and not an absence", () => {
    expect(escapeCsvField(0)).toBe("0");
  });
});

describe("formula injection", () => {
  it("defuses a value a spreadsheet would execute", () => {
    // A menu item named this way becomes a live formula in the reader's
    // spreadsheet. Restaurant-controlled names reach this export, so the
    // path is real.
    expect(escapeCsvField('=HYPERLINK("http://evil","click")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""click"")"',
    );
  });

  it("defuses the other formula starters", () => {
    expect(escapeCsvField("+1+1")).toBe("'+1+1");
    expect(escapeCsvField("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("leaves a negative number alone, because it is data", () => {
    // The naive fix — prefix anything starting with "-" — turns a refunded
    // total into text that no longer sums.
    expect(escapeCsvField("-5.00")).toBe("-5.00");
    expect(escapeCsvField(-5)).toBe("-5");
  });

  it("still defuses a non-numeric value starting with a dash", () => {
    // Prefixed but not quoted: a single quote is not a CSV metacharacter,
    // so wrapping would add noise without adding safety.
    expect(escapeCsvField("-cmd|'/c calc'")).toBe("'-cmd|'/c calc'");
  });
});

describe("toCsv", () => {
  it("writes a header row and CRLF line endings", () => {
    const csv = toCsv(["a", "b"], [[1, 2]]);
    expect(csv).toContain("a,b\r\n1,2\r\n");
  });

  it("starts with a BOM so Excel does not mangle non-ASCII names", () => {
    expect(toCsv(["item"], [["Crème brûlée"]]).charCodeAt(0)).toBe(0xfeff);
  });

  it("handles no rows without producing a headerless file", () => {
    const csv = toCsv(["a", "b"], []);
    expect(csv).toContain("a,b");
  });
});

describe("toCsvRow", () => {
  it("joins fields with commas", () => {
    expect(toCsvRow(["x", 1, null])).toBe("x,1,");
  });
});

describe("csvFilename", () => {
  it("names the file by its range, so downloads sort chronologically", () => {
    expect(
      csvFilename("payments", "2026-09-01T04:00:00Z", "2026-09-03T04:00:00Z"),
    ).toBe("payments-2026-09-01-to-2026-09-03.csv");
  });
});
