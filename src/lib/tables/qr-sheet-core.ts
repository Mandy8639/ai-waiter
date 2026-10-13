/**
 * The printable QR sheet's layout rules (/dashboard/tables/print), with no
 * I/O so they can be tested. No `server-only`, per the extract-the-core
 * convention.
 */

/** Two columns by three rows on an A4 page: cards about 9 cm square. */
export const QR_CARDS_PER_PAGE = 6;

export interface PrintableTable {
  id: string;
  tableNumber: string;
  displayName: string | null;
  isActive: boolean;
}

/**
 * Only active tables print (an inactive table's code doesn't open the
 * menu), in table-number order with numbers compared as numbers ("2"
 * before "10"), split into A4 pages.
 */
export function qrSheetPages<T extends PrintableTable>(
  tables: T[],
  perPage: number = QR_CARDS_PER_PAGE,
): T[][] {
  const active = tables
    .filter((table) => table.isActive)
    .sort((a, b) =>
      a.tableNumber.localeCompare(b.tableNumber, undefined, { numeric: true }),
    );
  const pages: T[][] = [];
  for (let i = 0; i < active.length; i += perPage) {
    pages.push(active.slice(i, i + perPage));
  }
  return pages;
}

/** "Table 4 · Window" — what's printed under each code. */
export function qrCardLabel(table: PrintableTable): string {
  return table.displayName
    ? `Table ${table.tableNumber} · ${table.displayName}`
    : `Table ${table.tableNumber}`;
}
