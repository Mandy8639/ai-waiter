import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { StaffRoleSelect } from "@/components/staff/staff-role-select";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { updateStaffRole, removeStaffMember } from "@/lib/staff/actions";

export const metadata = {
  title: "Staff — Tableside",
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  kitchen: "Kitchen",
  staff: "Staff",
};

export default async function StaffPage() {
  const { user, restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: staff } = await supabase.rpc("get_restaurant_staff", {
    target_restaurant_id: restaurant.id,
  });

  // Per restaurant_users_update_owner/_delete_owner (see docs/security.md),
  // only owners can change roles or remove members at all — a
  // manager/kitchen/staff viewer sees everyone's role but no controls.
  const canManageExisting = restaurant.role === "owner";
  const canAdd = restaurant.role === "owner" || restaurant.role === "manager";
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
          <Link
            href="/dashboard/staff/new"
            className={buttonVariants({ variant: "default" })}
          >
            Add member
          </Link>
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
                        {ROLE_LABELS[member.role] ?? member.role}
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
    </div>
  );
}
