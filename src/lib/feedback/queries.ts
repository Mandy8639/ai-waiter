import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  isFeedbackState,
  summarizeFeedback,
  tallyDishes,
  type DishTally,
  type FeedbackState,
  type FeedbackSummary,
} from "./core";

// database.types.ts predates 20261006090000, so the new tables and
// functions are reached through untyped handles.
type Client = Awaited<ReturnType<typeof createClient>>;

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

interface Query<Row> {
  select(columns: string): Query<Row>;
  eq(column: string, value: unknown): Query<Row>;
  in(column: string, values: unknown[]): Query<Row>;
  gte(column: string, value: unknown): Query<Row>;
  order(column: string, options: { ascending: boolean }): Query<Row>;
  limit(n: number): Query<Row>;
  then<T>(
    resolve: (r: {
      data: Row[] | null;
      error: { message: string } | null;
    }) => T,
  ): Promise<T>;
}

function from<Row>(supabase: Client, table: string): Query<Row> {
  return (supabase as unknown as { from: (t: string) => Query<Row> }).from(
    table,
  );
}

// For the diner ---------------------------------------------------------------

/**
 * Where this diner stands with this order's feedback. "not_yours" for
 * anyone but the diner who ordered — including staff opening the page —
 * so the form is only ever shown to the person it's for.
 */
export async function getMyFeedbackState(
  orderId: string,
): Promise<{ state: FeedbackState; rating: number | null }> {
  const supabase = await createClient();
  const { data } = await (supabase.rpc.bind(supabase) as unknown as Rpc)(
    "get_my_order_feedback_state",
    { p_order_id: orderId },
  );
  const row = (
    (data ?? []) as Array<{
      feedback_state: string;
      feedback_rating: number | null;
    }>
  )[0];
  if (!row || !isFeedbackState(row.feedback_state)) {
    return { state: "not_yours", rating: null };
  }
  return { state: row.feedback_state, rating: row.feedback_rating };
}

// For the owner ---------------------------------------------------------------

export interface FeedbackEntry {
  orderId: string;
  orderNumber: number | null;
  tableLabel: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  dishes: Array<{ dishName: string; liked: boolean }>;
}

export interface FeedbackOverview {
  days: number;
  summary: FeedbackSummary;
  /** Served orders in the same period, for the response rate. */
  servedOrders: number;
  entries: FeedbackEntry[];
  dishes: DishTally[];
}

/**
 * Dish names for the voted order lines, fetched in batches: a month of
 * votes at a busy restaurant is more ids than one request URL can carry.
 */
async function orderItemNames(
  supabase: Client,
  ids: string[],
): Promise<{ data: Array<{ id: string; item_name: string }> }> {
  const out: Array<{ id: string; item_name: string }> = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase
      .from("order_items")
      .select("id, item_name")
      .in("id", ids.slice(i, i + 200));
    out.push(...(data ?? []));
  }
  return { data: out };
}

/** How many entries the page lists; the summary counts all of them. */
const LIST_LIMIT = 100;

export async function getFeedbackOverview(
  restaurantId: string,
  days: number,
): Promise<FeedbackOverview> {
  const supabase = await createClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: feedback }, { data: votes }, { count: servedOrders }] =
    await Promise.all([
      from<{
        order_id: string;
        table_id: string;
        rating: number;
        comment: string | null;
        created_at: string;
      }>(supabase, "order_feedback")
        .select("order_id, table_id, rating, comment, created_at")
        .eq("restaurant_id", restaurantId)
        .gte("created_at", since)
        .order("created_at", { ascending: false }),
      from<{
        order_id: string;
        order_item_id: string;
        menu_item_id: string | null;
        liked: boolean;
      }>(supabase, "order_item_feedback")
        .select("order_id, order_item_id, menu_item_id, liked")
        .eq("restaurant_id", restaurantId)
        .gte("created_at", since),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", restaurantId)
        .eq("status", "served")
        .gte("created_at", since),
    ]);

  const rows = feedback ?? [];
  const listed = rows.slice(0, LIST_LIMIT);
  const orderIds = listed.map((r) => r.order_id);
  const tableIds = [...new Set(listed.map((r) => r.table_id))];
  const itemIds = (votes ?? []).map((v) => v.order_item_id);

  const [{ data: orders }, { data: tables }, { data: items }] =
    await Promise.all([
      orderIds.length
        ? supabase.from("orders").select("id, order_number").in("id", orderIds)
        : Promise.resolve({
            data: [] as { id: string; order_number: number }[],
          }),
      tableIds.length
        ? supabase
            .from("tables")
            .select("id, table_number, display_name")
            .in("id", tableIds)
        : Promise.resolve({
            data: [] as {
              id: string;
              table_number: string;
              display_name: string | null;
            }[],
          }),
      orderItemNames(supabase, itemIds),
    ]);

  const orderNumber = new Map(
    (orders ?? []).map((o) => [o.id, o.order_number]),
  );
  const tableLabel = new Map(
    (tables ?? []).map((t) => [
      t.id,
      t.display_name || `Table ${t.table_number}`,
    ]),
  );
  const dishName = new Map((items ?? []).map((i) => [i.id, i.item_name]));

  const votesByOrder = new Map<
    string,
    Array<{ dishName: string; liked: boolean }>
  >();
  for (const v of votes ?? []) {
    const list = votesByOrder.get(v.order_id) ?? [];
    list.push({
      dishName: dishName.get(v.order_item_id) ?? "A dish",
      liked: v.liked,
    });
    votesByOrder.set(v.order_id, list);
  }

  return {
    days,
    summary: summarizeFeedback(
      rows.map((r) => ({ rating: r.rating, createdAt: r.created_at })),
    ),
    servedOrders: servedOrders ?? 0,
    entries: listed.map((r) => ({
      orderId: r.order_id,
      orderNumber: orderNumber.get(r.order_id) ?? null,
      tableLabel: tableLabel.get(r.table_id) ?? "A table",
      rating: r.rating,
      comment: r.comment,
      createdAt: r.created_at,
      dishes: votesByOrder.get(r.order_id) ?? [],
    })),
    dishes: tallyDishes(
      (votes ?? []).map((v) => ({
        menuItemId: v.menu_item_id,
        dishName: dishName.get(v.order_item_id) ?? "A dish",
        liked: v.liked,
      })),
    ),
  };
}
