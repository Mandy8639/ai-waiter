import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { deleteTable, toggleTableActive } from "@/lib/tables/actions";

export const metadata = {
  title: "Tables — Tableside",
};

export default async function TablesPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: tables } = await supabase
    .from("tables")
    .select("id, table_number, display_name, is_active")
    .eq("restaurant_id", restaurant.id)
    .order("table_number");

  const canManage =
    restaurant.role === "owner" || restaurant.role === "manager";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tables</h1>
          <p className="text-muted-foreground text-sm">
            Your restaurant&apos;s physical tables.
          </p>
        </div>
        {canManage && (
          <Link
            href="/dashboard/tables/new"
            className={buttonVariants({ variant: "default" })}
          >
            New table
          </Link>
        )}
      </div>

      {!tables || tables.length === 0 ? (
        <EmptyState
          title="No tables yet"
          description="Add your first table to get started."
          actionHref={canManage ? "/dashboard/tables/new" : undefined}
          actionLabel={canManage ? "New table" : undefined}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tables.map((table) => (
            <Card key={table.id}>
              <CardContent className="flex flex-col gap-3 py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Table {table.table_number}</p>
                    {table.display_name && (
                      <p className="text-muted-foreground text-sm">
                        {table.display_name}
                      </p>
                    )}
                  </div>
                  <Badge variant={table.is_active ? "secondary" : "outline"}>
                    {table.is_active ? "Active" : "Inactive"}
                  </Badge>
                </div>
                {canManage && (
                  <div className="flex flex-wrap items-center gap-2">
                    <form
                      action={toggleTableActive.bind(
                        null,
                        restaurant.id,
                        table.id,
                        !table.is_active,
                      )}
                    >
                      <button
                        type="submit"
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                      >
                        {table.is_active ? "Deactivate" : "Activate"}
                      </button>
                    </form>
                    <Link
                      href={`/dashboard/tables/${table.id}/qr`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      QR code
                    </Link>
                    <Link
                      href={`/dashboard/tables/${table.id}/edit`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      Edit
                    </Link>
                    <DeleteButton
                      onDelete={deleteTable.bind(null, restaurant.id, table.id)}
                      confirmTitle={`Delete table ${table.table_number}?`}
                      confirmDescription="This can't be undone."
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
