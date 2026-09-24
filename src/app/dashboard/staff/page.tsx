import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { StaffRoleSelect } from "@/components/staff/staff-role-select";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { updateStaffRole, removeStaffMember } from "@/lib/staff/actions";
import { revokeInvitation } from "@/lib/staff/invitation-actions";
import { expiryLabel, roleLabel } from "@/lib/staff/invitations-core";
import { getPendingInvitations } from "@/lib/staff/get-invitations";

export const metadata = {
  title: "Staff — Tableside",
};

export default async function StaffPage() {
  const { user, restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: staff } = await supabase.rpc("get_restaurant_staff", {
    target_restaurant_id: restaurant.id,
  });

  // Owners and managers only — get_staff_invitations() raises for anyone
  // else, so it isn't called for them at all.
  const canInvite =
    restaurant.role === "owner" || restaurant.role === "manager";
  const invitations = canInvite
    ? await getPendingInvitations(restaurant.id)
    : [];

  // Per restaurant_users_update_owner/_delete_owner (see docs/security.md),
  // only owners can change roles or remove members at all — a
  // manager/kitchen/staff viewer sees everyone's role but no controls.
  const canManageExisting = restaurant.role === "owner";
  const canAdd = canInvite;
  const ownerCount = (staff ?? []).filter((m) => m.role === "owner").length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
          <p className="text-muted-foreground text-sm">
            Who has access to {restaurant.name}&apos;s dashboard.
          </p>
        </div>
        {canAdd && (
          <div className="flex flex-wrap gap-2">
            <Link
              href="/dashboard/staff/invite"
              className={buttonVariants({ variant: "default" })}
            >
              Invite by link
            </Link>
            <Link
              href="/dashboard/staff/new"
              className={buttonVariants({ variant: "outline" })}
            >
              Add existing account
            </Link>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {(staff ?? []).map((member) => {
          const isSelf = member.user_id === user.id;
          // A lone owner can't demote/remove themselves either — the
          // database enforces this (enforce_at_least_one_owner()), but
          // disabling the control here avoids a round trip just to show
          // an error for an action that can never succeed.
          const isOnlyOwner = member.role === "owner" && ownerCount <= 1;
          const showControls = canManageExisting && !isOnlyOwner;

          return (
            <Card key={member.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">
                    {member.email}
                    {isSelf && (
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        (you)
                      </span>
                    )}
                  </p>
                  {!showControls && (
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="secondary">
                        {roleLabel(member.role)}
                      </Badge>
                      {canManageExisting && isOnlyOwner && (
                        <span className="text-muted-foreground text-xs">
                          Restaurants need at least one owner.
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {showControls && (
                  <div className="flex items-center gap-2">
                    <StaffRoleSelect
                      memberId={member.id}
                      currentRole={member.role}
                      onChange={updateStaffRole.bind(null, restaurant.id)}
                    />
                    <DeleteButton
                      onDelete={removeStaffMember.bind(
                        null,
                        restaurant.id,
                        member.id,
                      )}
                      confirmTitle={`Remove ${member.email}?`}
                      confirmDescription="They'll immediately lose dashboard access to this restaurant."
                      triggerLabel="Remove"
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {canInvite && (
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Invitation links
            </h2>
            <p className="text-muted-foreground text-sm">
              Links you&apos;ve created that nobody has used yet. Each one works
              once.
            </p>
          </div>

          {invitations.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No links waiting.{" "}
              <Link
                href="/dashboard/staff/invite"
                className="text-foreground underline-offset-4 hover:underline"
              >
                Invite someone by link
              </Link>
              .
            </p>
          ) : (
            invitations.map((invitation) => (
              <Card key={invitation.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div className="flex flex-col gap-1">
                    <p className="font-medium">
                      {invitation.label ?? (
                        <span className="text-muted-foreground font-normal">
                          No note
                        </span>
                      )}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">
                        {roleLabel(invitation.invited_role)}
                      </Badge>
                      <span
                        className={
                          invitation.is_expired
                            ? "text-destructive text-xs"
                            : "text-muted-foreground text-xs"
                        }
                      >
                        {expiryLabel(new Date(invitation.expires_at))}
                      </span>
                      {invitation.created_by_email && (
                        <span className="text-muted-foreground text-xs">
                          · invited by {invitation.created_by_email}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* The link itself is deliberately absent: only its
                      fingerprint is stored, so there is nothing to show.
                      Cancelling and making a new one is the recovery. */}
                  <DeleteButton
                    onDelete={revokeInvitation.bind(
                      null,
                      restaurant.id,
                      invitation.id,
                    )}
                    confirmTitle="Cancel this invitation link?"
                    confirmDescription="The link stops working immediately. Anyone who already has it won't be able to join."
                    triggerLabel="Cancel"
                  />
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
