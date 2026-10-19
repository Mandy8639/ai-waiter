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
import { resetAllModels } from "@/lib/admin/actions";

/**
 * The Admin page's Emergency reset (docs/admin.md, Phase 3): one confirm,
 * then every job is back on its Vercel variable or built-in default. The
 * escape hatch for "something I saved is going wrong and I don't know
 * which": there is no "save without testing", so this is the fast way out.
 */
export function ResetCard({ savedCount }: { savedCount: number }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function reset() {
    setError(null);
    start(async () => {
      const result = await resetAllModels();
      setOpen(false);
      if (result.ok) setDone(true);
      else setError(result.error);
    });
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base">Emergency reset</CardTitle>
        <CardDescription>
          Clears every model list saved on this page, so every AI job goes back
          to its Vercel variable or built-in default within about a minute. Use
          it if something you saved is misbehaving and you don&apos;t know
          which. It&apos;s recorded in the history, with what it cleared. To use
          a cleared list again, pick it with Change and Test it as usual.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {done && (
          <Alert>
            <AlertDescription>
              Done. Every job is back on its default.
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          type="button"
          variant="destructive"
          className="self-start"
          disabled={busy || savedCount === 0}
          onClick={() => setOpen(true)}
        >
          Reset all models
        </Button>
        {savedCount === 0 && !done && (
          <p className="text-muted-foreground text-xs">
            Nothing is saved here right now, so there&apos;s nothing to reset.
          </p>
        )}
      </CardContent>

      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset every AI model?</AlertDialogTitle>
            <AlertDialogDescription>
              {savedCount === 1
                ? "The one job with a list saved here"
                : `The ${savedCount} jobs with a list saved here`}{" "}
              will go back to their Vercel variable or built-in default within
              about a minute.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={reset}
            >
              {busy ? "Resetting…" : "Reset all models"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
