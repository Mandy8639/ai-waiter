import { NextResponse } from "next/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observability/report";
import {
  EXPORT_FORMAT,
  EXPORT_PAGE_SIZE,
  EXPORT_TABLES,
  EXPORT_VERSION,
  exportFilename,
  withoutOmitted,
  writeExport,
} from "@/lib/export/export-core";

/**
 * "Download all your restaurant's data": one JSON file, owners only.
 *
 * Read through the owner's own RLS connection, never the service role, so
 * the file can't hold anything the database wouldn't show them anyway.
 * Streamed table by table (export-core.ts explains why). A route handler
 * because the browser has to receive a file.
 */

// A big restaurant's history takes a while to page through.
export const maxDuration = 300;

type Row = Record<string, unknown>;
type Page = { data: Row[] | null; error: { message: string } | null };
type Query = {
  eq: (c: string, v: string) => Query;
  in: (c: string, v: string[]) => Query;
  order: (c: string, o: { ascending: boolean }) => Query;
  range: (from: number, to: number) => Promise<Page>;
};

export async function GET() {
  const { restaurant } = await requireCurrentRestaurant();
  // Everything, staff and money included: the owner's decision to take.
  if (restaurant.role !== "owner") {
    return new NextResponse("Not found", { status: 404 });
  }

  const supabase = await createClient();
  // The tables here postdate database.types.ts in places; one untyped door.
  const from = (table: string) =>
    (
      supabase.from.bind(supabase) as unknown as (t: string) => {
        select: (c: string) => Query;
      }
    )(table).select("*");

  const [{ data: profile }, { data: staff }] = await Promise.all([
    supabase.from("restaurants").select("*").eq("id", restaurant.id).single(),
    supabase.rpc("get_restaurant_staff", {
      target_restaurant_id: restaurant.id,
    }),
  ]);

  const now = new Date();
  const header = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    restaurant: profile,
    staff: staff ?? [],
    notes: [
      "Every section under data is one table: an array of rows, each row as stored.",
      "Money is in the restaurant's currency. Card details never reach Tableside; Stripe holds them.",
      "Left out: push tokens, invite links and diner session tokens (credentials), carts, and diners' individual AI chats.",
      "Photos and videos are listed by storage path; the files themselves aren't inside this file.",
    ],
  };

  async function* pages(
    table: string,
    orderBy: string[],
    filter: (q: Query) => Query,
  ): AsyncGenerator<Row[]> {
    for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
      let q = filter(from(table));
      for (const column of orderBy) q = q.order(column, { ascending: true });
      const { data, error } = await q.range(
        offset,
        offset + EXPORT_PAGE_SIZE - 1,
      );
      // Thrown, not skipped: a file missing a table must not look whole.
      if (error) throw new Error(`${table}: ${error.message}`);
      const rows = data ?? [];
      yield rows;
      if (rows.length < EXPORT_PAGE_SIZE) return;
    }
  }

  const ownRows = (q: Query) => q.eq("restaurant_id", restaurant.id);

  async function* sections(): AsyncGenerator<[string, AsyncIterable<Row[]>]> {
    const modifierIds: string[] = [];
    for (const spec of EXPORT_TABLES) {
      async function* cleaned(): AsyncGenerator<Row[]> {
        for await (const rows of pages(spec.table, spec.orderBy, ownRows)) {
          if (spec.table === "menu_item_modifiers") {
            modifierIds.push(...rows.map((r) => String(r.id)));
          }
          yield rows.map((r) => withoutOmitted(r, spec.omit));
        }
      }
      yield [spec.table, cleaned()];
    }
    // Modifier options carry no restaurant_id: they belong to a modifier.
    async function* options(): AsyncGenerator<Row[]> {
      for (let i = 0; i < modifierIds.length; i += 100) {
        const ids = modifierIds.slice(i, i + 100);
        yield* pages("modifier_options", ["id"], (q) =>
          q.in("modifier_id", ids),
        );
      }
    }
    yield ["modifier_options", options()];
  }

  const encoder = new TextEncoder();
  const chunks = writeExport(header, sections());
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (error) {
        reportError(error, {
          scope: "settings.export",
          extra: { restaurantId: restaurant.id },
        });
        // The download fails rather than ending as a short, valid-looking file.
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(restaurant.slug, now)}"`,
      "Cache-Control": "no-store",
    },
  });
}
