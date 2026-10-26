import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  PrinterManager,
  type PrinterView,
} from "@/components/printing/printer-manager";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createClient } from "@/lib/supabase/server";
import { getKitchenStations } from "@/lib/orders/kitchen";

export const metadata = {
  title: "Printers — Tableside",
};

/**
 * Network printers (Star CloudPRNT): kitchen ticket printers and the
 * receipt printer with its cash drawer. Owners and managers only, like the
 * rest of Settings; the printers table's own policy says the same.
 */
export default async function PrintersPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();
  // printers / print_jobs are newer than database.types.ts.
  const untyped = supabase as unknown as {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (
          column: string,
          value: string,
        ) => {
          order: (
            column: string,
            options: { ascending: boolean },
          ) => Promise<{ data: unknown[] | null }>;
          in: (
            column: string,
            values: string[],
          ) => Promise<{ data: unknown[] | null }>;
        };
      };
    };
  };

  const [printers, stations, waiting] = await Promise.all([
    untyped
      .from("printers")
      .select(
        "id, name, role, station_id, auto_print, opens_drawer, is_active, client_type, last_seen_at, last_status",
      )
      .eq("restaurant_id", restaurant.id)
      .order("created_at", { ascending: true }),
    getKitchenStations(restaurant.id),
    untyped
      .from("print_jobs")
      .select("printer_id, status")
      .eq("restaurant_id", restaurant.id)
      .in("status", ["queued", "sent", "failed"]),
  ]);

  const counts = new Map<string, { waiting: number; failed: number }>();
  for (const job of (waiting.data ?? []) as {
    printer_id: string;
    status: string;
  }[]) {
    const c = counts.get(job.printer_id) ?? { waiting: 0, failed: 0 };
    if (job.status === "failed") c.failed += 1;
    else c.waiting += 1;
    counts.set(job.printer_id, c);
  }

  const views: PrinterView[] = (
    (printers.data ?? []) as Omit<PrinterView, "waiting" | "failed">[]
  ).map((p) => ({ ...p, ...(counts.get(p.id) ?? { waiting: 0, failed: 0 }) }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Printers</h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Star network printers print straight from Tableside, with no computer
          or app in between: kitchen tickets the moment an order comes in,
          receipts when a bill is paid, and the cash drawer opens for cash.
          Works with Star printers that support CloudPRNT, such as the
          mC-Print3, TSP143IV and SP742.
        </p>
      </div>
      <PrinterManager
        restaurantId={restaurant.id}
        printers={views}
        stations={stations}
      />
    </div>
  );
}
