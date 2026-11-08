import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PrintSheetButton } from "@/components/tables/print-sheet-button";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  buildTableQrUrl,
  generateTableQrSvg,
  getRequestOrigin,
} from "@/lib/tables/qr";
import { getRestaurantWifiForStaff } from "@/lib/wifi/queries";
import { wifiQrPayload } from "@/lib/wifi/core";
import {
  QR_CARDS_PER_PAGE,
  qrCardLabel,
  qrSheetPages,
} from "@/lib/tables/qr-sheet-core";

export const metadata = {
  title: "Print QR codes — Tableside",
};

/**
 * Every active table's QR code on A4 sheets, six cards a page, to print
 * and cut out. Each card's code is the same link as the table's own QR
 * page (buildTableQrUrl), drawn as SVG so it stays sharp at any size.
 *
 * On paper only the sheet prints: the print styles below hide the
 * dashboard's sidebar and header and set the page to A4 with no browser
 * margins (each sheet carries its own).
 *
 * With guest Wi-Fi set (20261201090000), each card also carries a small
 * "join Wi-Fi" code under the order code, which shrinks a little to make
 * room. The order code stays the big one, so it's the one people scan.
 */
export default async function PrintQrCodesPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data } = await supabase
    .from("tables")
    .select("id, table_number, display_name, public_token, is_active")
    .eq("restaurant_id", restaurant.id);

  const origin = await getRequestOrigin();
  const tables = await Promise.all(
    (data ?? []).map(async (table) => ({
      id: table.id,
      tableNumber: String(table.table_number),
      displayName: table.display_name,
      isActive: table.is_active,
      svg: await generateTableQrSvg(
        buildTableQrUrl(origin, restaurant.slug, table.public_token),
      ),
    })),
  );
  const wifi = await getRestaurantWifiForStaff(restaurant.id);
  // generateTableQrSvg draws any text; this one is the Wi-Fi join string.
  const wifiSvg = wifi ? await generateTableQrSvg(wifiQrPayload(wifi)) : null;
  const pages = qrSheetPages(tables);
  const count = pages.reduce((sum, page) => sum + page.length, 0);

  return (
    <div className="flex flex-col gap-6">
      <style>{`
        @page { size: A4; margin: 0; }
        @media print {
          html, body { background: #fff !important; }
          header, aside, nav { display: none !important; }
          body * { visibility: hidden; }
          .qr-sheet, .qr-sheet * { visibility: visible; }
          .qr-sheet { position: absolute; left: 0; top: 0; gap: 0 !important; }
          .qr-page { box-shadow: none !important; border: 0 !important; margin: 0 !important; break-after: page; }
          .qr-page:last-child { break-after: auto; }
        }
      `}</style>

      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Print QR codes
          </h1>
          <p className="text-muted-foreground text-sm">
            {count === 0
              ? "No active tables to print."
              : `${count} ${count === 1 ? "table" : "tables"} on ${pages.length} A4 ${pages.length === 1 ? "page" : "pages"}, ${QR_CARDS_PER_PAGE} to a page. Cut along the dashed lines. In the print dialog choose A4, 100% scale (no "fit to page").`}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/dashboard/tables"
            className={buttonVariants({ variant: "outline" })}
          >
            Back to tables
          </Link>
          {count > 0 && <PrintSheetButton />}
        </div>
      </div>

      {count === 0 ? (
        <EmptyState
          title="No active tables"
          description="Add a table, or turn one back on, to print its QR code."
          actionHref="/dashboard/tables"
          actionLabel="Go to tables"
        />
      ) : (
        <div className="qr-sheet flex flex-col items-center gap-6">
          {pages.map((page, index) => (
            <section
              key={index}
              aria-label={`Page ${index + 1}`}
              className="qr-page grid grid-cols-2 grid-rows-3 border bg-white shadow-sm"
              style={{
                width: "210mm",
                height: "297mm",
                padding: "10mm",
                boxSizing: "border-box",
              }}
            >
              {page.map((table) => (
                <div
                  key={table.id}
                  className="flex flex-col items-center justify-center gap-[2mm] border border-dashed border-neutral-400 text-center text-neutral-900"
                >
                  <p className="text-[11pt] font-medium text-neutral-600">
                    {restaurant.name}
                  </p>
                  <p className="text-[16pt] font-semibold text-[#842B02]">
                    Scan to order
                  </p>
                  <div
                    className="[&>svg]:h-full [&>svg]:w-full"
                    style={
                      wifiSvg
                        ? { width: "44mm", height: "44mm" }
                        : { width: "52mm", height: "52mm" }
                    }
                    // The qrcode library's own SVG for this table's link.
                    dangerouslySetInnerHTML={{ __html: table.svg }}
                  />
                  <p className="text-[14pt] font-semibold">
                    {qrCardLabel(table)}
                  </p>
                  {wifi && wifiSvg && (
                    <div className="mt-[1mm] flex items-center gap-[3mm] border-t border-neutral-300 pt-[2mm] text-left">
                      <div
                        className="shrink-0 [&>svg]:h-full [&>svg]:w-full"
                        style={{ width: "17mm", height: "17mm" }}
                        dangerouslySetInnerHTML={{ __html: wifiSvg }}
                      />
                      <div className="flex flex-col leading-tight">
                        <span className="text-[9pt] font-semibold">
                          Free Wi-Fi
                        </span>
                        <span className="max-w-[40mm] truncate text-[9pt]">
                          {wifi.ssid}
                        </span>
                        <span className="text-[7pt] text-neutral-500">
                          Scan with your camera to join
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
