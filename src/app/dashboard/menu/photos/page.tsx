import Link from "next/link";
import { ImageOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { asRowsWithNewColumns } from "@/lib/menu-images/menu-item-rows";
import type { ImageSource } from "@/lib/menu-images/resolve";

export const metadata = {
  title: "Menu photos — Tableside",
};

interface PhotoRow {
  id: string;
  name: string;
  active_image_id: string | null;
  image_source: ImageSource | null;
}

/**
 * Where a restaurant sees photo coverage across the whole menu, and gets
 * to the dishes that still need one.
 *
 * Deliberately not a media manager: no grid of thumbnails to browse, no
 * bulk actions, no library. The useful question for a restaurant with 150
 * dishes is "which ones are missing a photo, and let me do the next one",
 * so that is the entire page. Uploading still happens in the normal
 * per-dish flow, which is the only place the review step lives.
 */
export default async function MenuPhotosPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  // database.types.ts predates phase 1; the image columns are asserted
  // against the migration. See src/lib/menu-images/menu-item-rows.ts.
  const select = supabase
    .from("menu_items")
    .select.bind(supabase.from("menu_items")) as unknown as (
    columns: string,
  ) => {
    eq: (
      column: string,
      value: string,
    ) => {
      order: (
        column: string,
        options: { ascending: boolean },
      ) => Promise<{ data: unknown }>;
    };
  };

  const { data } = await select("id, name, active_image_id, image_source")
    .eq("restaurant_id", restaurant.id)
    .order("display_order", { ascending: true });

  const rows = asRowsWithNewColumns<PhotoRow>(data);

  const missing = rows.filter((row) => !row.active_image_id);
  const aiGenerated = rows.filter(
    (row) => row.image_source === "ai_generated",
  ).length;
  // Everything with a photo that is not AI-generated is the restaurant's
  // own — including a confirmed legacy image.
  const restaurantPhotos = rows.length - missing.length - aiGenerated;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Menu photos</h1>
        <p className="text-muted-foreground text-sm">
          Photos help diners choose. Add them a few at a time.
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        <Stat label="With your photos" value={restaurantPhotos} />
        {/* Informational until generation exists; shown so the number is
            never a surprise once it does. */}
        <Stat label="AI-generated" value={aiGenerated} />
        <Stat label="No photo yet" value={missing.length} />
      </dl>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {missing.length > 0
              ? `Dishes without a photo (${missing.length})`
              : "Every dish has a photo"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {missing.length === 0 ? (
            <EmptyState
              icon={<ImageOff className="size-5" aria-hidden="true" />}
              title="Nothing waiting"
              description="Every dish on your menu has a photo diners can see."
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {missing.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <span className="truncate text-sm font-medium">
                    {item.name}
                  </span>
                  <Link
                    href={`/dashboard/menu/${item.id}/edit`}
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                    aria-label={`Add a photo to ${item.name}`}
                  >
                    Add photo
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
