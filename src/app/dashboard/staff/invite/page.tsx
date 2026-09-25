import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { InviteLinkForm } from "@/components/staff/invite-link-form";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createInvitation } from "@/lib/staff/invitation-actions";

export const metadata = {
  title: "Invite by link — Tableside",
};

export default async function InviteStaffPage() {
  const { restaurant } = await requireCurrentRestaurant();

  // create_staff_invitation() refuses anyone else, but a kitchen or staff
  // member who reaches this URL should not be shown a form that can only
  // fail.
  if (restaurant.role !== "owner" && restaurant.role !== "manager") {
    redirect("/dashboard/staff");
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Invite by link
        </h1>
        <Link
          href="/dashboard/staff"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Back to staff
        </Link>
      </div>

      <p className="text-muted-foreground text-sm">
        For someone who doesn&apos;t have a Tableside account yet. They follow
        the link, create an account, and land in {restaurant.name} with the role
        you pick here.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New invitation</CardTitle>
        </CardHeader>
        <CardContent>
          <InviteLinkForm
            action={createInvitation.bind(null, restaurant.id)}
            canInviteOwner={restaurant.role === "owner"}
          />
        </CardContent>
      </Card>
    </div>
  );
}
