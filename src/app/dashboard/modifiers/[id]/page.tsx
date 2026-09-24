import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { ModifierGroupForm } from "@/components/modifiers/modifier-group-form";
import { ModifierOptionForm } from "@/components/modifiers/modifier-option-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  createModifierOption,
  deleteModifierOption,
  toggleModifierOptionAvailability,
  updateModifierGroup,
} from "@/lib/modifiers/actions";

export const metadata = {
  title: "Modifier group — Tableside",
};

export default async function ModifierGroupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const [{ data: group }, { data: menuItems }, { data: options }] =
    await Promise.all([
      supabase
        .from("menu_item_modifiers")
        .select(
          "id, menu_item_id, name, description, is_required, min_selections, max_selections, display_order",
        )
        .eq("id", id)
        .eq("restaurant_id", restaurant.id)
        .maybeSingle(),
      supabase
        .from("menu_items")
        .select("id, name")
        .eq("restaurant_id", restaurant.id)
        .order("display_order"),
      supabase
        .from("modifier_options")
        .select("id, name, price_adjustment, is_available, display_order")
        .eq("modifier_id", id)
        .order("display_order", { ascending: true }),
    ]);

  if (!group) {
    notFound();
  }

  const currency = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    signDisplay: "always",
  });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{group.name}</h1>
        <Link
          href="/dashboard/modifiers"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Back to modifiers
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Group details</CardTitle>
        </CardHeader>
        <CardContent>
          <ModifierGroupForm
            action={updateModifierGroup.bind(null, restaurant.id, group.id)}
            menuItems={menuItems ?? []}
            defaultValues={{
              menuItemId: group.menu_item_id,
              name: group.name,
              description: group.description,
              isRequired: group.is_required,
              minSelections: group.min_selections,
              maxSelections: group.max_selections,
              displayOrder: group.display_order,
            }}
            submitLabel="Save changes"
            pendingLabel="Saving…"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Options</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {options && options.length > 0 ? (
            <div className="flex flex-col gap-2">
              {options.map((option) => (
                <div
                  key={option.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{option.name}</p>
                    <span className="text-muted-foreground text-sm">
                      {currency.format(Number(option.price_adjustment))}
                    </span>
                    <Badge
                      variant={option.is_available ? "secondary" : "outline"}
                    >
                      {option.is_available ? "Available" : "Unavailable"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <form
                      action={toggleModifierOptionAvailability.bind(
                        null,
                        restaurant.id,
                        option.id,
                        !option.is_available,
                      )}
                    >
                      <button
                        type="submit"
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                      >
                        {option.is_available
                          ? "Mark unavailable"
                          : "Mark available"}
                      </button>
                    </form>
                    <DeleteButton
                      onDelete={deleteModifierOption.bind(
                        null,
                        restaurant.id,
                        option.id,
                      )}
                      confirmTitle={`Delete "${option.name}"?`}
                      confirmDescription="This can't be undone."
                      triggerLabel="Delete"
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No options yet — add one below.
            </p>
          )}

          <Separator />

          <ModifierOptionForm
            action={createModifierOption.bind(null, restaurant.id, group.id)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
