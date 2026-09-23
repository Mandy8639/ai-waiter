/**
 * The server steps of a hero video upload, written against interfaces so
 * they can be tested without a live Supabase.
 *
 * The shape follows src/lib/menu-images/upload-core.ts, for the same
 * reason bytes never travel through a server action there: a Next.js
 * server action body is capped at 1 MB, and a hero video is up to 50 MB.
 * The browser PUTs both files straight to Storage with signed tokens bound
 * to single object paths, then tells us it is done.
 *
 * TWO FILES, ONE ROW. A hero video upload is a video *and* a poster,
 * because there is no ffmpeg to extract a frame. Both are authorized
 * together and both must arrive before the row can be completed — a
 * half-finished upload leaves the row in 'uploading', where the retention
 * engine will eventually collect it.
 *
 * WHAT IS VALIDATED, AND HOW FAR THAT GOES
 *
 *   poster  — fully decoded by sharp, exactly like a dish photo. EXIF and
 *             GPS are stripped; the published stills are WebP.
 *   video   — container header only (see container.ts). It is never
 *             decoded, never transcoded, and its dimensions and duration
 *             are therefore unknown and not recorded.
 *
 * The video's sha256 is deliberately NOT computed. Doing so would mean
 * pulling up to 50 MB through the rendering server on every upload purely
 * to hash it, and the column it would fill is provenance, not a security
 * control — nothing in the system compares it to anything. byte_size and
 * mime_type come from what Storage actually received.
 */
import { createHash } from "node:crypto";
import {
  ImageRejected,
  processUploadedImage,
  type ProcessedImage,
} from "@/lib/menu-images/processing";
import { PUBLISHED_CACHE_CONTROL } from "@/lib/menu-images/upload-core";
import { isValidObjectPath } from "@/lib/menu-images/paths";
import {
  HEADER_BYTES,
  VideoRejected,
  checkVideoSize,
  detectContainer,
} from "./container";
import {
  POSTER_EXTENSION_BY_TYPE,
  POSTER_VARIANTS,
  VIDEO_EXTENSION_BY_TYPE,
  VIDEO_PRIVATE_BUCKET,
  VIDEO_PUBLISHED_BUCKET,
  heroVideoPath,
  heroVideoPrefix,
  posterOriginalPath,
  posterVariantPath,
  type HeroVideoIdentity,
} from "./paths";

/** The subset of Supabase Storage this module needs. */
export interface HeroStorageGateway {
  createSignedUploadUrl(
    bucket: string,
    path: string,
  ): Promise<{ signedUrl: string; token: string }>;
  download(bucket: string, path: string): Promise<Buffer>;
  /**
   * The first `bytes` of an object. Exists so the container check costs a
   * few dozen bytes instead of fifty megabytes — the one place where
   * fetching the whole file would be actively wasteful.
   */
  downloadHead(bucket: string, path: string, bytes: number): Promise<Buffer>;
  /** Size and content type as Storage recorded them, not as the client claimed. */
  stat(
    bucket: string,
    path: string,
  ): Promise<{ sizeBytes: number; contentType: string | null } | null>;
  upload(
    bucket: string,
    path: string,
    body: Buffer,
    options: { contentType: string; cacheControl: string },
  ): Promise<void>;
  remove(bucket: string, paths: string[]): Promise<void>;
  copy(
    fromBucket: string,
    fromPath: string,
    toBucket: string,
    toPath: string,
  ): Promise<void>;
}

/** The phase 4B database functions. */
export interface HeroVideoRecords {
  beginUpload(restaurantId: string): Promise<string>;
  load(videoId: string): Promise<{
    restaurantId: string;
    status: string;
    videoPath: string | null;
    posterPaths: Record<string, string> | null;
  } | null>;
  complete(input: {
    videoId: string;
    videoPath: string;
    posterPaths: Record<string, string>;
    byteSize: number;
    mimeType: string;
    contentSha256: string | null;
  }): Promise<void>;
  fail(videoId: string, error: string): Promise<void>;
  publish(videoId: string): Promise<void>;
}

export interface HeroUploadAuthorization {
  videoId: string;
  video: { path: string; signedUrl: string; token: string };
  poster: { path: string; signedUrl: string; token: string };
}

/**
 * Step 1: authorize one video and one poster.
 *
 * Both tokens are minted from ids the *database* returned, never from
 * client input, and Supabase binds each to its single object path — so a
 * token issued for restaurant A's hero cannot write restaurant B's, and
 * the poster token cannot write the video path.
 */
export async function authorizeHeroUpload(
  input: {
    restaurantId: string;
    videoContentType: string;
    posterContentType: string;
  },
  deps: { records: HeroVideoRecords; storage: HeroStorageGateway },
): Promise<HeroUploadAuthorization> {
  const videoExtension = VIDEO_EXTENSION_BY_TYPE[input.videoContentType];
  if (!videoExtension) {
    throw new VideoRejected(
      "UNSUPPORTED_CONTAINER",
      "Hero videos need to be an MP4 or WebM file.",
    );
  }
  const posterExtension = POSTER_EXTENSION_BY_TYPE[input.posterContentType];
  if (!posterExtension) {
    throw new ImageRejected(
      "UNSUPPORTED_FORMAT",
      "The poster image needs to be a JPEG, PNG or WebP file.",
    );
  }

  const videoId = await deps.records.beginUpload(input.restaurantId);
  const identity: HeroVideoIdentity = {
    restaurantId: input.restaurantId,
    videoId,
  };

  const videoPath = heroVideoPath(identity, videoExtension);
  const posterPath = posterOriginalPath(identity, posterExtension);

  const [video, poster] = await Promise.all([
    deps.storage.createSignedUploadUrl(VIDEO_PRIVATE_BUCKET, videoPath),
    deps.storage.createSignedUploadUrl(VIDEO_PRIVATE_BUCKET, posterPath),
  ]);

  return {
    videoId,
    video: { path: videoPath, ...video },
    poster: { path: posterPath, ...poster },
  };
}

export interface HeroProcessResult {
  videoId: string;
  videoPath: string;
  posterPaths: Record<string, string>;
  processed: ProcessedImage;
}

/**
 * Step 2: check what arrived and record it.
 *
 * Order matters here for the same reason it does for photos: everything is
 * written privately and the row reaches 'pending_review' only. Nothing in
 * this function can put a video in front of a diner.
 *
 * On any failure the row is marked failed and the poster variants written
 * so far are removed. The uploaded video and poster original are left
 * alone — they are the evidence for a retry, and the retention sweep
 * collects them.
 */
export async function processHeroUpload(
  videoId: string,
  deps: { records: HeroVideoRecords; storage: HeroStorageGateway },
): Promise<HeroProcessResult> {
  const record = await deps.records.load(videoId);
  if (!record) {
    throw new VideoRejected("UNREADABLE", "That video could not be found.");
  }
  if (record.status !== "uploading") {
    throw new VideoRejected(
      "UNREADABLE",
      "That video has already been processed.",
    );
  }

  const identity: HeroVideoIdentity = {
    restaurantId: record.restaurantId,
    videoId,
  };
  const prefix = heroVideoPrefix(identity);
  const written: string[] = [];

  try {
    const video = await findVideo(prefix, deps.storage);

    // Size from Storage, not from the browser: the client's claim was only
    // ever a hint, and the bucket is the thing that actually accepted bytes.
    checkVideoSize(video.sizeBytes);

    const header = await deps.storage.downloadHead(
      VIDEO_PRIVATE_BUCKET,
      video.path,
      HEADER_BYTES,
    );
    const container = detectContainer(header, video.declaredType);

    const posterOriginal = await findPosterOriginal(prefix, deps.storage);
    const processed = await processUploadedImage(posterOriginal);

    const posterPaths: Record<string, string> = {};
    for (const variant of processed.variants) {
      // processUploadedImage produces the dish-photo widths; the hero only
      // uses the two it needs. Skipping rather than re-encoding keeps one
      // image pipeline instead of two.
      if (!POSTER_VARIANTS.some((v) => v.name === variant.name)) continue;
      const path = posterVariantPath(identity, variant.name);
      await deps.storage.upload(VIDEO_PRIVATE_BUCKET, path, variant.body, {
        contentType: "image/webp",
        cacheControl: PUBLISHED_CACHE_CONTROL,
      });
      written.push(path);
      posterPaths[variant.name] = path;
    }

    if (Object.keys(posterPaths).length === 0) {
      throw new ImageRejected(
        "TOO_SMALL",
        "That poster image is too small to use.",
      );
    }

    for (const path of [video.path, ...Object.values(posterPaths)]) {
      if (!isValidObjectPath(path, prefix)) {
        throw new VideoRejected("UNREADABLE", "That video could not be saved.");
      }
    }

    await deps.records.complete({
      videoId,
      videoPath: video.path,
      posterPaths,
      byteSize: video.sizeBytes,
      mimeType: container,
      // See the file header: deliberately not computed for the video.
      contentSha256: null,
    });

    return { videoId, videoPath: video.path, posterPaths, processed };
  } catch (error) {
    if (written.length > 0) {
      await deps.storage.remove(VIDEO_PRIVATE_BUCKET, written).catch(() => {});
    }
    await deps.records.fail(videoId, ownerMessage(error)).catch(() => {});
    throw error;
  }
}

/**
 * Publish a reviewed hero video.
 *
 * Copy first, activate second — the same ordering the photo pipeline uses,
 * and for the same reason: the database must never claim a video is live
 * while its public objects are incomplete. If any copy fails, everything
 * already copied is removed and the row stays in 'pending_review', so the
 * menu is exactly as it was.
 */
export async function publishHeroVideo(
  videoId: string,
  deps: { records: HeroVideoRecords; storage: HeroStorageGateway },
): Promise<void> {
  const record = await deps.records.load(videoId);
  if (!record) {
    throw new VideoRejected("UNREADABLE", "That video could not be found.");
  }
  if (record.status !== "pending_review") {
    throw new VideoRejected(
      "UNREADABLE",
      "That video is no longer waiting for review.",
    );
  }
  if (!record.videoPath || !record.posterPaths) {
    throw new VideoRejected(
      "UNREADABLE",
      "That video is not ready to publish.",
    );
  }

  const paths = [record.videoPath, ...Object.values(record.posterPaths)];
  const copied: string[] = [];

  try {
    for (const path of paths) {
      await deps.storage.copy(
        VIDEO_PRIVATE_BUCKET,
        path,
        VIDEO_PUBLISHED_BUCKET,
        path,
      );
      copied.push(path);
    }

    // Verify before activating. A copy that reported success but produced
    // nothing would otherwise become a broken player on the live menu.
    for (const path of paths) {
      const stat = await deps.storage.stat(VIDEO_PUBLISHED_BUCKET, path);
      if (!stat) {
        throw new VideoRejected(
          "UNREADABLE",
          "That video could not be published. Please try again.",
        );
      }
    }

    await deps.records.publish(videoId);
  } catch (error) {
    // Undo the public copies: leaving them would be a video readable by
    // anyone with the URL that no owner ever approved.
    if (copied.length > 0) {
      await deps.storage.remove(VIDEO_PUBLISHED_BUCKET, copied).catch(() => {});
    }
    throw error;
  }
}

/**
 * The extension depends on what the browser said at step 1, which was not
 * stored. Two cheap misses beat adding a column for something derivable —
 * the same trade-off findOriginal() makes for photos.
 */
async function findVideo(
  prefix: string,
  storage: HeroStorageGateway,
): Promise<{ path: string; sizeBytes: number; declaredType: string }> {
  for (const [type, extension] of Object.entries(VIDEO_EXTENSION_BY_TYPE)) {
    const path = `${prefix}original.${extension}`;
    const stat = await storage.stat(VIDEO_PRIVATE_BUCKET, path);
    if (stat) {
      return { path, sizeBytes: stat.sizeBytes, declaredType: type };
    }
  }
  throw new VideoRejected(
    "UNREADABLE",
    "That video was never finished uploading.",
  );
}

async function findPosterOriginal(
  prefix: string,
  storage: HeroStorageGateway,
): Promise<Buffer> {
  for (const extension of ["jpg", "png", "webp"] as const) {
    try {
      return await storage.download(
        VIDEO_PRIVATE_BUCKET,
        `${prefix}poster-original.${extension}`,
      );
    } catch {
      continue;
    }
  }
  throw new ImageRejected(
    "UNREADABLE",
    "The poster image was never finished uploading.",
  );
}

function ownerMessage(error: unknown): string {
  if (error instanceof VideoRejected || error instanceof ImageRejected) {
    return error.message;
  }
  return "That video could not be processed.";
}

/** Exported for the tests; the poster's hash is cheap because we hold the bytes. */
export function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
