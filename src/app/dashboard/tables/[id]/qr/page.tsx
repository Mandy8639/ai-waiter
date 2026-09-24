import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { CopyUrlButton } from "@/components/tables/copy-url-button";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  buildTableQrUrl,
  generateTableQrDataUrl,
  getRequestOrigin,
} from "@/lib/tables/qr";
import { regenerateTableToken } from "@/lib/tables/actions";

export const metadata = {
  title: "Table QR code — Tableside",
};

export default async function TableQrPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: table } = await supabase
    .from("tables")
    .select("id, table_number, display_name, public_token, is_active")
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  if (!table) {
    notFound();
  }

  const origin = await getRequestOrigin();
  const customerUrl = buildTableQrUrl(
    origin,
    restaurant.slug,
    table.public_token,
  );
  const qrDataUrl = await generateTableQrDataUrl(customerUrl);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          Table {table.table_number}
          {table.display_name && (
            <span className="text-muted-foreground">
              {" "}
              · {table.display_name}
            </span>
          )}
        </h1>
        <Link
          href="/dashboard/tables"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Back to tables
        </Link>
      </div>

      {!table.is_active && (
        <p className="text-destructive text-sm">
          This table is inactive — its QR code will not resolve for customers
          until it&apos;s reactivated.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">QR code</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, not an optimizable remote image */}
          <img
            src={qrDataUrl}
            alt={`QR code linking to the customer menu for table ${table.table_number}`}
            width={256}
            height={256}
            className="rounded-md border"
          />

          <p className="text-muted-foreground text-center text-xs break-all">
            {customerUrl}
          </p>

          <div className="flex flex-wrap justify-center gap-2">
            <CopyUrlButton url={customerUrl} />
            <a
              href={qrDataUrl}
              download={`table-${table.table_number}-qr.png`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Download PNG
            </a>
            <DeleteButton
              onDelete={regenerateTableToken.bind(
                null,
                restaurant.id,
                table.id,
              )}
              confirmTitle="Regenerate this table's QR code?"
              confirmDescription="Any previously printed or saved QR code for this table will stop working immediately. This can't be undone."
              triggerLabel="Regenerate"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
