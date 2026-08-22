import { Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Checklist of menu items, each an independent auto-submitting form bound
 * to `onToggle(menuItemId, nextValue)`. Used to manage
 * menu_item_ingredients / menu_item_allergens links from the
 * ingredient/allergen side. The check mark is presentational (a styled
 * span, not an interactive checkbox input) — the whole row is the actual
 * control, submitted as a plain form so it works without client JS.
 */
export function MenuItemLinksCard({
  title,
  menuItems,
  linkedMenuItemIds,
  onToggle,
}: {
  title: string;
  menuItems: { id: string; name: string }[];
  linkedMenuItemIds: Set<string>;
  onToggle: (menuItemId: string, linked: boolean) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {menuItems.length === 0 ? (
          <p className="text-muted-foreground text-sm">No menu items yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {menuItems.map((item) => {
              const isLinked = linkedMenuItemIds.has(item.id);
              return (
                <form
                  key={item.id}
                  action={onToggle.bind(null, item.id, !isLinked)}
                >
                  <button
                    type="submit"
                    aria-pressed={isLinked}
                    className="hover:bg-secondary/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                        isLinked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input",
                      )}
                    >
                      {isLinked && <Check className="size-3.5" />}
                    </span>
                    {item.name}
                  </button>
                </form>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
