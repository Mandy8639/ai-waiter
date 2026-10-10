import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { DeleteAccountForm } from "@/components/account/delete-account-form";
import { deleteMyAccount } from "@/lib/account/actions";
import { getAccountOverview } from "@/lib/account/queries";
import {
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_POLICY_PATH,
} from "@/lib/legal/privacy";

export const metadata = {
  title: "Account — Tableside",
};

/**
 * The signed-in person's account, and the way to delete it (which Google
 * Play requires of an app with sign-up). Deliberately outside /dashboard:
 * someone who signed up but never created a restaurant, or who belongs to
 * several and hasn't picked one, has no dashboard page to put it on.
 *
 * A restaurant's only owner can't delete their account until someone else
 * is an owner, so the form is replaced by what to do instead; the database
 * refuses it either way (delete_my_account()).
 */
export default async function AccountPage() {
  const account = await getAccountOverview();
  if (!account) redirect("/login?redirectTo=/account");

  const blocked = account.soleOwned.length > 0;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-12 sm:py-16">
      <p className="text-sm">
        <Link
          href="/dashboard"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Back to the dashboard
        </Link>
      </p>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Signed in as{" "}
          <span className="text-foreground font-medium">{account.email}</span>
        </p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="font-heading text-base leading-snug font-medium">
            Delete your account
          </h2>
          <CardDescription>
            This permanently deletes your sign-in and removes you from every
            restaurant you belong to, including your devices&apos; order alerts.
            The restaurants keep their own records, such as orders, payments and
            menus, without your name on them. This can&apos;t be undone.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          {blocked ? (
            <div className="flex flex-col gap-3">
              <p>
                You&apos;re the only owner of{" "}
                {account.soleOwned.length === 1
                  ? "this restaurant"
                  : "these restaurants"}
                :
              </p>
              <ul className="list-disc pl-5 font-medium">
                {account.soleOwned.map((r) => (
                  <li key={r.id}>{r.name}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                A restaurant always needs an owner. Make someone else an owner
                on its Staff page, then come back here. To close a restaurant
                instead, email{" "}
                <a
                  href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
                  className="text-foreground font-medium underline underline-offset-4"
                >
                  {PRIVACY_CONTACT_EMAIL}
                </a>
                .
              </p>
            </div>
          ) : (
            <DeleteAccountForm action={deleteMyAccount} />
          )}
          <p className="text-muted-foreground text-xs">
            More about what we keep and why in our{" "}
            <Link
              href={PRIVACY_POLICY_PATH}
              className="underline underline-offset-4"
            >
              privacy policy
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
