/* eslint-disable @next/next/no-img-element -- see ART below: pre-made WebP, no image component */
import type { ChefMotion, ChefPose } from "@/lib/chef/core";
import { cn } from "@/lib/utils";

/**
 * The Chef character: one pose, at one size.
 *
 * Always decorative — hidden from assistive technology, with an empty alt —
 * because everything a pose "means" is already said in text beside it
 * (the reply, the waiting label, the button). A screen reader never hears
 * the Chef, and never needs to (docs/accessibility.md).
 *
 * ART: placeholder, one flattened WebP per pose in public/chef/ (7–8 KB
 * each, made once from the PNGs with sharp). A plain <img>, not
 * next/image: measured in phase 7, next/image would add about 7 KB of
 * compressed JavaScript to every diner page — Chef or not — to save a few
 * KB of image on Chef pages only. The final art is layered vector, where a
 * blink or a wave moves one part; until then a motion moves the whole
 * figure, gently.
 *
 * MOTION: classes defined in globals.css only for people who haven't
 * asked for reduced motion (tests/unit/chef-motion-css.test.ts). With
 * reduced motion, the pose itself still says what's happening.
 */
const POSES: Record<
  ChefPose,
  {
    width: number;
    height: number;
    /** Head centre across the canvas, 0–1. */
    headX: number;
  }
> = {
  hello: { width: 179, height: 256, headX: 0.4 },
  curious: { width: 159, height: 255, headX: 0.44 },
  thinking: { width: 184, height: 257, headX: 0.38 },
  found: { width: 189, height: 260, headX: 0.52 },
  oops: { width: 164, height: 261, headX: 0.45 },
  neutral: { width: 127, height: 268, headX: 0.5 },
};

/** How much of the figure a head-and-shoulders crop shows. */
const BUST_VISIBLE = 0.58;

export function ChefArt({
  pose,
  size,
  crop = "bust",
  motion,
  className,
}: {
  pose: ChefPose;
  /** In CSS px: the square box for a bust, the height for a full figure. */
  size: number;
  /** "bust" crops to head and shoulders in a square; "full" shows the whole pose. */
  crop?: "bust" | "full";
  motion?: ChefMotion;
  className?: string;
}) {
  const art = POSES[pose];
  const src = `/chef/${pose}.webp`;
  const motionClass = motion ? `chef-motion-${motion}` : undefined;

  if (crop === "full") {
    const width = Math.round((size * art.width) / art.height);
    return (
      <span
        aria-hidden="true"
        data-chef-pose={pose}
        className={cn("inline-block shrink-0", className)}
        style={{ width, height: size }}
      >
        <img
          src={src}
          alt=""
          width={width}
          height={size}
          decoding="async"
          draggable={false}
          className={cn("block h-full w-full", motionClass)}
        />
      </span>
    );
  }

  const height = Math.round(size / BUST_VISIBLE);
  const width = Math.round((height * art.width) / art.height);
  return (
    <span
      aria-hidden="true"
      data-chef-pose={pose}
      className={cn(
        "relative inline-block shrink-0 overflow-hidden",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <img
        src={src}
        alt=""
        width={width}
        height={height}
        decoding="async"
        draggable={false}
        className={cn("absolute top-0 max-w-none", motionClass)}
        style={{ left: Math.round(size / 2 - art.headX * width), height }}
      />
    </span>
  );
}
