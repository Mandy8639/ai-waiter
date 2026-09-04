import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MenuImportUpload } from "@/components/dashboard/menu-import-upload";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { isMenuImportConfigured } from "@/lib/menu-import/vision";

export const metadata = {
  title: "Import menu — AI Waiter",
};

export default async function MenuImportPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const configured = isMenuImportConfigured();

  return (
    <div className="flex max-w-2xl flex-1 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Import your menu
        </h1>
        <p className="text-muted-foreground text-sm">
          Photograph your menu boards and we&apos;ll read them for you.
          You&apos;ll check everything before anything is added.
        </p>
      </div>

      {configured ? (
        <MenuImportUpload restaurantId={restaurant.id} />
      ) : (
        <>
          <Alert>
            <AlertDescription>
              Menu reading isn&apos;t set up on this deployment yet. You can
              still add items by hand.
            </AlertDescription>
          </Alert>
          <Link
            href="/dashboard/menu/new"
            className={buttonVariants({ variant: "outline" })}
          >
            Add an item manually
          </Link>
        </>
      )}

      <div className="text-muted-foreground flex flex-col gap-1 border-t pt-4 text-xs">
        <p>
          <strong>Prices are never guessed.</strong> If the menu doesn&apos;t
          state a price — &ldquo;ask at counter&rdquo;, by weight, or simply
          unreadable — the item comes back with no price and you supply it
          yourself.
        </p>
        <p>Nothing reaches your live menu until you press add.</p>
      </div>
    </div>
  );
}
