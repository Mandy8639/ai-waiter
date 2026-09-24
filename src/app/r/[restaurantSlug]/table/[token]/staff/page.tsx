import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export const metadata = {
  title: "You're signed in as staff — Tableside",
};

/**
 * Where a signed-in staff member lands when they follow a table QR link.
 *
 * The route handler sends them here instead of signing them out. One
 * browser holds one Supabase auth session, so being staff and a diner at
 * the same time is not possible — and quietly taking the staff session to
 * make room for a customer one is exactly the behaviour this page exists
 * to replace.
 *
 * A dedicated page rather than another `?reason=` branch on
 * /r/table-not-found: nothing was not-found here, and a staff member who
 * read that URL would reasonably think the QR code was broken.
 */
export default async function StaffScannedTablePage({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <main className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
          Still signed in
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          You&apos;re signed in as staff
        </h1>
        <p className="text-muted-foreground text-sm">
          Opening a table code would sign you out of the dashboard, so we
          didn&apos;t. Your session is untouched.
        </p>
        <p className="text-muted-foreground text-sm">
          To see what a diner sees, open this link in a private window — or sign
          out first.
        </p>
        <div className="mt-2 flex flex-col gap-2 self-stretch">
          <Link
            href="/dashboard"
            className={buttonVariants({ variant: "default" })}
          >
            Back to the dashboard
          </Link>
          <Link
            href={`/r/${restaurantSlug}`}
            className={buttonVariants({ variant: "outline" })}
          >
            View the menu instead
          </Link>
        </div>
      </main>
    </div>
  );
}
