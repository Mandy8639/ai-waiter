import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  MenuImportReview,
  type ReviewRow,
} from "@/components/dashboard/menu-import-review";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";

export const metadata = {
  title: "Review imported menu — Tableside",
};

export default async function MenuImportReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  // RLS scopes this to the caller's own restaurant; the explicit filter
  // narrows the query, it isn't the boundary.
  const { data: importRow } = await supabase
    .from("menu_imports")
    .select("id, status, error, extraction_model")
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  if (!importRow) {
    notFound();
  }

  const { data: items } = await supabase
    .from("menu_import_items")
    .select("id, category_name, name, price, include, display_order")
    .eq("import_id", id)
    .order("display_order", { ascending: true });

  const rows: ReviewRow[] = (items ?? []).map((item) => ({
    id: item.id,
    categoryName: item.category_name,
    name: item.name,
    price: item.price === null ? null : Number(item.price),
    include: item.include,
  }));

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Check your menu before adding it
        </h1>
        <p className="text-muted-foreground text-sm">
          Edit anything that was read incorrectly. Untick anything you
          don&apos;t want.
        </p>
      </div>

      {importRow.status === "committed" ? (
        <>
          <Alert>
            <AlertDescription>
              This import has already been added to your menu.
            </AlertDescription>
          </Alert>
          <Link href="/dashboard/menu" className={buttonVariants()}>
            Back to the menu
          </Link>
        </>
      ) : importRow.status === "failed" ? (
        <>
          <Alert variant="destructive">
            <AlertDescription>
              {importRow.error ?? "That import didn't work."}
            </AlertDescription>
          </Alert>
          <Link
            href="/dashboard/menu/import"
            className={buttonVariants({ variant: "outline" })}
          >
            Try again
          </Link>
        </>
      ) : rows.length === 0 ? (
        <Alert>
          <AlertDescription>
            No items were found in those photos. Try a closer or better-lit
            shot.
          </AlertDescription>
        </Alert>
      ) : (
        <MenuImportReview
          restaurantId={restaurant.id}
          importId={id}
          initialRows={rows}
        />
      )}
    </div>
  );
}
