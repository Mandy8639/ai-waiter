import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthorizedContext } from "@/lib/restaurants/authorize";
import type { AssistantDb, ToolCall } from "./execute-core";
import type {
  KitchenState,
  PlanContext,
  ServiceSnapshot,
  StaffRole,
} from "./plan-core";
import { BOARD_LOOKBACK_HOURS } from "@/lib/orders/kitchen";
import { tableLabel } from "@/lib/table-requests/core";
import type { Catalog } from "./resolve-core";

/**
 * The staff assistant's reads and its one write that isn't a change to the
 * restaurant: the command log. Menu and kitchen reads go through the
 * signed-in person's own client, so they see what RLS lets them see.
 */

type Client = AuthorizedContext["supabase"];

/** Commands per person in RATE_WINDOW_MINUTES; plenty for a busy service, not a script. */
export const RATE_LIMIT = 40;
export const RATE_WINDOW_MINUTES = 10;

/** The dashboard's own functions and policies, called as this person. */
export function assistantDb(supabase: Client): AssistantDb {
  // database.types.ts predates several of these functions.
  const untyped = supabase as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{
      data: unknown;
      error: { message: string; code?: string } | null;
    }>;
  };
  return {
    rpc: (fn, args) => untyped.rpc(fn, args),
    async updateDishPrice(restaurantId, dishId, price) {
      const { data, error } = await supabase
        .from("menu_items")
        .update({ price })
        .eq("id", dishId)
        .eq("restaurant_id", restaurantId)
        .select("id");
      return {
        updatedIds: (data ?? []).map((r) => r.id),
        error: error ? { message: error.message, code: error.code } : null,
      };
    },
  };
}

export async function loadAssistantContext(
  supabase: Client,
  restaurantId: string,
): Promise<
  Pick<PlanContext, "catalog" | "state" | "timeZone" | "hasMenuHours">
> {
  const [restaurant, dishes, groups, status, hours] = await Promise.all([
    supabase
      .from("restaurants")
      .select("timezone")
      .eq("id", restaurantId)
      .maybeSingle(),
    supabase
      .from("menu_items")
      .select("id, name, price, is_available, available_again_at")
      .eq("restaurant_id", restaurantId),
    supabase
      .from("menu_item_modifiers")
      .select("id, menu_item_id, name")
      .eq("restaurant_id", restaurantId),
    supabase
      .rpc("get_kitchen_status", { target_restaurant_id: restaurantId })
      .maybeSingle(),
    // database.types.ts predates menu_hours (20261004090000).
    (
      supabase as unknown as {
        from: (t: string) => {
          select: (
            c: string,
            o: { count: "exact"; head: true },
          ) => {
            eq: (c: string, v: string) => Promise<{ count: number | null }>;
          };
        };
      }
    )
      .from("menu_hours")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantId),
  ]);

  // database.types.ts predates available_again_at (20261019090000).
  const dishRows = (dishes.data ?? []) as unknown as Array<{
    id: string;
    name: string;
    price: number;
    is_available: boolean;
    available_again_at: string | null;
  }>;
  const groupRows = groups.data ?? [];
  const groupIds = groupRows.map((g) => g.id);
  const optionRows =
    groupIds.length > 0
      ? ((
          await supabase
            .from("modifier_options")
            .select("id, modifier_id, name, is_available")
            .in("modifier_id", groupIds)
        ).data ?? [])
      : [];

  const dishName = new Map(dishRows.map((d) => [d.id, d.name]));
  const groupById = new Map(groupRows.map((g) => [g.id, g]));

  const catalog: Catalog = {
    dishes: dishRows.map((d) => ({
      id: d.id,
      name: d.name,
      price: Number(d.price),
      available: d.is_available,
      backAt: d.is_available ? null : d.available_again_at,
    })),
    options: optionRows.flatMap((o) => {
      const group = groupById.get(o.modifier_id);
      if (!group) return [];
      return [
        {
          id: o.id,
          name: o.name,
          groupName: group.name,
          dishName: dishName.get(group.menu_item_id) ?? "a dish",
          available: o.is_available,
        },
      ];
    }),
  };

  const row = status.data as {
    orders_paused_until: string | null;
    busy_extra_minutes: number | null;
  } | null;
  const state: KitchenState = {
    pausedUntil: row?.orders_paused_until ?? null,
    busyExtraMinutes: Math.max(0, row?.busy_extra_minutes ?? 0),
  };

  return {
    catalog,
    state,
    timeZone: restaurant.data?.timezone ?? "UTC",
    // Unknown (a failed count) reads as "has hours": no tip beats a wrong one.
    hasMenuHours: hours.count !== 0,
  };
}

/** The log is written by the server only, so nothing a browser sends can add to or edit it. */
function logClient() {
  return createAdminClient() as unknown as {
    from: (table: string) => {
      insert: (row: Record<string, unknown>) => Promise<{
        error: { message: string } | null;
      }>;
      select: (
        columns: string,
        options: { count: "exact"; head: true },
      ) => {
        eq: (
          c: string,
          v: string,
        ) => {
          gte: (c: string, v: string) => Promise<{ count: number | null }>;
        };
      };
    };
  };
}

export async function isRateLimited(userId: string): Promise<boolean> {
  const since = new Date(
    Date.now() - RATE_WINDOW_MINUTES * 60_000,
  ).toISOString();
  const { count } = await logClient()
    .from("staff_assistant_commands")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  return (count ?? 0) >= RATE_LIMIT;
}

export async function recordCommand(entry: {
  restaurantId: string;
  userId: string;
  role: StaffRole;
  command: string;
  interpretedBy: "rules" | "ai" | "button";
  intent: unknown;
  outcome: string;
  calls: ToolCall[];
  reply: string;
}): Promise<void> {
  const { error } = await logClient()
    .from("staff_assistant_commands")
    .insert({
      restaurant_id: entry.restaurantId,
      user_id: entry.userId,
      role: entry.role,
      command: entry.command,
      interpreted_by: entry.interpretedBy,
      intent: entry.intent ?? null,
      outcome: entry.outcome,
      tool_calls: entry.calls,
      reply: entry.reply,
    });
  // A missing log line must not undo a change that has already happened,
  // or tell the person it failed when it didn't. It is reported instead.
  if (error) {
    const { reportError } = await import("@/lib/observability/report");
    reportError(error, {
      scope: "staff_assistant.log",
      extra: { restaurantId: entry.restaurantId },
    });
  }
}

/**
 * How service is going, for "how many tables are live?": orders on the go
 * (within the kitchen board's own window, so a forgotten order from days
 * ago doesn't count), tables served in the last hour, and tables waiting
 * for a person. Read as the signed-in person: the same orders, tables and
 * requests their own screens show.
 */
export async function loadServiceSnapshot(
  supabase: Client,
  restaurantId: string,
  now: Date,
): Promise<ServiceSnapshot> {
  const since = new Date(
    now.getTime() - BOARD_LOOKBACK_HOURS * 3_600_000,
  ).toISOString();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const [orders, tables, requests] = await Promise.all([
    supabase
      .from("orders")
      .select("table_id, status, updated_at")
      .eq("restaurant_id", restaurantId)
      .gt("created_at", since)
      .in("status", ["pending", "confirmed", "preparing", "ready", "served"]),
    supabase
      .from("tables")
      .select("id, table_number, display_name")
      .eq("restaurant_id", restaurantId),
    supabase
      .from("table_requests")
      .select("table_id, kind, created_at")
      .eq("restaurant_id", restaurantId)
      .eq("status", "open")
      .order("created_at"),
  ]);
  if (orders.error || tables.error || requests.error) {
    throw new Error("service snapshot: a read failed");
  }

  const label = new Map(
    (tables.data ?? []).map((t) => [
      t.id,
      tableLabel(t.table_number, t.display_name),
    ]),
  );
  const nameOf = (id: string) => label.get(id) ?? "A table";
  const inKitchen = { pending: 0, confirmed: 0, preparing: 0, ready: 0 };
  const active = new Set<string>();
  const served = new Set<string>();
  for (const o of orders.data ?? []) {
    if (o.status === "served") {
      if (o.updated_at > hourAgo) served.add(o.table_id);
      continue;
    }
    inKitchen[o.status as keyof typeof inKitchen] += 1;
    active.add(o.table_id);
  }
  for (const id of active) served.delete(id);

  const byName = (a: string, b: string) =>
    a.localeCompare(b, "en", { numeric: true });
  return {
    inKitchen,
    activeTables: [...active].map(nameOf).sort(byName),
    recentlyServedTables: served.size,
    // table_requests postdates database.types.ts.
    waiting: (
      (requests.data ?? []) as unknown as Array<{
        table_id: string;
        kind: string;
      }>
    ).map(
      (r) =>
        `${nameOf(r.table_id)} ${r.kind === "bill" ? "wants the bill" : "wants a waiter"}`,
    ),
  };
}
