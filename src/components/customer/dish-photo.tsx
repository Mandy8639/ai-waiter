import { cn } from "@/lib/utils";
import type { DinerImage } from "@/lib/menu-images/resolve";

/**
 * A dish photo, wherever one is shown to a diner.
 *
 * Every surface renders through this so the srcset, the loading behaviour
 * and — most importantly — the AI-generated disclosure cannot be got right
 * on one page and forgotten on another.
 *
 * Renders nothing at all when there is no image. A dish without a photo is
 * a designed, text-first card, not a grey box: no placeholder, no stock
 * food, no broken <img>.
 *
 * `next/image` is deliberately not used. The sources here are a Supabase
 * public bucket and, for backfilled legacy images, arbitrary
 * restaurant-supplied hosts that are not known ahead of time — the same
 * reason the rest of the diner UI uses plain <img>. The variants are
 * already sized and WebP-encoded by phase 2, so the optimizer would have
 * nothing left to do.
 */
export function DishPhoto({
  image,
  alt,
  sizes,
  className,
  priority = false,
}: {
  image: DinerImage | null;
  /** The dish name. Never "image of…" — a screen reader already says that. */
  alt: string;
  sizes: string;
  className?: string;
  /** True for the one image above the fold on a dish page. */
  priority?: boolean;
}) {
  if (!image) return null;

  return (
    <div className={cn("relative overflow-hidden", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Supabase public bucket and restaurant-supplied legacy hosts; variants are pre-sized and WebP already */}
      <img
        src={image.src}
        srcSet={image.srcSet || undefined}
        sizes={image.srcSet ? sizes : undefined}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
        className="bg-muted size-full object-cover"
      />
      {image.aiGenerated && <AiGeneratedLabel />}
    </div>
  );
}

/**
 * Always visible on an AI-generated photo, never on a restaurant's own.
 *
 * A diner ordering food is entitled to know the picture is an illustration
 * rather than the plate that will arrive, and that has to survive being
 * read aloud as well as looked at — hence real text rather than an icon,
 * and a label that reads on its own out of context.
 */
function AiGeneratedLabel() {
  return (
    <span className="bg-background/85 text-muted-foreground absolute bottom-1 left-1 rounded-md px-1.5 py-0.5 text-[0.625rem] leading-none font-medium backdrop-blur-sm">
      AI-generated
    </span>
  );
}
