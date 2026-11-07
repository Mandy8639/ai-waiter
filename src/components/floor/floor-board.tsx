"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { listenToTopic } from "@/lib/supabase/realtime";
import {
  resolvePollIntervalMs,
  shouldPollNow,
} from "@/components/kitchen/kds-reconciliation";
import {
  FLOOR_STATES,
  FLOOR_STATE_LABELS,
  attentionSummary,
  floorTiles,
  needsAttention,
  type FloorRow,
  type FloorState,
  type FloorTile,
} from "@/lib/floor/core";
import { STAFF_LABELS, waitingLabel } from "@/lib/table-requests/core";
import { resolveServiceRequest } from "@/lib/table-requests/actions";
import { clearFloorTable, loadFloor } from "@/lib/floor/actions";
import { cn } from "@/lib/utils";

/**
 * The floor: every table, one tile each, live.
 *
 * Same live pattern as the request queue (service-request-queue.tsx):
 * Broadcast on the restaurant's private `orders:` and `requests:` topics
 * triggers a full re-read of floor_tables(), and a safety-net poll plus
 * re-reads on reconnect, wake and network return cover missed messages.
 * A guest scanning the code isn't broadcast, so "Seated" arrives with the
 * poll, which is fine for the least urgent state.
 */

const STATE_STYLES: Record<FloorState, string> = {
  needs_waiter: "border-destructive/50 bg-destructive/5",
  wants_bill: "border-destructive/50 bg-destructive/5",
  food_ready: "border-warning/60 bg-warning/10",
  ordered: "border-info/40 bg-info/5",
  eating: "border-success/40 bg-success/5",
  paid: "border-success/40",
  seated: "border-border",
  free: "border-dashed border-border bg-transparent",
};

const DOT_STYLES: Record<FloorState, string> = {
  needs_waiter: "bg-destructive",
  wants_bill: "bg-destructive",
  food_ready: "bg-warning",
  ordered: "bg-info",
  eating: "bg-success",
  paid: "bg-success/50",
  seated: "bg-muted-foreground/60",
  free: "bg-muted-foreground/25",
};

export function FloorBoard({
  restaurantId,
  basicMode,
  initial,
}: {
  restaurantId: string;
  basicMode: boolean;
  initial: FloorRow[];
}) {
  const [rows, setRows] = useState(initial);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Taps this screen just made, kept until a read agrees, so a refresh
  // already in flight can't bring a cleared request or table back (the
  // request queue learned this in the 2026-10-28 busy-night simulation).
  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  // Table id -> the newest read issued when its clear was confirmed
  // (Infinity while it is still saving). A read issued after that one
  // already reflects the clear, so the override can go.
  const [cleared, setCleared] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  // Only the newest read may write; one read at a time, plus one queued.
  const seqRef = useRef(0);
  const reading = useRef(false);
  const readAgain = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (reading.current) {
      readAgain.current = true;
      return;
    }
    reading.current = true;
    const seq = ++seqRef.current;
    let next: FloorRow[] | null = null;
    try {
      next = await loadFloor(restaurantId);
    } catch {
      next = null;
    } finally {
      reading.current = false;
      if (readAgain.current) {
        readAgain.current = false;
        queueMicrotask(() => void refreshRef.current());
      }
    }
    if (!next || seq !== seqRef.current) return;
    const stillOpen = new Set(next.flatMap((row) => requestIds(row)));
    setCleared((current) => {
      const kept = [...current].filter(([, confirmedAt]) => seq <= confirmedAt);
      return kept.length === current.size ? current : new Map(kept);
    });
    setDoneIds((current) => {
      const kept = [...current].filter((id) => stillOpen.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
    setRows(next);
    setNow(Date.now());
  }, [restaurantId]);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const supabase = createClient();
    const closers = [
      `orders:restaurant:${restaurantId}`,
      `requests:restaurant:${restaurantId}`,
    ].map((topic) =>
      listenToTopic(supabase, topic, {
        onMessage: () => void refresh(),
        onStatus: (status) => {
          const live = status === "SUBSCRIBED";
          setConnected(live);
          if (live) void refresh();
        },
      }),
    );
    return () => closers.forEach((close) => close());
  }, [restaurantId, refresh]);

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

  const tiles = useMemo(() => {
    const adjusted = rows.map((row): FloorRow => {
      if (cleared.has(row.table_id)) {
        // Cleared here, not yet reflected in a read: show it free.
        return {
          ...row,
          seated_since: null,
          open_requests: [],
          active_orders: 0,
          ready_orders: 0,
          served_orders: 0,
          unpaid_orders: 0,
          unpaid_total: 0,
        };
      }
      if (!Array.isArray(row.open_requests)) return row;
      return {
        ...row,
        open_requests: (row.open_requests as { id?: unknown }[]).filter(
          (r) => typeof r?.id !== "string" || !doneIds.has(r.id),
        ),
      };
    });
    return floorTiles(adjusted, { basicMode, now: new Date(now) });
  }, [rows, now, basicMode, cleared, doneIds]);

  async function done(requestId: string) {
    if (doneIds.has(requestId)) return;
    setDoneIds((current) => new Set(current).add(requestId));
    const result = await resolveServiceRequest(restaurantId, requestId);
    if (!result.ok) {
      setDoneIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
      setError(result.error ?? null);
    }
    void refresh();
  }

  async function clear(tableId: string) {
    setCleared((current) => new Map(current).set(tableId, Infinity));
    const result = await clearFloorTable(restaurantId, tableId);
    const confirmedAt = seqRef.current;
    setCleared((current) => {
      const next = new Map(current);
      if (result.ok) next.set(tableId, confirmedAt);
      else next.delete(tableId);
      return next;
    });
    if (!result.ok) setError(result.error ?? null);
    void refresh();
  }

  if (tiles.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <p className="font-medium">No tables yet</p>
        <p className="text-muted-foreground mt-1 text-sm">
          Add your tables and they&apos;ll appear here during service.
        </p>
        <Link
          href="/dashboard/tables"
          className="text-primary mt-3 inline-block text-sm underline-offset-4 hover:underline"
        >
          Go to Tables
        </Link>
      </div>
    );
  }

  const busy = tiles.filter((t) => t.state !== "free").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm" aria-live="polite">
          <span
            className={cn(
              "font-medium",
              tiles.some((t) => needsAttention(t.state)) && "text-destructive",
            )}
          >
            {attentionSummary(tiles)}
          </span>
          <span className="text-muted-foreground">
            {" · "}
            {busy} of {tiles.length} tables in use
          </span>
        </p>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-success" : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          {connected ? "Live" : "Updating every few seconds"}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      <ul
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
        aria-label="Tables"
      >
        {tiles.map((tile) => (
          <li key={tile.tableId}>
            <TableTile
              tile={tile}
              now={now}
              basicMode={basicMode}
              onDone={done}
              onClear={clear}
            />
          </li>
        ))}
      </ul>

      <ul
        className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs"
        aria-label="What the colours mean"
      >
        {FLOOR_STATES.filter((s) => !(basicMode && s === "paid")).map(
          (state) => (
            <li key={state} className="flex items-center gap-1.5">
              <span
                className={cn("size-2 rounded-full", DOT_STYLES[state])}
                aria-hidden
              />
              {FLOOR_STATE_LABELS[state]}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function TableTile({
  tile,
  now,
  basicMode,
  onDone,
  onClear,
}: {
  tile: FloorTile;
  now: number;
  basicMode: boolean;
  onDone: (requestId: string) => void;
  onClear: (tableId: string) => void;
}) {
  const since = tile.since
    ? waitingLabel(new Date(tile.since), new Date(now))
    : null;
  const extras = [
    tile.state !== "ordered" && tile.counts.active > 0
      ? `${tile.counts.active} cooking`
      : null,
    tile.state !== "food_ready" && tile.counts.ready > 0
      ? `${tile.counts.ready} ready`
      : null,
  ].filter(Boolean);

  return (
    <article
      aria-label={`${tile.label}: ${FLOOR_STATE_LABELS[tile.state]}`}
      data-state={tile.state}
      className={cn(
        "bg-card flex h-full min-h-36 flex-col gap-2 rounded-xl border-2 p-3",
        STATE_STYLES[tile.state],
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <h2 className="text-lg leading-tight font-semibold tracking-tight">
          {tile.label}
        </h2>
        {since && (
          <span className="text-muted-foreground shrink-0 pt-0.5 text-xs tabular-nums">
            {since}
          </span>
        )}
      </header>

      <p
        className={cn(
          "flex items-center gap-1.5 text-sm font-medium",
          tile.state === "free" && "text-muted-foreground font-normal",
        )}
      >
        <span
          className={cn("size-2 shrink-0 rounded-full", DOT_STYLES[tile.state])}
          aria-hidden
        />
        {FLOOR_STATE_LABELS[tile.state]}
      </p>
      {tile.detail && (
        <p className="text-muted-foreground line-clamp-2 text-xs">
          {tile.detail}
        </p>
      )}
      {extras.length > 0 && (
        <p className="text-muted-foreground text-xs">{extras.join(" · ")}</p>
      )}

      {tile.requests.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {tile.requests.map((request) => (
            <li key={request.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs">
                {STAFF_LABELS[request.kind]}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDone(request.id)}
                aria-label={`Done: ${tile.label} ${STAFF_LABELS[request.kind].toLowerCase()}`}
              >
                Done
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {tile.owed && !basicMode && (
          <Link
            href="/dashboard/checkout"
            className="text-primary text-xs underline-offset-4 hover:underline"
          >
            Settle up
          </Link>
        )}
        {tile.occupied && tile.requests.length === 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground ml-auto"
            onClick={() => onClear(tile.tableId)}
            aria-label={`Clear ${tile.label}`}
          >
            Clear table
          </Button>
        )}
      </div>
    </article>
  );
}

function requestIds(row: FloorRow): string[] {
  if (!Array.isArray(row.open_requests)) return [];
  return (row.open_requests as { id?: unknown }[])
    .map((r) => r?.id)
    .filter((id): id is string => typeof id === "string");
}
