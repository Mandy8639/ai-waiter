import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableForm } from "@/components/tables/table-form";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createTable } from "@/lib/tables/actions";

export const metadata = {
  title: "New table — AI Waiter",
};

export default async function NewTablePage() {
  const { restaurant } = await requireCurrentRestaurant();

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New table</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Table details</CardTitle>
        </CardHeader>
        <CardContent>
          <TableForm
            action={createTable.bind(null, restaurant.id)}
            submitLabel="Create table"
            pendingLabel="Creating…"
          />
        </CardContent>
      </Card>
    </div>
  );
}
