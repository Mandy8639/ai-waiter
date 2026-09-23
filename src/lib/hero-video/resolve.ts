/**
 * The one place that decides what hero video a diner sees.
 *
 * Same contract as src/lib/menu-images/resolve.ts: `active_hero_video_id`
 * is the whole answer. If it is null there is no hero, and that is a
 * designed state rather than a failure — most restaurants will never
 * upload one, and a menu without a video is the normal menu.
 *
 * There is no legacy fallback here. `restaurants.cover_image_url` exists
 * and is a URL somebody typed in; it is NOT treated as a hero video's
 * poster, because nobody has ever confirmed what it shows or that the
 * restaurant has the right to publish it. Phase 1 made exactly this
 * decision for menu_items.image_url, and inventing a different answer here
 * would be the beginning of two rules where there should be one.
 */

/** Poster widths, mirroring POSTER_VARIANTS. Kept here so this module stays pure. */
const POSTER_WIDTHS: Record<string, number> = {
  small: 800,
  large: 1600,
};

export interface HeroVideoPointer {
  video: string;
  poster: Record<string, string>;
}

export interface ResolvedHeroVideo {
  /** The video itself. Downloaded only when the diner asks for it. */
  src: string;
  /** What the player shows until then. */
  poster: string;
  posterSrcSet: string;
  /**
   * `sizes` for the poster. The hero is full-bleed inside the menu's own
   * max width, so this matches what the menu page actually renders.
   */
  posterSizes: string;
}

export function publishedVideoUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/restaurant-videos/${path}`;
}

export const HERO_POSTER_SIZES = "(min-width: 768px) 768px, 100vw";

/**
 * Resolves the denormalised `restaurants.hero_video` column, or null.
 *
 * Defensive about the column's contents on purpose: it is jsonb, so the
 * type system's claim about its shape is a promise from the migration
 * rather than something the compiler checked. A malformed value renders no
 * hero, which is the same as the common case and cannot break the menu.
 */
export function resolveHeroVideo({
  activeHeroVideoId,
  heroVideo,
  supabaseUrl,
}: {
  activeHeroVideoId: string | null;
  heroVideo: HeroVideoPointer | null;
  supabaseUrl: string;
}): ResolvedHeroVideo | null {
  if (!activeHeroVideoId || !heroVideo) return null;

  const videoPath = heroVideo.video;
  if (typeof videoPath !== "string" || videoPath.length === 0) return null;

  const poster = heroVideo.poster ?? {};
  const entries = Object.entries(poster).filter(
    ([name, path]) =>
      typeof path === "string" && path.length > 0 && name in POSTER_WIDTHS,
  );
  // A hero with no poster is a grey box with a play button on it. There is
  // nothing to show, so show nothing.
  if (entries.length === 0) return null;

  const sorted = entries.sort(
    (a, b) => POSTER_WIDTHS[a[0]] - POSTER_WIDTHS[b[0]],
  );

  return {
    src: publishedVideoUrl(supabaseUrl, videoPath),
    // The smallest poster is the fallback: a browser ignoring srcset on a
    // phone should not pull the 1600px still.
    poster: publishedVideoUrl(supabaseUrl, sorted[0][1]),
    posterSrcSet: sorted
      .map(
        ([name, path]) =>
          `${publishedVideoUrl(supabaseUrl, path)} ${POSTER_WIDTHS[name]}w`,
      )
      .join(", "),
    posterSizes: HERO_POSTER_SIZES,
  };
}
