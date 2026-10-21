/**
 * "Download all your restaurant's data" (Settings → Your data): which
 * tables go into the file, how each is paged, and how the file is put
 * together.
 *
 * WHAT'S IN IT. The restaurant's own business records, read through the
 * owner's own signed-in (RLS) connection — the same rows the dashboard can
 * show them, nothing the platform keeps for itself. Left out on purpose:
 * push tokens, invite links and diner session tokens (credentials, not
 * records), carts (abandoned baskets), each diner's AI chat (readable only
 * by that diner), and Tableside's own settings and cost records.
 *
 * WHY A STREAM. A busy restaurant's orders and change history can pass the
 * 4.5 MB a Vercel function may return in one piece, so the route writes the
 * file table by table, page by page (src/app/dashboard/settings/export).
 *
 * No `server-only`, so the list and the writer are unit-tested directly;
 * tests/integration/db/data-export.test.ts checks the list against the real
 * schema (every table exists, carries restaurant_id, has the order columns
 * and a members' read policy).
 */

export interface ExportTable {
  /** Table name in the database, and the key in the file. */
  table: string;
  /** Columns to order by, so paging never skips or repeats a row. */
  orderBy: string[];
  /** Columns left out of the file (internal bookkeeping). */
  omit?: string[];
}

export const EXPORT_FORMAT = "tableside-restaurant-export";
export const EXPORT_VERSION = 1;

/** Rows per request: PostgREST's usual ceiling. */
export const EXPORT_PAGE_SIZE = 1000;

export const EXPORT_TABLES: ExportTable[] = [
  // Settings and hours
  { table: "restaurant_settings", orderBy: ["id"] },
  { table: "restaurant_special_hours", orderBy: ["id"] },
  // Menu
  { table: "menus", orderBy: ["id"] },
  { table: "menu_hours", orderBy: ["id"] },
  { table: "categories", orderBy: ["id"] },
  { table: "menu_sections", orderBy: ["menu_id", "category_id"] },
  { table: "menu_items", orderBy: ["id"] },
  { table: "menu_item_nutrition", orderBy: ["menu_item_id"] },
  { table: "menu_item_modifiers", orderBy: ["id"] },
  { table: "ingredients", orderBy: ["id"] },
  { table: "menu_item_ingredients", orderBy: ["id"] },
  { table: "allergens", orderBy: ["id"] },
  { table: "menu_item_allergens", orderBy: ["id"] },
  { table: "menu_translations", orderBy: ["id"] },
  { table: "menu_item_images", orderBy: ["id"] },
  { table: "restaurant_hero_videos", orderBy: ["id"] },
  // Floor and kitchen
  { table: "tables", orderBy: ["id"] },
  { table: "kitchen_stations", orderBy: ["id"] },
  // Orders
  { table: "orders", orderBy: ["id"], omit: ["idempotency_key"] },
  { table: "order_items", orderBy: ["id"] },
  { table: "order_item_modifiers", orderBy: ["id"] },
  { table: "order_status_history", orderBy: ["id"] },
  { table: "order_ticket_groups", orderBy: ["id"] },
  { table: "order_station_done", orderBy: ["order_id", "station_id"] },
  // Money
  { table: "order_payments", orderBy: ["id"] },
  { table: "payment_orders", orderBy: ["payment_id", "order_id"] },
  { table: "payment_refunds", orderBy: ["id"] },
  // Guests
  { table: "reservations", orderBy: ["id"] },
  { table: "table_requests", orderBy: ["id"] },
  { table: "order_feedback", orderBy: ["order_id"] },
  { table: "order_item_feedback", orderBy: ["order_item_id"] },
  // Team and history
  { table: "restaurant_users", orderBy: ["id"] },
  { table: "staff_assistant_commands", orderBy: ["id"] },
  { table: "audit_log", orderBy: ["id"] },
];

/** Drops the omitted columns from a row. */
export function withoutOmitted(
  row: Record<string, unknown>,
  omit: string[] | undefined,
): Record<string, unknown> {
  if (!omit?.length) return row;
  const copy = { ...row };
  for (const column of omit) delete copy[column];
  return copy;
}

/** "desi-dhamaka-data-2026-10-21.json" */
export function exportFilename(slug: string, now: Date): string {
  const safe = slug.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "restaurant";
  return `${safe}-data-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Writes the file as a sequence of chunks: a header, then each section as
 * `"name": [rows...]`. `sections` yields [name, pages of rows]; the file is
 * valid JSON once the generator finishes, and if a page fails the error is
 * thrown before the closing brace, so a cut-off download never parses as a
 * complete file.
 */
export async function* writeExport(
  header: Record<string, unknown>,
  sections: AsyncIterable<[string, AsyncIterable<Record<string, unknown>[]>]>,
): AsyncGenerator<string> {
  const head = JSON.stringify(header);
  // The header object, left open for "data".
  yield `${head.slice(0, -1)},"data":{`;
  let firstSection = true;
  for await (const [name, pages] of sections) {
    yield `${firstSection ? "" : ","}${JSON.stringify(name)}:[`;
    firstSection = false;
    let firstPage = true;
    for await (const rows of pages) {
      if (rows.length === 0) continue;
      yield `${firstPage ? "" : ","}${rows.map((r) => JSON.stringify(r)).join(",")}`;
      firstPage = false;
    }
    yield "]";
  }
  yield "}}";
}
