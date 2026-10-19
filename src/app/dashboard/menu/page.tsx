import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { DishDetailsCard } from "@/components/dashboard/dish-details-card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { deleteMenuItem, toggleMenuItemAvailability } from "@/lib/menu/actions";
import { countDraftNutrition } from "@/lib/nutrition/queries";

export const metadata = {
  title: "Menu — Tableside",
};

export default async function MenuPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const [{ data: menuItems }, { data: categories }] = await Promise.all([
    supabase
      .from("menu_items")
      .select(
        "id, name, category_id, price, is_available, is_vegetarian, is_spicy, details_source, display_order",
      )
      .eq("restaurant_id", restaurant.id)
      .order("display_order", { ascending: true }),
    supabase
      .from("categories")
      .select("id, name")
      .eq("restaurant_id", restaurant.id),
  ]);

  // Dishes carrying an allergen suggestion nobody has confirmed. Counted
  // rather than fetched: the page only needs to know whether to nudge.
  const { count: pendingAllergens } = await supabase
    .from("menu_item_allergens")
    .select("menu_item_id", { count: "exact", head: true })
    .eq("restaurant_id", restaurant.id)
    .is("confirmed_at", null);

  // Dishes whose heat was guessed at import and never looked at. Nudged
  // for a different reason than allergens: these ARE visible to diners
  // already, so the prompt is "check what we published", not "publish it".
  const { count: draftSpice } = await supabase
    .from("menu_items")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurant.id)
    .eq("spice_level_source", "ai_draft")
    .not("spice_level", "is", null);

  // Photo coverage, for a restaurant deciding where to spend an evening
  // with a camera. Counted, not fetched: the page only needs the number.
  // database.types.ts predates phase 1, so the image columns are filtered
  // through an assertion; see src/lib/menu-images/menu-item-rows.ts.
  const countMenuItems = supabase
    .from("menu_items")
    .select.bind(supabase.from("menu_items")) as unknown as (
    columns: string,
    options: { count: "exact"; head: true },
  ) => {
    eq: (
      column: string,
      value: string,
    ) => {
      is: (column: string, value: null) => Promise<{ count: number | null }>;
      eq: (column: string, value: string) => Promise<{ count: number | null }>;
    };
  };

  const { count: withoutPhoto } = await countMenuItems("id", {
    count: "exact",
    head: true,
  })
    .eq("restaurant_id", restaurant.id)
    .is("active_image_id", null);
  const totalItems = (menuItems ?? []).length;

  // Dishes nobody has described: what "Fill in dish details with AI" works on.
  const { count: withoutDescription } = await supabase
    .from("menu_items")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurant.id)
    .is("description", null);

  // Phase M: nutrition waiting on a person. Drafts are invisible to
  // diners, so the count is the only way an owner learns they're there.
  const draftNutrition = await countDraftNutrition(restaurant.id);

  const categoryNameById = new Map(
    (categories ?? []).map((c) => [c.id, c.name]),
  );
  const canManage =
    restaurant.role === "owner" || restaurant.role === "manager";
  const currency = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Menu</h1>
          <p className="text-muted-foreground text-sm">
            Manage the dishes customers will see.
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            {/*
              Offered alongside manual entry rather than instead of it: a
              restaurant with 150 items should not type them all in, and a
              restaurant adding one dish should not have to photograph it.
            */}
            {/*
              Surfaced next to the menu itself, with a count, because an
              unconfirmed allergen is invisible to diners: without a visible
              reminder a restaurant would never learn there was anything
              waiting, and would assume its allergen data was live.
            */}
            {(pendingAllergens ?? 0) > 0 && (
              <Link
                href="/dashboard/menu/allergen-review"
                className={buttonVariants({ variant: "outline" })}
              >
                Confirm allergens ({pendingAllergens})
              </Link>
            )}
            {(withoutPhoto ?? 0) > 0 && totalItems > 0 && (
              <Link
                href="/dashboard/menu/photos"
                className={buttonVariants({ variant: "outline" })}
              >
                Add photos ({withoutPhoto})
              </Link>
            )}
            <Link
              href="/dashboard/menu/menus"
              className={buttonVariants({ variant: "outline" })}
            >
              Menus
            </Link>
            {totalItems > 0 && (
              <Link
                href="/dashboard/menu/translations"
                className={buttonVariants({ variant: "outline" })}
              >
                Translations
              </Link>
            )}
            {totalItems > 0 && (
              <Link
                href="/dashboard/menu/nutrition"
                className={buttonVariants({ variant: "outline" })}
              >
                {draftNutrition > 0
                  ? `Nutrition (${draftNutrition} to confirm)`
                  : "Nutrition"}
              </Link>
            )}
            {(draftSpice ?? 0) > 0 && (
              <Link
                href="/dashboard/menu/spice-review"
                className={buttonVariants({ variant: "outline" })}
              >
                Review spice ({draftSpice})
              </Link>
            )}
            <Link
              href="/dashboard/menu/import"
              className={buttonVariants({ variant: "outline" })}
            >
              Import from photos
            </Link>
            <Link
              href="/dashboard/menu/new"
              className={buttonVariants({ variant: "default" })}
            >
              New menu item
            </Link>
          </div>
        )}
      </div>

      {canManage && totalItems > 0 && (
        <DishDetailsCard
          restaurantId={restaurant.id}
          missing={withoutDescription ?? 0}
        />
      )}

      {!menuItems || menuItems.length === 0 ? (
        <EmptyState
          title="No menu items yet"
          description={
            categories && categories.length > 0
              ? "Add your first dish to get started."
              : "Create a category first, then add dishes to it."
          }
          actionHref={canManage ? "/dashboard/menu/new" : undefined}
          actionLabel={canManage ? "New menu item" : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Availability</TableHead>
                <TableHead>Vegetarian</TableHead>
                <TableHead>Spicy</TableHead>
                {canManage && (
                  <TableHead className="text-right">Actions</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {menuItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">
                    {item.name}
                    {/*
                      The description and prep time on this dish were
                      written from its NAME and nobody has read them. Diners
                      see them regardless — this is a prompt to check, not a
                      gate. Opening the item and saving clears it.
                    */}
                    {item.details_source === "ai_draft" && (
                      <Badge variant="outline" className="ml-2 font-normal">
                        Draft text
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {categoryNameById.get(item.category_id) ?? "—"}
                  </TableCell>
                  <TableCell>{currency.format(Number(item.price))}</TableCell>
                  <TableCell>
                    <Badge
                      variant={item.is_available ? "secondary" : "outline"}
                    >
                      {item.is_available ? "Available" : "Unavailable"}
                    </Badge>
                  </TableCell>
                  <TableCell>{item.is_vegetarian ? "Yes" : "—"}</TableCell>
                  <TableCell>{item.is_spicy ? "Yes" : "—"}</TableCell>
                  {canManage && (
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <form
                          action={toggleMenuItemAvailability.bind(
                            null,
                            restaurant.id,
                            item.id,
                            !item.is_available,
                          )}
                        >
                          <button
                            type="submit"
                            className={buttonVariants({
                              variant: "outline",
                              size: "sm",
                            })}
                          >
                            {item.is_available
                              ? "Mark unavailable"
                              : "Mark available"}
                          </button>
                        </form>
                        <Link
                          href={`/dashboard/menu/${item.id}/edit`}
                          className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                          })}
                        >
                          Edit
                        </Link>
                        <DeleteButton
                          onDelete={deleteMenuItem.bind(
                            null,
                            restaurant.id,
                            item.id,
                          )}
                          confirmTitle={`Delete "${item.name}"?`}
                          confirmDescription="This can't be undone. Modifiers, ingredient links, and allergen links for this item will be removed too."
                        />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
