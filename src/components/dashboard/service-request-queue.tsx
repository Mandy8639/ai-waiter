"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Hand, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { openAuthorizedChannel } from "@/lib/supabase/realtime";
import {
  resolvePollIntervalMs,
  shouldPollNow,
} from "@/components/kitchen/kds-reconciliation";
import {
  STAFF_LABELS,
  isOverdue,
  tableLabel,
  waitingLabel,
  type RequestKind,
} from "@/lib/table-requests/core";
import {
  loadOpenRequests,
  resolveServiceRequest,
  type OpenRequest,
} from "@/lib/table-requests/actions";

/**
 * Tables waiting for a person.
 *
 * Realtime is the primary signal, with the same caveat the kitchen board
 * documents (Supabase ticket SU-452145: `postgres_changes` INSERT delivery
 * is not always reliable), so the queue is also re-read on reconnect, when
 * the tab becomes visible, when the browser regains network, and on a
 * low-frequency safety-net timer. A missed event then costs a staff member
 * a tab switch rather than costing a table their waiter.
 *
 * Every trigger goes through the same full re-fetch rather than patching
 * the changed row into local state — the realtime payload carries the
 * request but not the table's number, so a partial patch could not render
 * anyway, and one code path means reconnect and polling are not special
 * cases.
 *
 * The `filter` below is a bandwidth optimisation, NOT the security
 * boundary: RLS is what stops another restaurant's rows ever reaching this
 * client (docs/security.md#realtime-security).
 */
const ICONS: Record<RequestKind, typeof Hand> = {
  waiter: Hand,
  bill: ReceiptText,
};

export function ServiceRequestQueue({
  restaurantId,
  initial,
}: {
  restaurantId: string;
  initial: OpenRequest[];
}) {
  const [requests, setRequests] = useState(initial);
  const [connected, setConnected] = useState(false);
  // Re-rendered on a timer so "3 min" does not sit there saying "just now"
  // for the rest of service.
  const [now, setNow] = useState(() => Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The dashboard nav renders in two places on small viewports; this queue
  // does not, but the same channel-topic collision would apply if it ever
  // did. A per-instance topic costs nothing and removes the question.
  const instanceId = useId();

  // Rows this screen just cleared. A refresh that was already on its way
  // when "Done" was tapped comes back with the row still open, and without
  // this it reappeared until the next refresh, so staff tapped again (seen
  // in the 2026-10-28 busy-night simulation). Kept until the database
  // agrees the row is gone.
  const clearedRef = useRef(new Set<string>());
  // Only the newest refresh may write the list: under load an older,
  // slower one can finish last.
  const refreshSeq = useRef(0);
  // One refresh at a time: server actions run one after another, so
  // refreshes queued behind a slow one would also hold up "Done". A
  // refresh asked for meanwhile runs once afterwards.
  const refreshing = useRef(false);
  const refreshAgain = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing.current) {
      refreshAgain.current = true;
      return;
    }
    refreshing.current = true;
    const seq = ++refreshSeq.current;
    let rows: OpenRequest[];
    try {
      rows = await loadOpenRequests(restaurantId);
    } catch {
      return; // the next change, tick or wake retries
    } finally {
      refreshing.current = false;
      if (refreshAgain.current) {
        refreshAgain.current = false;
        queueMicrotask(() => void refreshRef.current());
      }
    }
    if (seq !== refreshSeq.current) return;
    for (const id of clearedRef.current) {
      if (!rows.some((r) => r.id === id)) clearedRef.current.delete(id);
    }
    setRequests(rows.filter((r) => !clearedRef.current.has(r.id)));
  }, [restaurantId]);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const supabase = createClient();
    const closeChannel = openAuthorizedChannel(supabase, () =>
      supabase
        .channel(`service-requests-${restaurantId}-${instanceId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "table_requests",
            filter: `restaurant_id=eq.${restaurantId}`,
          },
          () => void refresh(),
        )
        .subscribe((status) => {
          const live = status === "SUBSCRIBED";
          setConnected(live);
          // A channel that just (re)connected may have missed events while
          // it was down, so resynchronise rather than assume continuity.
          if (live) void refresh();
        }),
    );

    return () => {
      closeChannel();
    };
  }, [restaurantId, instanceId, refresh]);

  // Safety net, and the clock for the waiting labels.
  useEffect(() => {
    function tick() {
      setNow(Date.now());
      if (shouldPollNow(document.visibilityState)) void refresh();
      timerRef.current = setTimeout(tick, resolvePollIntervalMs(connected));
    }
    timerRef.current = setTimeout(tick, resolvePollIntervalMs(connected));
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [connected, refresh]);

  useEffect(() => {
    const onWake = () => void refresh();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [refresh]);

  async function clear(id: string) {
    // Each row clears on its own. This used to ignore a tap while any
    // other row was still saving, so under load a waiter who cleared two
    // tables in a row saw the second one stay and tapped it again (the
    // 2026-10-28 busy-night simulation).
    if (clearedRef.current.has(id)) return;
    // Optimistic: the row leaves the queue immediately, because a staff
    // member who tapped "Done" and watched it sit there will tap again.
    clearedRef.current.add(id);
    setRequests((current) => current.filter((r) => r.id !== id));
    const result = await resolveServiceRequest(restaurantId, id);
    // If it failed, the authoritative read puts it back.
    if (!result.ok) {
      clearedRef.current.delete(id);
      void refresh();
    }
  }

  if (requests.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No tables are waiting.</p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {requests.map((request) => {
        const created = new Date(request.createdAt);
        const overdue = isOverdue(created, new Date(now));
        const Icon = ICONS[request.kind] ?? Hand;
        return (
          <li
            key={request.id}
            className={`flex items-center gap-3 rounded-lg border p-3 ${
              overdue ? "border-destructive/40 bg-destructive/5" : ""
            }`}
          >
            <Icon
              className={`size-4 shrink-0 ${overdue ? "text-destructive" : "text-muted-foreground"}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {tableLabel(request.tableNumber, request.tableDisplayName)}
                <span className="text-muted-foreground font-normal">
                  {" — "}
                  {STAFF_LABELS[request.kind] ?? request.kind}
                </span>
              </p>
              {request.note && (
                <p className="text-muted-foreground truncate text-xs">
                  {request.note}
                </p>
              )}
            </div>
            <span
              className={`shrink-0 text-xs ${overdue ? "text-destructive font-medium" : "text-muted-foreground"}`}
            >
              {waitingLabel(created, new Date(now))}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void clear(request.id)}
            >
              Done
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
