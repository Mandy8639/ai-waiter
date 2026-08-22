import Link from "next/link";
import { Flame, Leaf } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface MenuItemCardData {
  id: string;
  name: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  isVegetarian: boolean;
  isVegan: boolean;
  isSpicy: boolean;
}

export function MenuItemCard({
  item,
  restaurantSlug,
}: {
  item: MenuItemCardData;
  restaurantSlug: string;
}) {
  const currency = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  });

  return (
    <Link href={`/r/${restaurantSlug}/item/${item.id}`}>
      <Card className="hover:bg-secondary/40 transition-colors">
        <CardContent className="flex gap-3 py-3">
          {item.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL
            <img
              src={item.imageUrl}
              alt=""
              className="size-16 shrink-0 rounded-md border object-cover"
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-start justify-between gap-2">
              <p className="truncate text-sm font-medium">{item.name}</p>
              <p className="shrink-0 text-sm font-medium">
                {currency.format(item.price)}
              </p>
            </div>
            {item.description && (
              <p className="text-muted-foreground line-clamp-2 text-xs">
                {item.description}
              </p>
            )}
            {(item.isVegetarian || item.isVegan || item.isSpicy) && (
              <div className="flex items-center gap-2 pt-0.5">
                {(item.isVegetarian || item.isVegan) && (
                  <span
                    className={cn(
                      "flex items-center gap-0.5 text-xs",
                      "text-green-700 dark:text-green-500",
                    )}
                    title={item.isVegan ? "Vegan" : "Vegetarian"}
                  >
                    <Leaf className="size-3" />
                    {item.isVegan ? "Vegan" : "Veg"}
                  </span>
                )}
                {item.isSpicy && (
                  <span
                    className="flex items-center gap-0.5 text-xs text-orange-700 dark:text-orange-500"
                    title="Spicy"
                  >
                    <Flame className="size-3" />
                    Spicy
                  </span>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
