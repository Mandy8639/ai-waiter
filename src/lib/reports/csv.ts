/**
 * Turning report rows into a CSV a spreadsheet will open correctly.
 *
 * No `server-only` import, following the codebase's extract-the-core
 * convention: escaping is the part of an export that goes wrong, and it is
 * worth testing directly rather than through a route handler.
 */

/**
 * Characters a spreadsheet treats as the start of a formula. A cell
 * beginning with one of these is executed by Excel, LibreOffice and Google
 * Sheets — so a menu item named `=HYPERLINK(...)` becomes a live formula
 * in the reader's spreadsheet rather than text. The export carries
 * restaurant-controlled names, so this is a real path, not a theoretical
 * one.
 */
const FORMULA_PREFIXES = ["=", "+", "@", "\t", "\r"];

/** A plain number, so a legitimate negative value is not mistaken for a formula. */
const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Neutralises a value a spreadsheet would otherwise execute.
 *
 * `-` is deliberately NOT in FORMULA_PREFIXES on its own: a refunded
 * total of `-5.00` is a number, and prefixing it would turn real data into
 * text that no longer sums. Instead anything numeric is passed through
 * untouched, and a non-numeric leading `-` is treated as risky.
 */
function defuseFormula(value: string): string {
  if (value === "" || NUMERIC.test(value)) return value;

  const first = value[0];
  if (FORMULA_PREFIXES.includes(first) || first === "-") {
    // A leading apostrophe is how spreadsheets are told "this is text".
    return `'${value}`;
  }
  return value;
}

/**
 * One CSV field, per RFC 4180: quotes are doubled, and a field is wrapped
 * when it contains a comma, quote, or newline.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";

  const raw = defuseFormula(String(value));

  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function toCsvRow(fields: readonly unknown[]): string {
  return fields.map(escapeCsvField).join(",");
}

/**
 * A complete CSV document.
 *
 * CRLF line endings, which RFC 4180 specifies and Excel is happiest with.
 *
 * The leading BOM is deliberate: without it Excel on Windows reads the
 * file as the local codepage and mangles any non-ASCII name — a menu of
 * "Crème brûlée" arrives as mojibake. The cost is that a few
 * strictly-ASCII parsers surface the BOM as stray characters on the first
 * header; the readers this file is actually for are spreadsheets.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const lines = [toCsvRow(headers), ...rows.map(toCsvRow)];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** A filename that sorts chronologically and never needs quoting. */
export function csvFilename(prefix: string, from: string, to: string): string {
  const day = (iso: string) => iso.slice(0, 10);
  return `${prefix}-${day(from)}-to-${day(to)}.csv`;
}
