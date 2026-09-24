import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableForm } from "@/components/tables/table-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { updateTable } from "@/lib/tables/actions";

export const metadata = {
  title: "Edit table — Tableside",
};

export default async function EditTablePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: table } = await supabase
    .from("tables")
    .select("id, table_number, display_name, is_active")
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  if (!table) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Edit table</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Table details</CardTitle>
        </CardHeader>
        <CardContent>
          <TableForm
            action={updateTable.bind(null, restaurant.id, table.id)}
            defaultValues={{
              tableNumber: table.table_number,
              displayName: table.display_name,
              isActive: table.is_active,
            }}
            submitLabel="Save changes"
            pendingLabel="Saving…"
          />
        </CardContent>
      </Card>
    </div>
  );
}
