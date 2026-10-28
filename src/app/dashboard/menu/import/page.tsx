import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MenuImportUpload } from "@/components/dashboard/menu-import-upload";
import { MenuImportLink } from "@/components/dashboard/menu-import-link";
import { importMenuFromLink } from "@/lib/menu-import/actions";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { isMenuImportConfigured } from "@/lib/menu-import/vision";

// Reading photos runs inside this page's server action: up to two tries of
// 120 s per photo, photos in parallel (src/lib/menu-import/vision.ts).
export const maxDuration = 300;

export const metadata = {
  title: "Import menu — Tableside",
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
          Upload photos or a PDF of your menu, or paste a link to it, and
          we&apos;ll read it for you. You&apos;ll check everything before
          anything is added.
        </p>
      </div>

      {configured ? (
        <>
          <MenuImportUpload restaurantId={restaurant.id} />
          <div className="flex flex-col gap-3 border-t pt-5">
            <h2 className="font-medium">Or read it from a link</h2>
            <MenuImportLink
              action={importMenuFromLink.bind(null, restaurant.id)}
            />
          </div>
          <div className="flex flex-col gap-2 border-t pt-5">
            <h2 className="font-medium">Use Square?</h2>
            <p className="text-muted-foreground text-sm">
              Connect Square to import your menu exactly as it is there, and
              import again whenever it changes.
            </p>
            <div>
              <Link
                href="/dashboard/settings/pos"
                className={buttonVariants({ variant: "outline" })}
              >
                Import from Square
              </Link>
            </div>
          </div>
        </>
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
