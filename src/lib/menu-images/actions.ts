"use server";
import "server-only";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ImageRejected } from "./processing";
import {
  authorizeUpload,
  processUpload,
  publishImage,
  type ImageRecords,
  type StorageGateway,
} from "./upload-core";
import type { ImageStatus } from "./paths";

/**
 * Server actions for the phase 2 upload pipeline.
 *
 * Thin on purpose: every decision lives in upload-core.ts, which is tested
 * directly. This file only binds those interfaces to the real Supabase
 * clients and converts thrown errors into a message an owner can read.
 *
 * Node runtime, not Edge — processUpload() reaches sharp, a native binding.
 * Neither action carries image bytes: the browser PUTs the photo straight
 * to Storage with the signed URL the first action returns, which is what
 * keeps a 2-6 MB phone photo away from the 1 MB server-action body limit.
 *
 * NOTE: the admin client bypasses RLS, and is used here only for Storage —
 * the private bucket has no policy, so nothing else can read or write it.
 * Every database call goes through the request-scoped client so that RLS
 * and the phase 1 functions' own owner/manager checks still apply.
 */

const MANAGERS = ["owner", "manager"] as const;

/**
 * src/lib/supabase/database.types.ts predates the phase 1 migration, so it
 * knows neither menu_item_images nor its functions, and the generated
 * client types reject them by name.
 *
 * Regenerating is not a drop-in fix: the current output differs from the
 * committed file in ~31 places unrelated to this work (nullability on
 * several function returns, a bigint mapped to string), which is its own
 * task. Rather than spread `as any` through this file, the untyped surface
 * is confined to these two helpers, named so it is obvious what they are
 * and easy to delete once the types are regenerated. Every argument passed
 * through them is still checked by ImageRecords in upload-core.ts, and by
 * the database itself.
 */
type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

type UntypedRow = Record<string, unknown>;

function rpcUntilTypesRegenerated(
  supabase: Awaited<ReturnType<typeof createClient>>,
): UntypedRpc {
  return supabase.rpc.bind(supabase) as unknown as UntypedRpc;
}

async function loadImageRowUntilTypesRegenerated(
  supabase: Awaited<ReturnType<typeof createClient>>,
  imageId: string,
): Promise<UntypedRow | null> {
  const from = supabase.from.bind(supabase) as unknown as (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => { maybeSingle: () => Promise<{ data: UntypedRow | null }> };
    };
  };
  const { data } = await from("menu_item_images")
    .select("restaurant_id, menu_item_id, status, variant_paths")
    .eq("id", imageId)
    .maybeSingle();
  return data;
}

export interface StartUploadResult {
  ok: boolean;
  error?: string;
  imageId?: string;
  path?: string;
  /** The browser PUTs the file here. Short-lived, and bound to `path` alone. */
  signedUrl?: string;
  token?: string;
}

function storageGateway(): StorageGateway {
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
    async upload(bucket, path, body, options) {
      const { error } = await admin.storage.from(bucket).upload(path, body, {
        contentType: options.contentType,
        cacheControl: options.cacheControl,
        // Never overwrite: a replacement photo is a new image id and so a
        // new path. Overwriting would also invalidate nothing, since these
        // objects are served with a one-year immutable cache.
        upsert: false,
      });
      if (error) throw new Error(error.message);
    },
    async remove(bucket, paths) {
      const { error } = await admin.storage.from(bucket).remove(paths);
      if (error) throw new Error(error.message);
    },
    async copy(fromBucket, fromPath, toBucket, toPath) {
      // Server-side copy: the published object is byte-identical to the
      // sanitized private one, and no bytes travel through this server.
      const { error } = await admin.storage
        .from(fromBucket)
        .copy(fromPath, toPath, { destinationBucket: toBucket });
      if (error) throw new Error(error.message);
    },
  };
}

function imageRecords(
  supabase: Awaited<ReturnType<typeof createClient>>,
): ImageRecords {
  return {
    async beginUpload(menuItemId) {
      const { data, error } = await rpcUntilTypesRegenerated(supabase)(
        "begin_menu_item_image_upload",
        { p_menu_item_id: menuItemId },
      );
      if (error || !data) {
        throw new Error(error?.message ?? "Could not start the upload.");
      }
      return data as string;
    },
    async load(imageId) {
      // Through RLS: another restaurant's image is absent, not forbidden.
      const data = await loadImageRowUntilTypesRegenerated(supabase, imageId);
      if (!data) return null;
      return {
        restaurantId: data.restaurant_id as string,
        menuItemId: data.menu_item_id as string,
        status: data.status as ImageStatus,
        variantPaths:
          (data.variant_paths as Record<string, string> | null) ?? null,
      };
    },
    async complete(input) {
      const { error } = await rpcUntilTypesRegenerated(supabase)(
        "complete_menu_item_image",
        {
          p_image_id: input.imageId,
          p_original_path: input.originalPath,
          p_variant_paths: input.variantPaths,
          p_width: input.width,
          p_height: input.height,
          p_byte_size: input.byteSize,
          p_mime_type: input.mimeType,
          p_content_sha256: input.contentSha256,
        },
      );
      if (error) throw new Error(error.message);
    },
    async fail(imageId, message) {
      // Best effort: the caller is already handling a failure, and a second
      // one here must not replace the first, more useful error.
      await rpcUntilTypesRegenerated(supabase)("fail_menu_item_image", {
        p_image_id: imageId,
        p_error: message,
      });
    },
    async publish(imageId) {
      const { error } = await rpcUntilTypesRegenerated(supabase)(
        "publish_menu_item_image",
        { p_image_id: imageId },
      );
      if (error) throw new Error(error.message);
    },
  };
}

/**
 * Step 1: authorize one upload. Returns a signed URL bound to a single
 * object path, created only after the caller is confirmed to own or manage
 * the restaurant and the phase 1 function has confirmed the dish is theirs.
 */
export async function startMenuPhotoUpload(
  restaurantId: string,
  menuItemId: string,
  contentType: string,
): Promise<StartUploadResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const result = await authorizeUpload(
      { restaurantId, menuItemId, contentType },
      {
        records: imageRecords(auth.context.supabase),
        storage: storageGateway(),
      },
    );
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

/**
 * Step 2: process what arrived. The image reaches 'pending_review' only —
 * publishing stays a separate, explicit act through phase 1's
 * publish_menu_item_image(), so the photo currently on the menu is
 * untouched until an owner says otherwise.
 */
export async function finishMenuPhotoUpload(
  restaurantId: string,
  imageId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    await processUpload(imageId, {
      records: imageRecords(auth.context.supabase),
      storage: storageGateway(),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

function friendly(error: unknown): string {
  if (error instanceof ImageRejected) return error.message;
  return "That photo could not be processed. Please try again.";
}

/**
 * Publish a reviewed photo. The only route by which an image's variants
 * become publicly readable, and the only route to 'active'.
 *
 * Copies first, activates second (see publishImage): the database never
 * claims an image is active while its public variants are incomplete, and
 * the photo currently on the menu is stepped down only inside the same
 * statement that activates this one.
 */
export async function publishMenuPhoto(
  restaurantId: string,
  imageId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    await publishImage(imageId, {
      records: imageRecords(auth.context.supabase),
      storage: storageGateway(),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}
