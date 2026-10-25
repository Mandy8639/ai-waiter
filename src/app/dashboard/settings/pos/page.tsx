import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  SquareConnection,
  type SquareConnectionView,
} from "@/components/pos/square-connection";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { listLocations, squareConfig } from "@/lib/pos/square/api";
import {
  chooseSquareLocation,
  disconnectSquare,
  setSquarePayments,
  startSquareConnect,
  syncSquareMenu,
} from "@/lib/pos/square/actions";

export const metadata = {
  title: "Point of sale — Tableside",
};

const RETURN_MESSAGES: Record<string, { tone: "ok" | "error"; text: string }> =
  {
    connected: { tone: "ok", text: "Square is connected." },
    cancelled: {
      tone: "error",
      text: "Square wasn't connected: the request was cancelled on Square's screen.",
    },
    expired: {
      tone: "error",
      text: "That connection link expired. Press Connect Square again.",
    },
    forbidden: {
      tone: "error",
      text: "Only an owner or manager (with two-step verification, if your restaurant requires it) can connect Square.",
    },
    error: {
      tone: "error",
      text: "Square didn't finish connecting. Try again in a minute.",
    },
  };

export default async function PointOfSalePage({
  searchParams,
}: {
  searchParams: Promise<{ square?: string }>;
}) {
  const { restaurant } = await requireCurrentRestaurant();
  const { square } = await searchParams;
  const supabase = (await createClient()) as unknown as SupabaseClient;

  // Owners and managers only, by RLS: anyone else reads no row.
  const { data: row } = await supabase
    .from("restaurant_pos_integrations")
    .select(
      "provider, external_location_id, is_enabled, payments_enabled, connected_at, menu_synced_at, last_sync_summary",
    )
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  // listLocations() reads the token with the service key. It's only
  // reached when the RLS read above returned a row, which takes the same
  // owner/manager check (two-step verification included) as the actions.
  const connected = row?.provider === "square" && Boolean(row.connected_at);
  let locations: { id: string; name: string }[] = [];
  let locationError: string | null = null;
  if (connected) {
    try {
      locations = (await listLocations(restaurant.id))
        .filter((l) => l.status === "ACTIVE")
        .map((l) => ({ id: l.id, name: l.name }));
    } catch {
      locationError =
        "Couldn't reach Square to list your locations. Reconnect if this keeps happening.";
    }
  }

  const view: SquareConnectionView = {
    configured: squareConfig() !== null,
    connected,
    locationId: row?.external_location_id ?? null,
    locations,
    locationError,
    menuSyncedAt: row?.menu_synced_at ?? null,
    lastSync: row?.last_sync_summary ?? null,
    paymentsEnabled: Boolean(row?.payments_enabled),
  };
  const message = square ? RETURN_MESSAGES[square] : undefined;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Point of sale</h1>
        <p className="text-muted-foreground text-sm">
          Connect the restaurant&apos;s Square account so Tableside uses the
          same menu.
        </p>
      </div>

      {message && (
        <Alert variant={message.tone === "error" ? "destructive" : "default"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Square</CardTitle>
          <CardDescription>
            Square stays in charge of names, prices, sections and sold-out
            items. Photos, allergens and dietary details you add in Tableside
            are kept when you import again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SquareConnection
            view={view}
            connectAction={startSquareConnect.bind(null, restaurant.id)}
            locationAction={chooseSquareLocation.bind(null, restaurant.id)}
            syncAction={syncSquareMenu.bind(null, restaurant.id)}
            disconnectAction={disconnectSquare.bind(null, restaurant.id)}
            paymentsAction={setSquarePayments.bind(null, restaurant.id)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
