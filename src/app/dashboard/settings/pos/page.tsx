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
import {
  grantedScopes,
  listLocations,
  squareConfig,
} from "@/lib/pos/square/api";
import {
  SQUARE_TEST_TERMINALS,
  canPairTerminals,
} from "@/lib/pos/square/oauth-core";
import {
  SquareTerminals,
  type TerminalRow,
} from "@/components/pos/square-terminals";
import { SquareSyncPanel } from "@/components/pos/square-sync-panel";
import {
  CloverConnection,
  type CloverConnectionView,
} from "@/components/pos/clover-connection";
import { cloverConfig } from "@/lib/pos/clover/api";
import { cloverOfferedTo } from "@/lib/pos/clover/oauth-core";
import { getCloverOrderStats } from "@/lib/pos/clover/order-stats";
import {
  disconnectCloverAction,
  startCloverConnect,
  syncCloverMenu,
} from "@/lib/pos/clover/actions";
import {
  chooseSquareLocation,
  disconnectSquare,
  addTestTerminal,
  checkTerminalPairing,
  removeTerminal,
  setSquarePayments,
  startSquareConnect,
  startTerminalPairing,
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

const CLOVER_RETURN_MESSAGES: Record<
  string,
  { tone: "ok" | "error"; text: string }
> = {
  connected: {
    tone: "ok",
    text: "Clover is connected. New orders now go to your Clover register; import your menu next.",
  },
  cancelled: {
    tone: "error",
    text: "Clover wasn't connected: the request was cancelled on Clover's screen.",
  },
  expired: {
    tone: "error",
    text: "That connection link expired. Press Connect Clover again.",
  },
  forbidden: {
    tone: "error",
    text: "Only an owner or manager (with two-step verification, if your restaurant requires it) can connect Clover.",
  },
  error: {
    tone: "error",
    text: "Clover didn't finish connecting. Try again in a minute.",
  },
};

export default async function PointOfSalePage({
  searchParams,
}: {
  searchParams: Promise<{ square?: string; clover?: string }>;
}) {
  const { restaurant } = await requireCurrentRestaurant();
  const { square, clover } = await searchParams;
  const supabase = (await createClient()) as unknown as SupabaseClient;

  // Owners and managers only, by RLS: anyone else reads no row.
  const { data: row } = await supabase
    .from("restaurant_pos_integrations")
    .select(
      "provider, external_location_id, external_merchant_id, is_enabled, payments_enabled, connected_at, menu_synced_at, last_sync_summary",
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
  const message = square
    ? RETURN_MESSAGES[square]
    : clover
      ? CLOVER_RETURN_MESSAGES[clover]
      : undefined;

  // Clover (20261121090000): offered to the restaurants CLOVER_RESTAURANTS
  // names, and never alongside a Square connection (one POS each).
  const cloverConnected =
    row?.provider === "clover" && Boolean(row.connected_at);
  const showClover =
    cloverConnected ||
    (!connected &&
      cloverOfferedTo(restaurant.slug, process.env.CLOVER_RESTAURANTS));
  let cloverView: CloverConnectionView | null = null;
  if (showClover) {
    const orders = cloverConnected
      ? await getCloverOrderStats(supabase, restaurant.id)
      : { delivered: 0, retrying: 0, failed: [] };
    cloverView = {
      configured: cloverConfig() !== null,
      connected: cloverConnected,
      merchantId: cloverConnected ? (row?.external_merchant_id ?? null) : null,
      sandbox: cloverConfig()?.environment !== "production",
      menuSyncedAt: cloverConnected ? (row?.menu_synced_at ?? null) : null,
      lastSync: cloverConnected ? (row?.last_sync_summary ?? null) : null,
      orders,
    };
  }

  // Terminals (phase 3): the owner's RLS view of pos_devices, and whether
  // this connection may pair one.
  let terminals: TerminalRow[] = [];
  let canPair = false;
  if (connected) {
    const [{ data: devices }, scopes] = await Promise.all([
      supabase
        .from("pos_devices")
        .select("id, name, status, pairing_code, pair_by")
        .eq("restaurant_id", restaurant.id)
        .in("status", ["pairing", "paired"])
        .order("created_at"),
      grantedScopes(restaurant.id),
    ]);
    terminals = (devices ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      pairingCode: d.pairing_code,
      pairBy: d.pair_by,
    }));
    canPair = canPairTerminals(scopes);
  }
  // Cash and card-machine sales (and their refunds) that didn't reach
  // Square's reports (20261118090000).
  let unsynced = { payments: 0, refunds: 0 };
  if (connected && row?.payments_enabled) {
    const { data } = await supabase.rpc("square_unsynced", {
      p_restaurant_id: restaurant.id,
    });
    const u = data as { payments?: unknown[]; refunds?: unknown[] } | null;
    unsynced = {
      payments: u?.payments?.length ?? 0,
      refunds: u?.refunds?.length ?? 0,
    };
  }

  const testTerminals =
    squareConfig()?.environment === "sandbox"
      ? SQUARE_TEST_TERMINALS.map((t) => ({ ...t }))
      : [];

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
          Connect the restaurant&apos;s point of sale so Tableside uses the same
          menu.
        </p>
      </div>

      {message && (
        <Alert variant={message.tone === "error" ? "destructive" : "default"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      {cloverView && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Clover</CardTitle>
            <CardDescription>
              Clover stays in charge of names, prices, sections and sold-out
              items. Photos, allergens and dietary details you add in Tableside
              are kept when you import again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CloverConnection
              view={cloverView}
              connectAction={startCloverConnect.bind(null, restaurant.id)}
              syncAction={syncCloverMenu.bind(null, restaurant.id)}
              disconnectAction={disconnectCloverAction.bind(
                null,
                restaurant.id,
              )}
            />
          </CardContent>
        </Card>
      )}

      {!cloverConnected && (
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
      )}

      {unsynced.payments + unsynced.refunds > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not yet in Square</CardTitle>
            <CardDescription>
              Cash and card-machine sales, and refunds of them, are copied into
              Square so its reports match Tableside&apos;s.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SquareSyncPanel
              restaurantId={restaurant.id}
              payments={unsynced.payments}
              refunds={unsynced.refunds}
            />
          </CardContent>
        </Card>
      )}

      {connected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Square Terminals</CardTitle>
            <CardDescription>
              Staff send a table&apos;s bill to a Terminal from Settle up or
              Take order. The guest taps their card and can add a tip there, and
              the sale lands in Square.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SquareTerminals
              terminals={terminals}
              canPair={canPair}
              testTerminals={testTerminals}
              pairAction={startTerminalPairing.bind(null, restaurant.id)}
              checkAction={checkTerminalPairing.bind(null, restaurant.id)}
              removeAction={removeTerminal.bind(null, restaurant.id)}
              addTestAction={addTestTerminal.bind(null, restaurant.id)}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
