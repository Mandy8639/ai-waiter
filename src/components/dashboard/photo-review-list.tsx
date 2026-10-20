"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  publishMenuPhoto,
  publishMenuPhotosBatch,
  rejectMenuPhoto,
} from "@/lib/menu-images/actions";
import { BULK_PUBLISH_SIZE, chunk } from "@/lib/menu-images/bulk-core";

export interface ReviewItem {
  imageId: string;
  dishName: string;
  /** Short-lived signed preview; null if it couldn't be signed. */
  url: string | null;
}

/**
 * Generated illustrations waiting for approval, all on one page, so a
 * whole menu's worth can be checked at a glance instead of dish by dish.
 * Approving is what puts a picture on the menu; discarding leaves the
 * dish as it was (it can be generated again).
 */
export function PhotoReviewList({
  restaurantId,
  items,
}: {
  restaurantId: string;
  items: ReviewItem[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Handled here already, hidden before the page catches up.
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = items.filter((i) => !handled.has(i.imageId));
  if (shown.length === 0) return null;

  function mark(ids: string[]) {
    setHandled((prev) => new Set([...prev, ...ids]));
  }

  function one(item: ReviewItem, approve: boolean) {
    setError(null);
    setBusy(item.imageId);
    start(async () => {
      const r = approve
        ? await publishMenuPhoto(restaurantId, item.imageId)
        : await rejectMenuPhoto(restaurantId, item.imageId);
      setBusy(null);
      if (!r.ok) {
        setError(`${item.dishName}: ${r.error ?? "that didn't work."}`);
        return;
      }
      mark([item.imageId]);
      router.refresh();
    });
  }

  function approveAll() {
    setError(null);
    const ids = shown.map((i) => i.imageId);
    start(async () => {
      let done = 0;
      for (const batch of chunk(ids, BULK_PUBLISH_SIZE)) {
        setProgress(`Approving ${done} of ${ids.length}…`);
        const r = await publishMenuPhotosBatch(restaurantId, batch);
        done += batch.length;
        if (r.failed > 0 || r.error) {
          setError(
            `${r.failed} couldn't be approved: ${r.error ?? "try again"}.`,
          );
        }
        // Hide the ones that went through; a failed one stays to retry.
        if (r.failed === 0) mark(batch);
      }
      setProgress(null);
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">
            Waiting for your approval ({shown.length})
          </h2>
          <p className="text-muted-foreground text-sm">
            Approve the ones that look right. Diners see them with an
            &ldquo;AI-generated&rdquo; label.
          </p>
        </div>
        <Button type="button" onClick={approveAll} disabled={pending}>
          {progress ?? `Approve all ${shown.length}`}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {shown.map((item) => (
          <li
            key={item.imageId}
            className="flex flex-col overflow-hidden rounded-lg border"
          >
            {item.url ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from the private bucket
              <img
                src={item.url}
                alt={`AI-generated illustration of ${item.dishName}, awaiting approval`}
                loading="lazy"
                className="bg-muted aspect-square w-full object-cover"
              />
            ) : (
              <div className="bg-muted text-muted-foreground flex aspect-square items-center justify-center p-2 text-center text-xs">
                Preview unavailable. Reload the page.
              </div>
            )}
            <div className="flex flex-col gap-2 p-2">
              <span className="truncate text-sm font-medium">
                {item.dishName}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="flex-1"
                  disabled={pending}
                  onClick={() => one(item, true)}
                  aria-label={`Approve the illustration for ${item.dishName}`}
                >
                  {busy === item.imageId ? "…" : "Approve"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={pending}
                  onClick={() => one(item, false)}
                  aria-label={`Discard the illustration for ${item.dishName}`}
                >
                  Discard
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
