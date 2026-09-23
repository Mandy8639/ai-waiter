/**
 * The two server steps of a photo upload, written against interfaces rather
 * than concrete clients so both can be tested without a live Supabase.
 *
 * Step 1, `authorizeUpload`, decides *where* one specific upload may go and
 * hands back a short-lived credential for exactly that object. Step 2,
 * `processUpload`, fetches what arrived, puts it through sharp and records
 * the result.
 *
 * Why bytes never touch a server action: a Next.js server action body is
 * capped at 1 MB by default (node_modules/next/dist/docs, serverActions),
 * next.config.ts does not raise it, and a phone photo is 2-6 MB. Raising
 * the cap would mean streaming whole photos through the rendering server
 * for no benefit. Instead the browser PUTs straight to Storage with a
 * signed token and then tells us it is done.
 *
 * The authorization chain, in order, is what makes a token unusable
 * anywhere else:
 *
 *   1. authorizeRestaurantAction  — signed in, member, owner or manager
 *   2. begin_menu_item_image_upload — phase 1 re-checks the caller owns the
 *      restaurant AND that the dish belongs to it, then mints a fresh image
 *      id; a caller cannot supply one
 *   3. the path is computed from ids the *database* returned, never from
 *      client input
 *   4. the signed token is bound by Supabase to that single object path
 *
 * So a token issued for restaurant A / dish X / image Y cannot write dish
 * Z, another restaurant, or an arbitrary key: there is no parameter left
 * for the client to influence. The private bucket has no RLS policy at all
 * (see 20260922090000_menu_photo_storage.sql), so a signed token is the
 * only way in — an ambient session, however privileged, writes nothing.
 */
import {
  ImageRejected,
  processUploadedImage,
  type ProcessedImage,
} from "./processing";
import {
  ORIGINAL_BASENAME,
  PRIVATE_BUCKET,
  PUBLISHED_BUCKET,
  imagePrefix,
  isValidObjectPath,
  variantBucket,
  variantPath,
  type ImageIdentity,
  type ImageStatus,
} from "./paths";

/** The subset of Supabase Storage this module needs, so tests can supply their own. */
export interface StorageGateway {
  createSignedUploadUrl(
    bucket: string,
    path: string,
  ): Promise<{ signedUrl: string; token: string }>;
  download(bucket: string, path: string): Promise<Buffer>;
  upload(
    bucket: string,
    path: string,
    body: Buffer,
    options: { contentType: string; cacheControl: string },
  ): Promise<void>;
  remove(bucket: string, paths: string[]): Promise<void>;
  /**
   * Server-side copy between buckets. Supabase's /object/copy takes a
   * destinationBucket, so publishing never downloads and re-uploads bytes —
   * which also means the published object is byte-identical to the
   * sanitized private one, not a second encoding of it.
   */
  copy(
    fromBucket: string,
    fromPath: string,
    toBucket: string,
    toPath: string,
  ): Promise<void>;
}

/** The phase 1 database functions, likewise. */
export interface ImageRecords {
  beginUpload(menuItemId: string): Promise<string>;
  /**
   * The row for an image the caller may see, read through RLS. `status`
   * decides which bucket the variants live in, so it is typed as the
   * lifecycle it actually is rather than a bare string.
   */
  load(imageId: string): Promise<{
    restaurantId: string;
    menuItemId: string;
    status: ImageStatus;
    variantPaths: Record<string, string> | null;
  } | null>;
  complete(input: {
    imageId: string;
    originalPath: string;
    variantPaths: Record<string, string>;
    width: number;
    height: number;
    byteSize: number;
    mimeType: string;
    contentSha256: string;
  }): Promise<void>;
  fail(imageId: string, error: string): Promise<void>;
  /** phase 1's publish_menu_item_image(): activates this one, steps the old one down. */
  publish(imageId: string): Promise<void>;
}

/**
 * Published variants are immutable — a replacement photo is a new image id
 * and therefore a new path, never an overwrite — so they can be cached for
 * a year with no invalidation story to get wrong.
 *
 * SECONDS, NOT A DIRECTIVE. Supabase Storage builds the header itself: the
 * client sends `cache-control: max-age=<this>` and the server prepends
 * `public, `. Passing a full directive here nests it, and production served
 * `public, max-age=public, max-age=31536000, immutable` for the first photo
 * ever published — a duplicated, part-invalid header whose caching
 * behaviour is implementation-defined, which is the opposite of the year we
 * are asking for. `immutable` cannot be set through this API at all; the
 * long max-age is the whole of what we get, and it is enough, because the
 * paths are never reused.
 *
 * The private upload is the only place this is set. Publishing is a
 * server-side /object/copy, which carries the source object's metadata
 * across, so the public object inherits whatever the private one was given.
 */
export const PUBLISHED_CACHE_CONTROL = "31536000";

const EXTENSION_BY_TYPE: Record<string, "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface UploadAuthorization {
  imageId: string;
  /** The one object path this upload may write. */
  path: string;
  signedUrl: string;
  token: string;
}

/**
 * Step 1. Creates the image record and returns a credential for one object.
 *
 * `contentType` only picks the stored file's extension. It is the client's
 * claim and is not trusted as a format decision — step 2 decides the real
 * format by decoding the bytes, and will refuse a PNG that arrived calling
 * itself a JPEG.
 */
export async function authorizeUpload(
  {
    restaurantId,
    menuItemId,
    contentType,
  }: { restaurantId: string; menuItemId: string; contentType: string },
  deps: { records: ImageRecords; storage: StorageGateway },
): Promise<UploadAuthorization> {
  const extension = EXTENSION_BY_TYPE[contentType];
  if (!extension) {
    throw new ImageRejected(
      "UNSUPPORTED_FORMAT",
      "Please upload a JPEG, PNG or WebP photo.",
    );
  }

  // The image id comes from the database, which has just re-verified that
  // this caller may manage this dish. Nothing the client sent reaches the
  // path except the choice of extension.
  const imageId = await deps.records.beginUpload(menuItemId);
  const identity: ImageIdentity = { restaurantId, menuItemId, imageId };
  const path = `${imagePrefix(identity)}${ORIGINAL_BASENAME}.${extension}`;

  const { signedUrl, token } = await deps.storage.createSignedUploadUrl(
    PRIVATE_BUCKET,
    path,
  );
  return { imageId, path, signedUrl, token };
}

export interface ProcessResult {
  imageId: string;
  variantPaths: Record<string, string>;
  processed: ProcessedImage;
}

/**
 * Step 2. Fetches the uploaded original, validates and sanitizes it, writes
 * the variants and records them.
 *
 * Ordering is what protects the photo currently on the menu: variants are
 * written to Storage *before* the database is told they exist, and the
 * image only reaches 'pending_review'. Phase 1 alone decides when an image
 * becomes active, through publish_menu_item_image(), so a failure anywhere
 * in here leaves the live menu exactly as it was.
 *
 * On any failure the image row is marked failed with a customer-safe
 * message and every variant already written is removed, so the database
 * never claims files that are missing and Storage never keeps files nothing
 * references. The original is deliberately left in place: it is the
 * evidence for a retry, and the retention sweep will collect it.
 */
export async function processUpload(
  imageId: string,
  deps: { records: ImageRecords; storage: StorageGateway },
): Promise<ProcessResult> {
  const record = await deps.records.load(imageId);
  if (!record) {
    throw new ImageRejected("UNREADABLE", "That photo could not be found.");
  }
  if (record.status !== "uploading") {
    throw new ImageRejected(
      "UNREADABLE",
      "That photo has already been processed.",
    );
  }

  const identity: ImageIdentity = {
    restaurantId: record.restaurantId,
    menuItemId: record.menuItemId,
    imageId,
  };
  const prefix = imagePrefix(identity);
  const written: string[] = [];

  try {
    const original = await findOriginal(prefix, deps.storage);
    const processed = await processUploadedImage(original.body);

    const variantPaths: Record<string, string> = {};
    for (const variant of processed.variants) {
      const path = variantPath(identity, variant.name);
      // PRIVATE, not published. Processing finishing is not approval:
      // the image is about to become 'pending_review', and nothing about
      // it may be publicly readable until an owner publishes it.
      await deps.storage.upload(PRIVATE_BUCKET, path, variant.body, {
        contentType: "image/webp",
        cacheControl: PUBLISHED_CACHE_CONTROL,
      });
      written.push(path);
      variantPaths[variant.name] = path;
    }

    // Belt and braces: the database re-checks every path against the same
    // allow-list and would refuse anything outside this image's folder.
    for (const path of [original.path, ...Object.values(variantPaths)]) {
      if (!isValidObjectPath(path, prefix)) {
        throw new ImageRejected("UNREADABLE", "That photo could not be saved.");
      }
    }

    await deps.records.complete({
      imageId,
      originalPath: original.path,
      variantPaths,
      width: processed.source.width,
      height: processed.source.height,
      byteSize: processed.source.bytes,
      mimeType: `image/${processed.source.format}`,
      contentSha256: processed.source.sha256,
    });

    return { imageId, variantPaths, processed };
  } catch (error) {
    // Cleanup first: if marking the row failed itself throws, we would
    // rather have removed the orphans than kept them.
    if (written.length > 0) {
      await deps.storage.remove(PRIVATE_BUCKET, written).catch(() => {});
    }
    const message =
      error instanceof ImageRejected
        ? error.message
        : "That photo could not be processed.";
    await deps.records.fail(imageId, message);
    throw error;
  }
}

/**
 * The original's extension depends on what the browser said at step 1, and
 * that answer was not stored anywhere — so try each accepted extension.
 * Three cheap misses beat adding a column to the phase 1 schema for
 * something derivable.
 */
async function findOriginal(
  prefix: string,
  storage: StorageGateway,
): Promise<{ path: string; body: Buffer }> {
  for (const extension of ["jpg", "png", "webp"] as const) {
    const path = `${prefix}${ORIGINAL_BASENAME}.${extension}`;
    try {
      return { path, body: await storage.download(PRIVATE_BUCKET, path) };
    } catch {
      continue;
    }
  }
  throw new ImageRejected(
    "UNREADABLE",
    "That photo was never finished uploading.",
  );
}

/**
 * Publish a reviewed image: copy its sanitized variants into the public
 * bucket, then activate it in the database.
 *
 * This is the ONLY place bytes become publicly readable. Processing
 * finishing is not approval — an image sits at 'pending_review' with every
 * object private until an owner or manager explicitly publishes it. The
 * rule holds regardless of `source`, so a future AI generation follows the
 * identical path (generate -> private -> process -> private variants ->
 * pending_review -> approve -> public copy -> active) and has no shortcut
 * into public storage.
 *
 * Ordering is the whole point, because the two stores cannot be updated
 * atomically together:
 *
 *   1. copy every required variant to the public bucket
 *   2. confirm every copy succeeded
 *   3. only then run publish_menu_item_image(), which activates this image
 *      and steps the previous one down in one statement
 *   4. if that database call fails, remove the objects just copied
 *
 * So the database never claims an image is active while its public variants
 * are incomplete. The reverse is possible for a moment — public objects
 * that exist while the image is still 'pending_review' — and that window is
 * deliberate and safe: nothing in the database points at them, so no diner
 * UI can resolve them (isPubliclyResolvable() admits only 'active'), and
 * step 4 removes them. They are unreferenced orphans at unguessable paths
 * for the duration of one failed call, never a published photo.
 *
 * The previous active image is untouched by any failure here: it is only
 * stepped down inside step 3, which either runs completely or not at all.
 */
export async function publishImage(
  imageId: string,
  deps: { records: ImageRecords; storage: StorageGateway },
): Promise<{ imageId: string; publishedPaths: string[] }> {
  const record = await deps.records.load(imageId);
  if (!record) {
    throw new ImageRejected("UNREADABLE", "That photo could not be found.");
  }
  if (record.status !== "pending_review") {
    throw new ImageRejected(
      "UNREADABLE",
      "That photo is not waiting to be published.",
    );
  }

  const paths = Object.values(record.variantPaths ?? {});
  if (paths.length === 0) {
    // Refusing beats publishing a dish photo that resolves to nothing.
    throw new ImageRejected(
      "UNREADABLE",
      "That photo has no processed variants to publish.",
    );
  }

  const prefix = imagePrefix({
    restaurantId: record.restaurantId,
    menuItemId: record.menuItemId,
    imageId,
  });

  const copied: string[] = [];
  try {
    for (const path of paths) {
      // The keys came from the database, but they are re-checked against
      // this image's own folder before anything is made public.
      if (!isValidObjectPath(path, prefix)) {
        throw new ImageRejected(
          "UNREADABLE",
          "That photo could not be published.",
        );
      }
      await deps.storage.copy(PRIVATE_BUCKET, path, PUBLISHED_BUCKET, path);
      copied.push(path);
    }

    if (copied.length !== paths.length) {
      throw new ImageRejected(
        "UNREADABLE",
        "That photo could not be published.",
      );
    }

    await deps.records.publish(imageId);
    return { imageId, publishedPaths: copied };
  } catch (error) {
    // Everything this call made public is removed again. The private
    // originals and variants stay: the image is still 'pending_review' and
    // can be published again once the cause is fixed.
    if (copied.length > 0) {
      await deps.storage.remove(PUBLISHED_BUCKET, copied).catch(() => {});
    }
    throw error;
  }
}

/**
 * The bucket an image's variants currently live in, for callers that need
 * to read or link them. Derived from status alone — never from client
 * input — so a pending image's key cannot be mistaken for a public URL.
 */
export function bucketForVariants(status: ImageStatus): string {
  return variantBucket(status);
}
