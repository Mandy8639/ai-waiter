"use client";

import { useState, useTransition } from "react";
import { Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  askStaffAboutFeedback,
  submitOrderFeedback,
} from "@/lib/feedback/actions";
import { COMMENT_MAX, RATING_WORDS } from "@/lib/feedback/core";
import { cn } from "@/lib/utils";

/**
 * "How was it?" on the diner's own order page, once the order is served
 * (phase N). Private to the restaurant, and it says so. A low rating ends
 * with an offer — never an automatic summons — to have someone come over.
 */
export function OrderFeedbackPanel({
  restaurantSlug,
  orderId,
  items,
  alreadyGiven,
}: {
  restaurantSlug: string;
  orderId: string;
  /** One entry per order line, for the dish thumbs. */
  items: Array<{ id: string; name: string }>;
  alreadyGiven: boolean;
}) {
  const [rating, setRating] = useState(0);
  const [votes, setVotes] = useState<Record<string, boolean>>({});
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | "thanks" | "low" | "asked">(
    alreadyGiven ? "thanks" : null,
  );
  const [pending, start] = useTransition();

  if (done) {
    return (
      <section
        aria-labelledby="feedback-heading"
        className="flex flex-col gap-3 rounded-lg border p-4"
        role="status"
      >
        <h2 id="feedback-heading" className="font-medium">
          {done === "low"
            ? "Sorry it wasn't right"
            : done === "asked"
              ? "Someone's on their way"
              : "Thanks for your feedback"}
        </h2>
        {done === "low" && (
          <>
            <p className="text-muted-foreground text-sm">
              Thank you for telling us. Would you like someone to come over?
            </p>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  start(async () => {
                    const result = await askStaffAboutFeedback(orderId);
                    if (result.ok) setDone("asked");
                    else setError(result.error ?? "Please ask anyone nearby.");
                  });
                }}
              >
                Yes, ask someone to come over
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setDone("thanks")}
              >
                No thanks
              </Button>
            </div>
          </>
        )}
        {done === "asked" && (
          <p className="text-muted-foreground text-sm">
            We&apos;ve let the staff know.
          </p>
        )}
        {done === "thanks" && (
          <p className="text-muted-foreground text-sm">
            It goes straight to the restaurant.
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      aria-labelledby="feedback-heading"
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="feedback-heading" className="font-medium">
          How was everything?
        </h2>
        <p className="text-muted-foreground text-xs">
          Only the restaurant sees this. It isn&apos;t posted anywhere.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Your rating</legend>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className="focus-within:ring-ring/50 cursor-pointer rounded-md p-1 focus-within:ring-3"
            >
              <input
                type="radio"
                name="rating"
                value={n}
                checked={rating === n}
                onChange={() => setRating(n)}
                className="sr-only"
                disabled={pending}
              />
              <Star
                aria-hidden="true"
                className={cn(
                  "size-8 transition-colors",
                  n <= rating
                    ? "fill-amber-400 text-amber-500"
                    : "text-muted-foreground/50",
                )}
              />
              <span className="sr-only">
                {n} {n === 1 ? "star" : "stars"} — {RATING_WORDS[n]}
              </span>
            </label>
          ))}
          {rating > 0 && (
            <span className="text-muted-foreground ml-1 text-sm">
              {RATING_WORDS[rating]}
            </span>
          )}
        </div>
      </fieldset>

      {items.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">The dishes</p>
          <ul className="flex flex-col gap-1.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-sm">{item.name}</span>
                <span className="flex gap-1">
                  {([true, false] as const).map((liked) => {
                    const on = votes[item.id] === liked;
                    const Icon = liked ? ThumbsUp : ThumbsDown;
                    return (
                      <Button
                        key={String(liked)}
                        type="button"
                        size="icon"
                        variant={on ? "default" : "outline"}
                        aria-pressed={on}
                        aria-label={`${liked ? "Liked" : "Didn't like"} ${item.name}`}
                        disabled={pending}
                        onClick={() =>
                          setVotes((prev) => {
                            const next = { ...prev };
                            if (on) delete next[item.id];
                            else next[item.id] = liked;
                            return next;
                          })
                        }
                      >
                        <Icon className="size-4" aria-hidden="true" />
                      </Button>
                    );
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex flex-col gap-1.5 text-sm">
        Anything you&apos;d like the restaurant to know? (optional)
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={COMMENT_MAX}
          rows={3}
          disabled={pending}
        />
      </label>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button
        type="button"
        disabled={pending || rating === 0}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await submitOrderFeedback(
              restaurantSlug,
              orderId,
              items.map((i) => i.id),
              { rating, comment, votes },
            );
            if (!result.ok) setError(result.error ?? "Please try again.");
            else setDone(result.low ? "low" : "thanks");
          });
        }}
      >
        {pending ? "Sending…" : "Send to the restaurant"}
      </Button>
    </section>
  );
}
