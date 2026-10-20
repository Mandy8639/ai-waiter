"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
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
import { generateMenuPhotosBatch } from "@/lib/menu-images/actions";
import { BULK_BATCH_SIZE, chunk } from "@/lib/menu-images/bulk-core";

/**
 * "Generate for all dishes": an illustration for every dish without a
 * photo, BULK_BATCH_SIZE at a time, driven from the browser so no single
 * request runs long. Every image waits in the review list below until the
 * owner approves it; nothing reaches diners from here.
 */
export function BulkPhotoGenerator({
  restaurantId,
  targetIds,
  unavailable,
}: {
  restaurantId: string;
  /** Dishes with no photo and nothing already waiting, in menu order. */
  targetIds: string[];
  /** Why generation can't run right now, or null when it can. */
  unavailable: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<{
    generated: number;
    failed: number;
    message: string | null;
    stopped: "limit" | "unavailable" | "you" | null;
  } | null>(null);
  const stopRequested = useRef(false);

  const count = targetIds.length;
  if (count === 0 && !result && !pending) return null;

  function run() {
    setConfirming(false);
    setResult(null);
    stopRequested.current = false;
    // The list as it is now: the page refreshes between batches, and the
    // run should finish what it set out to do, not chase a moving target.
    const batches = chunk(targetIds, BULK_BATCH_SIZE);
    setProgress({ done: 0, total: targetIds.length });
    start(async () => {
      let generated = 0;
      let failed = 0;
      let message: string | null = null;
      let stopped: "limit" | "unavailable" | "you" | null = null;
      for (const batch of batches) {
        if (stopRequested.current) {
          stopped = "you";
          break;
        }
        const r = await generateMenuPhotosBatch(restaurantId, batch);
        generated += r.generated;
        failed += r.failed;
        if (r.message) message = r.message;
        setProgress((p) => ({ ...p, done: p.done + batch.length }));
        if (r.stop) {
          stopped = r.stop === "restaurant_limit" ? "limit" : "unavailable";
          break;
        }
      }
      setResult({ generated, failed, message, stopped });
      router.refresh();
    });
  }

  const minutes = Math.max(1, Math.round((count / BULK_BATCH_SIZE) * 0.25));

  return (
    <section className="bg-ai-soft/40 flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="flex items-center gap-2 font-medium">
            <Sparkles className="size-4" aria-hidden="true" />
            Generate illustrations for every dish
          </h2>
          <p className="text-muted-foreground text-sm">
            {count > 0
              ? `${count} ${count === 1 ? "dish has" : "dishes have"} no photo. `
              : ""}
            Each gets a drawn illustration, labelled &ldquo;AI-generated&rdquo;
            for diners. Nothing goes on your menu until you approve it below.
          </p>
          {unavailable && (
            <p className="text-destructive mt-1 text-sm">{unavailable}</p>
          )}
        </div>
        {pending ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              stopRequested.current = true;
            }}
          >
            Stop after this batch
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={count === 0 || unavailable !== null}
          >
            Generate {count > 0 ? count : ""} illustrations
          </Button>
        )}
      </div>

      {pending && (
        <div role="status" className="flex flex-col gap-2 text-sm">
          <div
            className="bg-muted h-2 overflow-hidden rounded-full"
            aria-hidden="true"
          >
            <div
              className="bg-primary h-full transition-all"
              style={{
                width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <p className="text-muted-foreground">
            Drawing {progress.done} of {progress.total}… Keep this page open;
            finished ones appear for review below as they arrive.
          </p>
        </div>
      )}

      {result && !pending && (
        <p role="status" className="text-sm">
          {result.generated > 0
            ? `${result.generated} ${result.generated === 1 ? "illustration is" : "illustrations are"} ready for your review below.`
            : "No illustrations were made."}{" "}
          {result.stopped === "you" && "Stopped. Press again to carry on. "}
          {result.stopped === "limit" &&
            "Today's limit was reached; the rest can be made tomorrow. "}
          {result.stopped === "unavailable" && result.message && (
            <span className="text-destructive">{result.message} </span>
          )}
          {result.failed > 0 &&
            result.stopped !== "unavailable" &&
            `${result.failed} couldn't be made (${result.message ?? "try those dishes again"}).`}
        </p>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Generate {count} {count === 1 ? "illustration" : "illustrations"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This takes about {minutes} {minutes === 1 ? "minute" : "minutes"}{" "}
              with this page open. Each illustration waits for your approval
              before diners see it, and you can stop at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <Button type="button" onClick={run}>
              Start
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
