"use client";

import { ExternalLink, Star } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { recordGoogleReviewTap } from "@/lib/reviews/actions";
import { cn } from "@/lib/utils";

/**
 * Opens the restaurant's Google review page in a new tab. Shown to every
 * diner alike, whatever they rated (src/lib/reviews/core.ts says why).
 * The tap is counted for the owner with nothing about who tapped.
 */
export function GoogleReviewLink({
  url,
  orderId,
  variant = "button",
  children,
}: {
  url: string;
  orderId: string;
  variant?: "button" | "quiet";
  children: React.ReactNode;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => void recordGoogleReviewTap(orderId)}
      className={cn(
        variant === "button"
          ? buttonVariants({ variant: "outline", size: "sm" })
          : "text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm underline underline-offset-4",
        "gap-1.5",
      )}
    >
      {variant === "button" && <Star className="size-4" aria-hidden="true" />}
      {children}
      <ExternalLink className="size-3.5" aria-hidden="true" />
      <span className="sr-only">(opens Google in a new tab)</span>
    </a>
  );
}
