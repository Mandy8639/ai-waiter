import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AddStaffForm } from "@/components/staff/add-staff-form";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { addStaffMember } from "@/lib/staff/actions";

export const metadata = {
  title: "Add staff — Tableside",
};

export default async function NewStaffPage() {
  const { restaurant } = await requireCurrentRestaurant();

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Add member</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Member details</CardTitle>
        </CardHeader>
        <CardContent>
          <AddStaffForm
            action={addStaffMember.bind(null, restaurant.id)}
            canGrantOwner={restaurant.role === "owner"}
          />
        </CardContent>
      </Card>
    </div>
  );
}
