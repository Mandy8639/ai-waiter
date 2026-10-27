"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CloverActionState } from "@/lib/pos/clover/actions";

type Action = (
  prev: CloverActionState,
  formData: FormData,
) => Promise<CloverActionState>;

export interface CloverConnectionView {
  /** Clover credentials exist on this deployment at all. */
  configured: boolean;
  connected: boolean;
  merchantId: string | null;
  /** Talking to Clover's sandbox, not real restaurants' accounts. */
  sandbox: boolean;
  menuSyncedAt: string | null;
  lastSync: {
    items_created?: number;
    items_updated?: number;
    items_hidden?: number;
  } | null;
  /** Orders sent to the register today, still being retried, and given up on. */
  orders: { delivered: number; retrying: number; failed: number[] };
}

function Result({ state }: { state: CloverActionState }) {
  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    );
  }
  if (state.success) {
    return (
      <Alert>
        <AlertDescription>{state.success}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

/**
 * The Clover card on Settings → Point of sale: connect, import the menu,
 * see that orders reach the register, disconnect. Each step is its own
 * form so one failing doesn't clear the others' messages.
 */
export function CloverConnection({
  view,
  connectAction,
  syncAction,
  disconnectAction,
}: {
  view: CloverConnectionView;
  connectAction: Action;
  syncAction: Action;
  disconnectAction: Action;
}) {
  const [connectState, connect, connecting] = useActionState(connectAction, {});
  const [syncState, sync, syncing] = useActionState(syncAction, {});
  const [disconnectState, disconnectForm, disconnecting] = useActionState(
    disconnectAction,
    {},
  );

  if (!view.configured) {
    return (
      <p className="text-muted-foreground text-sm">
        Clover isn&apos;t set up on this deployment yet.
      </p>
    );
  }

  if (!view.connected) {
    return (
      <form action={connect} className="flex flex-col gap-3">
        <p className="text-sm">
          Connect your Clover account to import its menu and send every
          Tableside order to your Clover register.
          {view.sandbox && " (Clover's test environment.)"}
        </p>
        <Button type="submit" className="self-start" disabled={connecting}>
          {connecting ? "Opening Clover…" : "Connect Clover"}
        </Button>
        <Result state={connectState} />
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge>Connected</Badge>
        {view.sandbox && <Badge variant="outline">Test environment</Badge>}
        {view.merchantId && (
          <span className="text-muted-foreground">
            Merchant {view.merchantId}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <p className="font-medium">Orders on the register</p>
        <p className="text-muted-foreground">
          Every order placed in Tableside is created in Clover as it&apos;s
          placed. {view.orders.delivered} sent today
          {view.orders.retrying > 0 &&
            `, ${view.orders.retrying} still being retried`}
          .
        </p>
        {view.orders.failed.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              {view.orders.failed.length === 1 ? "Order" : "Orders"}{" "}
              {view.orders.failed.map((n) => `#${n}`).join(", ")} didn&apos;t
              reach Clover after an hour of retries. Ring{" "}
              {view.orders.failed.length === 1 ? "it" : "them"} up on the
              register.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <form action={sync} className="flex flex-col gap-2">
        <p className="text-sm">
          {view.menuSyncedAt
            ? `Menu last imported ${new Date(view.menuSyncedAt).toLocaleString()}${
                view.lastSync
                  ? `: ${view.lastSync.items_created ?? 0} added, ${view.lastSync.items_updated ?? 0} updated, ${view.lastSync.items_hidden ?? 0} hidden.`
                  : "."
              }`
            : "Import your Clover menu so orders point at your Clover items."}
        </p>
        <Button
          type="submit"
          variant="outline"
          className="self-start"
          disabled={syncing}
        >
          {syncing ? "Importing…" : "Import menu from Clover"}
        </Button>
        <Result state={syncState} />
      </form>

      <form action={disconnectForm} className="flex flex-col gap-2">
        <Button
          type="submit"
          variant="ghost"
          className="self-start"
          disabled={disconnecting}
        >
          {disconnecting ? "Disconnecting…" : "Disconnect Clover"}
        </Button>
        <Result state={disconnectState} />
      </form>
    </div>
  );
}
