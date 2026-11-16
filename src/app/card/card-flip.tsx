"use client";

import { useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";

/**
 * Both sides of the visiting card, flipped with a tap. The back carries the
 * card's QR, so someone at the counter can scan it straight off my phone.
 * Users who prefer reduced motion get an instant swap instead of the turn.
 */
export function CardFlip({
  front,
  back,
}: {
  front: ReactNode;
  back: ReactNode;
}) {
  const [showBack, setShowBack] = useState(false);
  const label = showBack ? "Show the front" : "Show the back";

  return (
    <div>
      <button
        type="button"
        onClick={() => setShowBack((v) => !v)}
        aria-label={`${label} of the card`}
        className="focus-visible:ring-ring block w-full rounded-2xl [perspective:1200px] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <div
          className="relative grid transition-transform duration-500 ease-out [transform-style:preserve-3d] motion-reduce:transition-none"
          style={{ transform: showBack ? "rotateY(180deg)" : "none" }}
        >
          <div
            className="[backface-visibility:hidden] [grid-area:1/1]"
            aria-hidden={showBack}
          >
            {front}
          </div>
          <div
            className="[transform:rotateY(180deg)] [backface-visibility:hidden] [grid-area:1/1]"
            aria-hidden={!showBack}
          >
            {back}
          </div>
        </div>
      </button>
      <p className="text-muted-foreground mt-2 flex items-center justify-center gap-1.5 text-xs">
        <RotateCcw className="size-3.5" aria-hidden />
        Tap the card to see the {showBack ? "front" : "back"}
      </p>
    </div>
  );
}
