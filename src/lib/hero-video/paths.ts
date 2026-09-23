/**
 * Where a hero video's objects live.
 *
 * Deliberately the same shape as src/lib/menu-images/paths.ts, one level
 * shallower: a hero video belongs to a restaurant, not to a dish, so the
 * prefix is {restaurant}/{video}/ rather than {restaurant}/{dish}/{image}/.
 *
 * As with photos, which bucket an object lives in is a function of the
 * row's status and nothing else. Being able to ask that question in one
 * place is what stops "is this reachable by a diner?" from being answered
 * differently in three of them.
 */
import { isValidObjectPath } from "@/lib/menu-images/paths";

export const VIDEO_PRIVATE_BUCKET = "restaurant-videos-private";
export const VIDEO_PUBLISHED_BUCKET = "restaurant-videos";

export type HeroVideoStatus =
  | "uploading"
  | "pending_review"
  | "active"
  | "superseded"
  | "rejected"
  | "removed"
  | "failed";

/**
 * Poster widths. Fewer than a dish photo's three, because a hero poster is
 * only ever drawn full-bleed: there is no thumbnail of it anywhere. 800
 * covers a 2x phone, 1600 a 3x phone and any desktop.
 */
export const POSTER_VARIANTS = [
  { name: "small", width: 800 },
  { name: "large", width: 1600 },
] as const;

export type PosterVariantName = (typeof POSTER_VARIANTS)[number]["name"];

export const VIDEO_BASENAME = "original";
export const POSTER_ORIGINAL_BASENAME = "poster-original";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HeroVideoIdentity {
  restaurantId: string;
  videoId: string;
}

export function heroVideoPrefix({
  restaurantId,
  videoId,
}: HeroVideoIdentity): string {
  for (const [name, value] of Object.entries({ restaurantId, videoId })) {
    if (!UUID.test(value)) {
      throw new Error(`hero video path: ${name} is not a uuid`);
    }
  }
  return `${restaurantId}/${videoId}/`;
}

/**
 * Only 'active' is publicly resolvable. A superseded or removed video's
 * objects stay in the published bucket through their retention window — a
 * diner with an open tab or a warm cache is still fetching them — but
 * nothing in the product points at one, because the pointer on
 * `restaurants` was cleared in the same statement that changed the status.
 */
export function isHeroVideoPublic(status: HeroVideoStatus): boolean {
  return status === "active";
}

/**
 * Which bucket a row's objects are in. 'superseded' and 'removed' were
 * published once and were never copied back, so they stay on the public
 * side; everything else has only ever been private.
 */
export function heroVideoBucket(status: HeroVideoStatus): string {
  return status === "active" || status === "superseded" || status === "removed"
    ? VIDEO_PUBLISHED_BUCKET
    : VIDEO_PRIVATE_BUCKET;
}

export function heroVideoPath(
  identity: HeroVideoIdentity,
  extension: "mp4" | "webm",
): string {
  return `${heroVideoPrefix(identity)}${VIDEO_BASENAME}.${extension}`;
}

export function posterOriginalPath(
  identity: HeroVideoIdentity,
  extension: "jpg" | "png" | "webp",
): string {
  return `${heroVideoPrefix(identity)}${POSTER_ORIGINAL_BASENAME}.${extension}`;
}

export function posterVariantPath(
  identity: HeroVideoIdentity,
  variant: string,
): string {
  const prefix = heroVideoPrefix(identity);
  const path = `${prefix}poster-${variant}.webp`;
  // The same allow-list the database enforces, checked here so a bad name
  // fails before a round trip rather than after one.
  if (!isValidObjectPath(path, prefix)) {
    throw new Error(
      `hero video path: "${variant}" is not a usable variant name`,
    );
  }
  return path;
}

export const VIDEO_EXTENSION_BY_TYPE: Record<string, "mp4" | "webm"> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export const POSTER_EXTENSION_BY_TYPE: Record<string, "jpg" | "png" | "webp"> =
  {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
