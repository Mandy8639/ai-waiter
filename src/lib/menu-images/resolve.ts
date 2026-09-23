/**
 * The one place that decides which image a diner sees, and at what size.
 *
 * Before this existed, every page answered "image_url, or active_image, or
 * variant_paths?" for itself. That is exactly how a removed photo comes
 * back to life on one page and not another, or how an unreviewed
 * replacement leaks onto a menu. So the rules live here, pages render what
 * they are given, and the rules are tested once.
 *
 * WHY THIS READS menu_items AND NOT menu_item_images
 *
 * menu_item_images is readable by restaurant members only
 * (menu_item_images_select_members), and a diner is not a member — a QR
 * scan creates an anonymous auth user with no membership. Phase 1 planned
 * for that: publish_menu_item_image() denormalises the published variant
 * keys and the source onto menu_items.image_variants / image_source, which
 * diners already read. So diner rendering needs no join, no new policy and
 * no wider grant.
 *
 * THE TWO RULES THAT MATTER
 *
 *   1. `active_image_id` is the whole answer. It is set only by
 *      publish_menu_item_image() and cleared only by
 *      remove_menu_item_image(), so a pending, rejected, failed or
 *      superseded image is never pointed at, and a replacement is invisible
 *      until it is published.
 *
 *   2. A removed photo does not come back. remove_menu_item_image() clears
 *      the pointer and deliberately leaves menu_items.image_url alone, so
 *      falling back to that column would put the photo an owner just took
 *      down straight back on the menu. It is therefore never a fallback:
 *      it is read only when the pointer says there IS an active image that
 *      has no processed variants, which is the backfilled legacy case.
 */

export type ImageSource = "real" | "ai_generated" | "unverified";

/** The image-related columns of a menu_items row, as a diner can read them. */
export interface MenuItemImageColumns {
  /** Set only by publish; cleared only by remove. Null means: no photo. */
  activeImageId: string | null;
  imageSource: ImageSource | null;
  /** Published object keys by variant name; null for a backfilled legacy image. */
  imageVariants: Record<string, string> | null;
  /** The restaurant's own pre-existing URL. Only meaningful with a pointer. */
  legacyImageUrl: string | null;
}

export interface ResolveInput extends MenuItemImageColumns {
  /** e.g. https://<ref>.supabase.co — from NEXT_PUBLIC_SUPABASE_URL. */
  supabaseUrl: string;
}

export interface DinerImage {
  /** The default source: the middle variant, or the legacy URL. */
  src: string;
  /** Empty for a legacy URL, which has only one size. */
  srcSet: string;
  /** True when this image must carry a visible "AI-generated" label. */
  aiGenerated: boolean;
  /**
   * A pre-existing URL nobody has confirmed. Rendered, because it is what
   * the restaurant already had on their menu, but never presented as
   * verified photography.
   */
  unverified: boolean;
}

/** Widths phase 2 produces. Kept in step with VARIANTS in processing.ts. */
const VARIANT_WIDTHS: Record<string, number> = {
  small: 400,
  medium: 800,
  large: 1600,
};

/** Published objects are served from the public bucket by Supabase Storage. */
export function publishedUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/menu-photos/${path}`;
}

/**
 * The image a diner should see for this dish, or null for "no photo" —
 * which is a designed state, not a failure.
 */
export function resolveDinerImage({
  activeImageId,
  imageSource,
  imageVariants,
  legacyImageUrl,
  supabaseUrl,
}: ResolveInput): DinerImage | null {
  // No published image. Note what this does NOT do: fall back to
  // legacyImageUrl. See rule 2 above.
  if (!activeImageId) return null;

  const aiGenerated = imageSource === "ai_generated";
  const unverified = imageSource === "unverified";

  const variants = Object.entries(imageVariants ?? {}).filter(
    ([name, path]) => name in VARIANT_WIDTHS && typeof path === "string",
  );

  if (variants.length > 0) {
    const sorted = variants.sort(
      (a, b) => VARIANT_WIDTHS[a[0]] - VARIANT_WIDTHS[b[0]],
    );
    const srcSet = sorted
      .map(
        ([name, path]) =>
          `${publishedUrl(supabaseUrl, path)} ${VARIANT_WIDTHS[name]}w`,
      )
      .join(", ");

    // A browser that ignores srcset gets the middle size where there is
    // one, rather than the 1600px file on a phone.
    const fallback = sorted[Math.min(1, sorted.length - 1)];

    return {
      src: publishedUrl(supabaseUrl, fallback[1]),
      srcSet,
      aiGenerated,
      unverified,
    };
  }

  // An active image with no processed variants is the backfilled legacy
  // case: the URL the restaurant already had, now pointed at by a real
  // image record whose source says whether anyone has vouched for it.
  if (legacyImageUrl) {
    return { src: legacyImageUrl, srcSet: "", aiGenerated, unverified };
  }

  // Pointed at something with nothing to show. A broken <img> is worse
  // than the no-photo card.
  return null;
}

/**
 * `sizes` for a menu card. The card draws at 96px, 112px from `sm` up, so
 * even a 3x phone needs only ~336px and the 400px variant is plenty.
 */
export const CARD_SIZES = "(min-width: 640px) 112px, 96px";

/**
 * `sizes` for the dish page, where the image is full-bleed inside a
 * max-w-2xl column: about 640px at most, less on a phone.
 */
export const DETAIL_SIZES = "(min-width: 672px) 640px, 100vw";
