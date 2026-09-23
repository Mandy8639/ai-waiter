/**
 * Storage object paths for menu photos, and the buckets they live in.
 *
 * The shape is not ours to choose: phase 1's complete_menu_item_image()
 * refuses any path that is not exactly
 *
 *   {restaurant_id}/{menu_item_id}/{image_id}/<one plain file name>
 *
 * and menu_image_path_is_valid() enforces the file name with the allow-list
 * ^[A-Za-z0-9_-]+(\.[A-Za-z0-9]{1,8})?$ — which is what rules out "..",
 * "./", "//", sub-folders, backslashes and whitespace in one stroke.
 *
 * `isValidObjectPath` below mirrors that rule in TypeScript. The database
 * remains the authority; this copy exists so the server can refuse a bad
 * path *before* minting a signed upload URL for it, rather than discovering
 * the problem after a client has already written bytes somewhere.
 *
 * Both buckets share one key structure, so a single prefix names the
 * original and every variant. Which bucket a path refers to is implied by
 * the column it came from: original_path is always private,
 * variant_paths values are always published.
 */

/**
 * THE INVARIANT
 *
 *   PRIVATE STORAGE = source + processing + review
 *   PUBLIC STORAGE  = explicitly published sanitized derivatives only
 *
 * The same relative key names an object in both buckets, which is
 * convenient and dangerous in equal measure: reading a pending image's
 * variant key as a public URL would expose a photo nobody has approved.
 * So the bucket is never chosen ad hoc at a call site — it is derived from
 * the image's lifecycle status by `variantBucket()` below, and never from
 * anything a client sends.
 */

/** Originals and unpublished variants. No policy; signed URLs only. */
export const PRIVATE_BUCKET = "menu-photos-private";
/** Sanitized variants of published images only. Public-read, service_role-write. */
export const PUBLISHED_BUCKET = "menu-photos";

/** The phase 1 lifecycle, as `menu_item_images.status` records it. */
export type ImageStatus =
  | "uploading"
  | "generating"
  | "pending_review"
  | "active"
  | "superseded"
  | "rejected"
  | "removed"
  | "failed";

/**
 * Statuses whose variants have been copied into the public bucket.
 *
 * Only publish_menu_item_image() reaches 'active', and only an 'active'
 * image can become 'superseded' (replaced) or 'removed' (taken down). Those
 * two keep their public copies deliberately: the 30-day retention window
 * allows an undo, and deleting them the moment a photo is replaced would
 * break URLs a diner's browser is still holding.
 *
 * Everything else — uploading, generating, pending_review, rejected,
 * failed — has never been published. 'rejected' in particular is reachable
 * only from uploading/generating/pending_review, so a rejected image cannot
 * have public objects to clean up.
 */
const PUBLISHED_STATUSES: ReadonlySet<ImageStatus> = new Set([
  "active",
  "superseded",
  "removed",
]);

/** Which bucket holds this image's variants, decided solely by its status. */
export function variantBucket(status: ImageStatus): string {
  return PUBLISHED_STATUSES.has(status) ? PUBLISHED_BUCKET : PRIVATE_BUCKET;
}

/**
 * Whether a variant key may be turned into a diner-facing public URL.
 *
 * Narrower than `variantBucket()` on purpose: a superseded or removed image
 * still *has* public objects during retention, but nothing should render it
 * as the dish's photo. Only the active image is diner-facing.
 */
export function isPubliclyResolvable(status: ImageStatus): boolean {
  return status === "active";
}

/** The file name of the stored original. The extension follows the source format. */
export const ORIGINAL_BASENAME = "original";

/** Mirrors menu_image_path_is_valid()'s file-name allow-list, character for character. */
const FILE_NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9]{1,8})?$/;

/** Mirrors the database's own length ceiling on a stored path. */
const MAX_PATH_LENGTH = 512;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ImageIdentity {
  restaurantId: string;
  menuItemId: string;
  imageId: string;
}

/**
 * The folder every file for one image must sit directly inside.
 *
 * Each segment is checked to be a real UUID. That is not decoration: the
 * prefix is concatenated into paths and compared against what the database
 * builds from its own columns, so a caller-supplied value that is not a
 * UUID could otherwise introduce a "/" and move the folder.
 */
export function imagePrefix({
  restaurantId,
  menuItemId,
  imageId,
}: ImageIdentity): string {
  for (const [name, value] of Object.entries({
    restaurantId,
    menuItemId,
    imageId,
  })) {
    if (!UUID.test(value)) {
      throw new Error(`menu image path: ${name} is not a uuid`);
    }
  }
  return `${restaurantId}/${menuItemId}/${imageId}/`;
}

/**
 * True when `path` is one plain file name directly inside `prefix` — the
 * same question menu_image_path_is_valid() answers in SQL.
 */
export function isValidObjectPath(path: string, prefix: string): boolean {
  if (typeof path !== "string" || typeof prefix !== "string") return false;
  if (path.length > MAX_PATH_LENGTH) return false;
  if (!path.startsWith(prefix)) return false;
  return FILE_NAME.test(path.slice(prefix.length));
}

/** Where the untouched upload goes, in the private bucket. */
export function originalPath(
  identity: ImageIdentity,
  extension: "jpg" | "png" | "webp",
): string {
  return `${imagePrefix(identity)}${ORIGINAL_BASENAME}.${extension}`;
}

/** Where one published variant goes, in the published bucket. */
export function variantPath(identity: ImageIdentity, variant: string): string {
  const path = `${imagePrefix(identity)}${variant}.webp`;
  if (!isValidObjectPath(path, imagePrefix(identity))) {
    throw new Error(
      `menu image path: "${variant}" is not a usable variant name`,
    );
  }
  return path;
}
