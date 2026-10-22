import { PosScreen } from "@/components/pos/pos-screen";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createClient } from "@/lib/supabase/server";
import {
  buildPosMenu,
  type PosMenuRows,
  type PosTable,
} from "@/lib/pos/pos-core";

export const metadata = {
  title: "Take order — Tableside",
};

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * The POS screen: staff ring up dine-in, walk-in, takeout and phone
 * orders, and send them to the kitchen. Open to owner, manager and staff
 * (src/components/dashboard/nav-items.ts); the order itself is
 * staff_place_order(), which checks the role again and prices everything.
 */
export default async function PosPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;

  const [restaurantRow, settings, tables, categories, dishes, groups] =
    await Promise.all([
      supabase
        .from("restaurants")
        .select("tax_rate, service_charge, currency")
        .eq("id", restaurant.id)
        .maybeSingle(),
      supabase
        .from("restaurant_settings")
        .select(
          "accept_cash, accept_card_terminal, accept_card, tipping_enabled",
        )
        .eq("restaurant_id", restaurant.id)
        .maybeSingle(),
      supabase
        .from("tables")
        // kind: pickup counters (20261022090000, newer than database.types.ts).
        .select(
          "id, table_number, display_name, kind" as "id, table_number, display_name",
        )
        .eq("restaurant_id", restaurant.id)
        .eq("is_active", true),
      supabase
        .from("categories")
        .select("id, name, display_order")
        .eq("restaurant_id", restaurant.id)
        .eq("is_active", true),
      supabase
        .from("menu_items")
        .select("id, name, category_id, price, is_available, display_order")
        .eq("restaurant_id", restaurant.id),
      supabase
        .from("menu_item_modifiers")
        .select(
          "id, menu_item_id, name, is_required, min_selections, max_selections, display_order",
        )
        .eq("restaurant_id", restaurant.id),
    ]);

  const groupIds = (groups.data ?? []).map((g) => g.id);
  const [options, onNow] = await Promise.all([
    groupIds.length > 0
      ? supabase
          .from("modifier_options")
          .select(
            "id, modifier_id, name, price_adjustment, is_available, display_order",
          )
          .in("modifier_id", groupIds)
      : Promise.resolve({ data: [] }),
    // Menu hours: the database refuses a dish whose menu isn't on, so the
    // screen says so up front instead of after Send.
    Promise.all(
      (categories.data ?? []).map(async (c) => {
        const { data } = await rpc("category_on_now", { p_category_id: c.id });
        return [c.id, data !== false] as const;
      }),
    ),
  ]);
  const onNowById = new Map(onNow);

  const menu = buildPosMenu({
    categories: (categories.data ?? []).map((c) => ({
      ...c,
      onNow: onNowById.get(c.id) ?? true,
    })),
    dishes: (dishes.data ?? []) as PosMenuRows["dishes"],
    groups: groups.data ?? [],
    options: (options.data ?? []) as PosMenuRows["options"],
  });

  const tableRows = (tables.data ?? []) as unknown as {
    id: string;
    table_number: string;
    display_name: string | null;
    kind: "table" | "counter";
  }[];
  const posTables: PosTable[] = tableRows
    .map((t) => ({
      id: t.id,
      // A counter is named for what it is ("Counter", "Front desk"), not a
      // table number.
      label:
        t.display_name ||
        (t.kind === "counter" ? t.table_number : `Table ${t.table_number}`),
      kind: t.kind,
    }))
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Take order</h1>
        <p className="text-muted-foreground text-sm">
          Ring up a table, a walk-in or a phone order and send it to the
          kitchen. It shows on the kitchen board and in Settle up like any other
          order.
        </p>
      </div>
      <PosScreen
        restaurantId={restaurant.id}
        menu={menu}
        tables={posTables}
        currency={restaurantRow.data?.currency ?? "USD"}
        taxRate={Number(restaurantRow.data?.tax_rate ?? 0)}
        serviceChargeRate={Number(restaurantRow.data?.service_charge ?? 0)}
        payments={{
          cash: settings.data?.accept_cash ?? false,
          cardMachine: settings.data?.accept_card_terminal ?? false,
          card: settings.data?.accept_card ?? false,
          tipping: settings.data?.tipping_enabled ?? false,
        }}
      />
    </div>
  );
}
