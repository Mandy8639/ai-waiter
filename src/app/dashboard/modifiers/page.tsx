import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { deleteModifierGroup } from "@/lib/modifiers/actions";

export const metadata = {
  title: "Modifiers — Tableside",
};

export default async function ModifiersPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const [{ data: groups }, { data: menuItems }] = await Promise.all([
    supabase
      .from("menu_item_modifiers")
      .select(
        "id, name, menu_item_id, is_required, min_selections, max_selections",
      )
      .eq("restaurant_id", restaurant.id)
      .order("display_order", { ascending: true }),
    supabase
      .from("menu_items")
      .select("id, name")
      .eq("restaurant_id", restaurant.id),
  ]);

  const groupIds = (groups ?? []).map((g) => g.id);
  const { data: options } =
    groupIds.length > 0
      ? await supabase
          .from("modifier_options")
          .select("modifier_id")
          .in("modifier_id", groupIds)
      : { data: [] };

  const optionCountByGroupId = new Map<string, number>();
  for (const option of options ?? []) {
    optionCountByGroupId.set(
      option.modifier_id,
      (optionCountByGroupId.get(option.modifier_id) ?? 0) + 1,
    );
  }
  const menuItemNameById = new Map(
    (menuItems ?? []).map((m) => [m.id, m.name]),
  );
  const canManage =
    restaurant.role === "owner" || restaurant.role === "manager";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Modifiers</h1>
          <p className="text-muted-foreground text-sm">
            Customization groups for menu items, like size or spice level.
          </p>
        </div>
        {canManage && (
          <Link
            href="/dashboard/modifiers/new"
            className={buttonVariants({ variant: "default" })}
          >
            New modifier group
          </Link>
        )}
      </div>

      {!groups || groups.length === 0 ? (
        <EmptyState
          title="No modifier groups yet"
          description={
            menuItems && menuItems.length > 0
              ? 'Add a group like "Size" or "Spice level" to a menu item.'
              : "Create a menu item first, then add modifier groups to it."
          }
          actionHref={
            canManage && menuItems && menuItems.length > 0
              ? "/dashboard/modifiers/new"
              : undefined
          }
          actionLabel={canManage ? "New modifier group" : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <Card key={group.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{group.name}</p>
                    <Badge variant="outline">
                      {menuItemNameById.get(group.menu_item_id) ?? "—"}
                    </Badge>
                    <Badge
                      variant={group.is_required ? "secondary" : "outline"}
                    >
                      {group.is_required ? "Required" : "Optional"}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Choose {group.min_selections}–{group.max_selections} ·{" "}
                    {optionCountByGroupId.get(group.id) ?? 0} option
                    {optionCountByGroupId.get(group.id) === 1 ? "" : "s"}
                  </p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/modifiers/${group.id}`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      Manage
                    </Link>
                    <DeleteButton
                      onDelete={deleteModifierGroup.bind(
                        null,
                        restaurant.id,
                        group.id,
                      )}
                      confirmTitle={`Delete "${group.name}"?`}
                      confirmDescription="This removes the group and all of its options. This can't be undone."
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
