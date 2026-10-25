"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/dashboard/native-select";
import type { SquareActionState } from "@/lib/pos/square/actions";

type Action = (prev: SquareActionState, formData: FormData) => Promise<SquareActionState>;

export interface SquareConnectionView {
  /** Square credentials exist on this deployment at all. */
  configured: boolean;
  connected: boolean;
  locationId: string | null;
  locations: { id: string; name: string }[];
  locationError: string | null;
  menuSyncedAt: string | null;
  lastSync: {
    items_created?: number;
    items_updated?: number;
    items_hidden?: number;
  } | null;
}

function Result({ state }: { state: SquareActionState }) {
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
 * The Square card on Settings → Point of sale: connect, pick a location,
 * import the menu, disconnect. Each step is its own form so one failing
 * doesn't clear the others' messages.
 */
export function SquareConnection({
  view,
  connectAction,
  locationAction,
  syncAction,
  disconnectAction,
}: {
  view: SquareConnectionView;
  connectAction: Action;
  locationAction: Action;
  syncAction: Action;
  disconnectAction: Action;
}) {
  const [connectState, connect, connecting] = useActionState(connectAction, {});
  const [locationState, chooseLocation, savingLocation] = useActionState(locationAction, {});
  const [syncState, sync, syncing] = useActionState(syncAction, {});
  const [disconnectState, disconnectForm, disconnecting] = useActionState(disconnectAction, {});

  if (!view.configured) {
    return (
      <p className="text-muted-foreground text-sm">
        Square isn&apos;t set up on this deployment yet.
      </p>
    );
  }

  if (!view.connected) {
    return (
      <form action={connect} className="flex flex-col gap-3">
        <Result state={connectState} />
        <p className="text-sm">
          You&apos;ll sign in to Square and approve Tableside. It can read your menu and locations,
          and (once payments through Square are on) create orders and take payments for you.
        </p>
        <div>
          <Button type="submit" disabled={connecting}>
            {connecting ? "Opening Square…" : "Connect Square"}
          </Button>
        </div>
      </form>
    );
  }

  const location = view.locations.find((l) => l.id === view.locationId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="outline">Connected</Badge>
        {location && <span>Location: {location.name}</span>}
      </div>

      {view.locationError && (
        <Alert variant="destructive">
          <AlertDescription>{view.locationError}</AlertDescription>
        </Alert>
      )}

      {view.locations.length > 1 && (
        <form action={chooseLocation} className="flex flex-col gap-2">
          <Result state={locationState} />
          <label htmlFor="locationId" className="text-sm font-medium">
            Which Square location is this restaurant?
          </label>
          <div className="flex gap-2">
            <NativeSelect
              id="locationId"
              name="locationId"
              defaultValue={view.locationId ?? ""}
              disabled={savingLocation}
            >
              <option value="" disabled>
                Choose a location
              </option>
              {view.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
            <Button type="submit" variant="outline" disabled={savingLocation}>
              Save
            </Button>
          </div>
        </form>
      )}

      <form action={sync} className="flex flex-col gap-2">
        <Result state={syncState} />
        <p className="text-sm font-medium">Menu</p>
        <p className="text-muted-foreground text-sm">
          {view.menuSyncedAt
            ? `Last imported ${new Date(view.menuSyncedAt).toLocaleString()}: ${view.lastSync?.items_created ?? 0} added, ${view.lastSync?.items_updated ?? 0} updated, ${view.lastSync?.items_hidden ?? 0} hidden.`
            : "Not imported yet. Importing adds your Square items to Tableside; dishes you created in Tableside stay as they are."}
        </p>
        <div>
          <Button type="submit" disabled={syncing || !view.locationId}>
            {syncing ? "Importing…" : view.menuSyncedAt ? "Import again" : "Import menu from Square"}
          </Button>
        </div>
      </form>

      <form action={disconnectForm} className="flex flex-col gap-2 border-t pt-4">
        <Result state={disconnectState} />
        <div>
          <Button type="submit" variant="ghost" disabled={disconnecting}>
            {disconnecting ? "Disconnecting…" : "Disconnect Square"}
          </Button>
        </div>
      </form>
    </div>
  );
}
