"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ImageRejected } from "@/lib/menu-images/processing";
import { VideoRejected } from "./container";
import {
  authorizeHeroUpload,
  processHeroUpload,
  publishHeroVideo,
  type HeroStorageGateway,
  type HeroVideoRecords,
} from "./upload-core";
import { VIDEO_PRIVATE_BUCKET } from "./paths";

/**
 * Server actions for the hero video.
 *
 * Thin, like the menu photo actions: every decision lives in upload-core.ts
 * and container.ts, which are tested directly. This file binds those
 * interfaces to the real Supabase clients and turns thrown errors into
 * something an owner can read.
 *
 * Node runtime — processHeroUpload reaches sharp for the poster. No action
 * here carries video bytes: the browser PUTs both files straight to
 * Storage with signed tokens, which is what keeps a 50 MB video away from
 * the 1 MB server-action body limit.
 *
 * As with photos, the admin client is used only for Storage (the private
 * bucket has no policy, so nothing else can reach it) while every database
 * call goes through the request-scoped client, where RLS and the
 * functions' own owner/manager checks still apply.
 */

const MANAGERS = ["owner", "manager"] as const;

/**
 * database.types.ts predates this migration, so the generated client types
 * reject these functions by name. Confined to one helper, as in
 * src/lib/menu-images/actions.ts, and deletable once the types are
 * regenerated — which is its own task (~31 unrelated diffs).
 */
type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpc(supabase: Awaited<ReturnType<typeof createClient>>): UntypedRpc {
  return supabase.rpc.bind(supabase) as unknown as UntypedRpc;
}

function storageGateway(): HeroStorageGateway {
  const admin = createAdminClient();
  return {
    async createSignedUploadUrl(bucket, path) {
      const { data, error } = await admin.storage
        .from(bucket)
        .createSignedUploadUrl(path);
      if (error || !data) {
        throw new Error(error?.message ?? "Could not authorize the upload.");
      }
      return { signedUrl: data.signedUrl, token: data.token };
    },
    async download(bucket, path) {
      const { data, error } = await admin.storage.from(bucket).download(path);
      if (error || !data) throw new Error(error?.message ?? "not found");
      return Buffer.from(await data.arrayBuffer());
    },
    /**
     * A ranged read through a short-lived signed URL. storage-js has no
     * range option, and `download()` would pull the entire file — up to
     * 50 MB through this server — to look at its first 64 bytes.
     */
    async downloadHead(bucket, path, bytes) {
      const { data, error } = await admin.storage
        .from(bucket)
        .createSignedUrl(path, 60);
      if (error || !data) throw new Error(error?.message ?? "not found");
      const response = await fetch(data.signedUrl, {
        headers: { Range: `bytes=0-${bytes - 1}` },
      });
      if (!response.ok && response.status !== 206) {
        throw new Error(`could not read ${path}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      // A server that ignores Range answers 200 with the whole object;
      // taking the head of it is still correct.
      return buffer.subarray(0, bytes);
    },
    async stat(bucket, path) {
      const lastSlash = path.lastIndexOf("/");
      const folder = path.slice(0, lastSlash);
      const name = path.slice(lastSlash + 1);
      const { data, error } = await admin.storage
        .from(bucket)
        .list(folder, { search: name, limit: 100 });
      if (error) throw new Error(error.message);
      const match = (data ?? []).find((entry) => entry.name === name);
      if (!match?.id) return null;
      const metadata = match.metadata as {
        size?: number;
        mimetype?: string;
      } | null;
      return {
        sizeBytes: metadata?.size ?? 0,
        contentType: metadata?.mimetype ?? null,
      };
    },
    async upload(bucket, path, body, options) {
      const { error } = await admin.storage.from(bucket).upload(path, body, {
        contentType: options.contentType,
        cacheControl: options.cacheControl,
        // Never overwrite: a replacement hero is a new video id and so a
        // new path.
        upsert: false,
      });
      if (error) throw new Error(error.message);
    },
    async remove(bucket, paths) {
      const { error } = await admin.storage.from(bucket).remove(paths);
      if (error) throw new Error(error.message);
    },
    async copy(fromBucket, fromPath, toBucket, toPath) {
      const { error } = await admin.storage
        .from(fromBucket)
        .copy(fromPath, toPath, { destinationBucket: toBucket });
      if (error) throw new Error(error.message);
    },
  };
}

function heroRecords(
  supabase: Awaited<ReturnType<typeof createClient>>,
): HeroVideoRecords {
  return {
    async beginUpload(restaurantId) {
      const { data, error } = await rpc(supabase)(
        "begin_restaurant_hero_video_upload",
        { p_restaurant_id: restaurantId },
      );
      if (error || !data) {
        throw new Error(error?.message ?? "Could not start the upload.");
      }
      return data as string;
    },
    async load(videoId) {
      const from = supabase.from.bind(supabase) as unknown as (
        table: string,
      ) => {
        select: (columns: string) => {
          eq: (
            column: string,
            value: string,
          ) => {
            maybeSingle: () => Promise<{
              data: Record<string, unknown> | null;
            }>;
          };
        };
      };
      // Through RLS: another restaurant's video is absent, not forbidden.
      const { data } = await from("restaurant_hero_videos")
        .select("restaurant_id, status, video_path, poster_paths")
        .eq("id", videoId)
        .maybeSingle();
      if (!data) return null;
      return {
        restaurantId: data.restaurant_id as string,
        status: data.status as string,
        videoPath: (data.video_path as string | null) ?? null,
        posterPaths:
          (data.poster_paths as Record<string, string> | null) ?? null,
      };
    },
    async complete(input) {
      const { error } = await rpc(supabase)("complete_restaurant_hero_video", {
        p_video_id: input.videoId,
        p_video_path: input.videoPath,
        p_poster_paths: input.posterPaths,
        p_byte_size: input.byteSize,
        p_mime_type: input.mimeType,
        p_content_sha256: input.contentSha256,
      });
      if (error) throw new Error(error.message);
    },
    async fail(videoId, message) {
      // Best effort: the caller is already handling a failure and a second
      // one must not replace the first, more useful error.
      await rpc(supabase)("fail_restaurant_hero_video", {
        p_video_id: videoId,
        p_error: message,
      });
    },
    async publish(videoId) {
      const { error } = await rpc(supabase)("publish_restaurant_hero_video", {
        p_video_id: videoId,
      });
      if (error) throw new Error(error.message);
    },
  };
}

export interface StartHeroUploadResult {
  ok: boolean;
  error?: string;
  videoId?: string;
  video?: { path: string; token: string };
  poster?: { path: string; token: string };
}

/** Step 1: authorize one video and one poster. */
export async function startHeroVideoUpload(
  restaurantId: string,
  videoContentType: string,
  posterContentType: string,
): Promise<StartHeroUploadResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const result = await authorizeHeroUpload(
      { restaurantId, videoContentType, posterContentType },
      {
        records: heroRecords(auth.context.supabase),
        storage: storageGateway(),
      },
    );
    return {
      ok: true,
      videoId: result.videoId,
      video: { path: result.video.path, token: result.video.token },
      poster: { path: result.poster.path, token: result.poster.token },
    };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

/** Step 2: check the container, build the posters, stop at pending_review. */
export async function finishHeroVideoUpload(
  restaurantId: string,
  videoId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    await processHeroUpload(videoId, {
      records: heroRecords(auth.context.supabase),
      storage: storageGateway(),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

/**
 * Publish a reviewed hero video. Copies first, activates second, so the
 * database never claims a video is live while its public objects are
 * incomplete.
 */
export async function publishHeroVideoAction(
  restaurantId: string,
  videoId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    await publishHeroVideo(videoId, {
      records: heroRecords(auth.context.supabase),
      storage: storageGateway(),
    });
    revalidatePath("/dashboard/settings");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

export async function rejectHeroVideo(
  restaurantId: string,
  videoId: string,
): Promise<{ ok: boolean; error?: string }> {
  return runHeroRpc(restaurantId, "reject_restaurant_hero_video", {
    p_video_id: videoId,
  });
}

export async function removeHeroVideo(
  restaurantId: string,
): Promise<{ ok: boolean; error?: string }> {
  return runHeroRpc(restaurantId, "remove_restaurant_hero_video", {
    p_restaurant_id: restaurantId,
  });
}

/** A short-lived read URL so an owner can watch what they uploaded. */
export async function previewHeroVideo(
  restaurantId: string,
  videoId: string,
): Promise<{ ok: boolean; error?: string; video?: string; poster?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  const record = await heroRecords(auth.context.supabase).load(videoId);
  if (!record || record.restaurantId !== restaurantId || !record.videoPath) {
    return { ok: false, error: "That video could not be found." };
  }

  const admin = createAdminClient();
  const posterPath = Object.values(record.posterPaths ?? {})[0];
  const [video, poster] = await Promise.all([
    admin.storage
      .from(VIDEO_PRIVATE_BUCKET)
      .createSignedUrl(record.videoPath, 600),
    posterPath
      ? admin.storage
          .from(VIDEO_PRIVATE_BUCKET)
          .createSignedUrl(posterPath, 600)
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (!video.data?.signedUrl) {
    return { ok: false, error: "That video could not be loaded." };
  }
  return {
    ok: true,
    video: video.data.signedUrl,
    poster: poster.data?.signedUrl,
  };
}

async function runHeroRpc(
  restaurantId: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  const { error } = await rpc(auth.context.supabase)(fn, args);
  if (error) return { ok: false, error: friendlyDbError(error.message) };

  revalidatePath("/dashboard/settings");
  return { ok: true };
}

function friendly(error: unknown): string {
  if (error instanceof VideoRejected || error instanceof ImageRejected) {
    return error.message;
  }
  if (error instanceof Error) {
    const mapped = friendlyDbError(error.message);
    if (mapped) return mapped;
  }
  return "That video could not be processed. Please try again.";
}

/** The database's error codes, in words an owner can act on. */
function friendlyDbError(message: string): string {
  if (message.includes("HERO_VIDEO_UPLOAD_IN_FLIGHT")) {
    return "There is already a video waiting for review. Approve or discard it first.";
  }
  if (message.includes("HERO_VIDEO_FORBIDDEN")) {
    return "You don't have permission to manage this restaurant's video.";
  }
  if (message.includes("HERO_VIDEO_INVALID_STATE")) {
    return "That video is no longer in a state where this is possible. Reload and try again.";
  }
  if (message.includes("HERO_VIDEO_INVALID_PATH")) {
    return "That video could not be saved.";
  }
  return "";
}
