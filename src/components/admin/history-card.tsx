"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { undoChange } from "@/lib/admin/actions";

export interface HistoryRow {
  id: string;
  /** Already worded on the server. */
  when: string;
  who: string;
  what: string;
  change: string;
  test: string | null;
  /** What Undo will do, in words; null when it can't be undone. */
  undo: string | null;
}

/**
 * The Admin page's Change history card (docs/admin.md, Phase 3): the
 * last 50 changes, newest first, each with Undo where it can be undone.
 * Undo asks once, then re-tests the earlier list on the server and only
 * saves it if it passes.
 */
export function HistoryCard({
  rows,
  failedToLoad,
}: {
  rows: HistoryRow[];
  failedToLoad: boolean;
}) {
  const [confirming, setConfirming] = useState<HistoryRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function undo(row: HistoryRow) {
    setMessage(null);
    setError(null);
    start(async () => {
      const result = await undoChange(row.id);
      setConfirming(null);
      if (result.ok) setMessage(result.message);
      else setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Change history</CardTitle>
        <CardDescription>
          Every model change made here, newest first, with the Test that allowed
          it. Undo tests the earlier list again before putting it back.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {message && (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {failedToLoad ? (
          <p className="text-muted-foreground text-sm">
            Couldn&apos;t load the history just now. Reload in a minute.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No changes yet. Each Save, Undo and reset will be listed here.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-1 p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{row.what}</span>
                  <span className="text-muted-foreground text-xs">
                    {row.when} · {row.who}
                  </span>
                </div>
                <p className="text-xs break-words">{row.change}</p>
                {row.test && (
                  <p className="text-muted-foreground text-xs">{row.test}</p>
                )}
                {row.undo && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="self-start"
                    disabled={busy}
                    onClick={() => setConfirming(row)}
                  >
                    Undo
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && !busy && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this change?</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.undo}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy}
              onClick={() => confirming && undo(confirming)}
            >
              {busy ? "Testing and undoing…" : "Undo"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
