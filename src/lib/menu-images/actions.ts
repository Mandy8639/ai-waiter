"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ImageRejected } from "./processing";
import {
  authorizeUpload,
  bucketForVariants,
  processUpload,
  publishImage,
  type ImageRecords,
  type StorageGateway,
} from "./upload-core";
import type { ImageStatus } from "./paths";
import {
  generateImage,
  quotaMessage,
  type GenerationRecords,
} from "./generation-core";
import {
  GenerationFailed,
  GenerationUnavailable,
  configuredModel,
  configuredQuality,
  generationConfigured,
  generationTimeoutMs,
  unavailableMessage,
} from "./generation-provider";
import { OpenRouterImageGenerationProvider } from "./openrouter-image-provider";
import type { ImageGenerationProvider } from "./generation-provider";
import { switchedOffMessage } from "@/lib/admin/restaurant-switches-core";
import { isAiFeatureAllowed } from "@/lib/admin/restaurant-switches";
import { recordAiUsage } from "@/lib/ai/usage";
import { addCall, newTally } from "@/lib/ai/usage-core";

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

/**
 * A short-lived URL for an image that is NOT published yet.
 *
 * Pending variants live in the private bucket, which has no policy at all,
 * so the browser cannot fetch them directly and must not be handed a path
 * pretending to be a URL. Copying them into the public bucket just so an
 * owner can look at them would defeat the whole phase 2 invariant — the
 * review step exists precisely to decide whether they should ever be
 * public.
 *
 * So the server signs a read URL for one object, valid for a few minutes:
 * long enough to review, short enough that it is not a durable public link.
 */
export async function previewMenuPhoto(
  restaurantId: string,
  imageId: string,
): Promise<{ ok: boolean; error?: string; url?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  const records = imageRecords(auth.context.supabase);
  const record = await records.load(imageId);
  // Read through RLS, so another restaurant's image is simply absent.
  if (!record || record.restaurantId !== restaurantId) {
    return { ok: false, error: "That photo could not be found." };
  }

  const variants = record.variantPaths ?? {};
  // The medium variant is the review size; fall back to whatever exists.
  const path = variants.medium ?? variants.large ?? variants.small;
  if (!path) {
    return { ok: false, error: "That photo has not finished processing." };
  }

  const bucket = bucketForVariants(record.status);
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(bucket)
    .createSignedUrl(path, PREVIEW_URL_SECONDS);

  if (error || !data) {
    return { ok: false, error: "That photo could not be shown right now." };
  }
  return { ok: true, url: data.signedUrl };
}

/** Long enough to review a photo, short enough not to be a durable link. */
const PREVIEW_URL_SECONDS = 300;

/**
 * Discard a photo awaiting review. Nothing public ever existed for it —
 * `rejected` is reachable only from uploading, generating or
 * pending_review — so there is no public cleanup to do, and the private
 * material stays for the retention sweep.
 */
export async function rejectMenuPhoto(
  restaurantId: string,
  imageId: string,
): Promise<{ ok: boolean; error?: string }> {
  return runImageRpc(restaurantId, "reject_menu_item_image", {
    p_image_id: imageId,
  });
}

/**
 * Take the current photo off a dish. The row is kept (status `removed`)
 * and its public objects are deliberately left in place for the retention
 * window, so this is undoable and no in-flight browser request breaks.
 */
export async function removeMenuPhoto(
  restaurantId: string,
  menuItemId: string,
): Promise<{ ok: boolean; error?: string }> {
  return runImageRpc(restaurantId, "remove_menu_item_image", {
    p_menu_item_id: menuItemId,
  });
}

/**
 * Record that a pre-existing image really is a photo of this dish.
 *
 * This is the only way an `unverified` image becomes `real`, and it runs
 * through phase 1's own function, which refuses to relabel an AI image.
 * The front end never writes `source`.
 */
export async function confirmLegacyPhotoAuthentic(
  restaurantId: string,
  imageId: string,
): Promise<{ ok: boolean; error?: string }> {
  return runImageRpc(restaurantId, "confirm_menu_item_image_authentic", {
    p_image_id: imageId,
  });
}

/**
 * Shared shape for the lifecycle actions: authorize, call the phase 1
 * function that enforces the rule, revalidate the menu.
 *
 * Every one of these is owner/manager-gated twice — once here for a decent
 * error message, and again inside the database function, which is the
 * boundary that actually holds.
 */
async function runImageRpc(
  restaurantId: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  const { error } = await rpcUntilTypesRegenerated(auth.context.supabase)(
    fn,
    args,
  );
  if (error) return { ok: false, error: friendlyImageError(error.message) };

  revalidatePath("/dashboard/menu");
  return { ok: true };
}

/** Turns the database's error codes into something an owner can act on. */
function friendlyImageError(message: string): string {
  if (message.includes("MENU_IMAGE_FORBIDDEN")) {
    return "You don't have permission to manage this dish's photo.";
  }
  if (message.includes("MENU_IMAGE_INVALID_STATE")) {
    return "That photo is no longer in a state where this is possible. Reload and try again.";
  }
  if (message.includes("MENU_IMAGE_NOT_AUTHENTIC")) {
    return "An AI-generated image can't be confirmed as a restaurant photo.";
  }
  return "That didn't work. Please try again.";
}

/* -------------------------------------------------------------------------
 * Phase 4: AI image generation
 *
 * Shipped switched off. With MENU_IMAGE_MODEL unset — the default, and what
 * production runs — `generationAvailability()` reports UNCONFIGURED, the
 * owner UI renders a disabled button with an explanation, and
 * `generateMenuPhoto` refuses before it authorizes anything. Not one
 * request is made and no quota is touched.
 *
 * It is off because it cannot be on: re-checked 2026-09-23, OpenRouter's
 * dedicated image API lists 54 models and none is free, and the approved
 * zero-cost model (recraft/recraft-v3:free) still reports no serving
 * endpoints. docs/MENU_PHOTO_STRATEGY.md §18 decision 1 requires $0, so
 * the switch stays off until a free model exists or someone decides to pay
 * — at which point this is one environment variable, not a code change.
 * ---------------------------------------------------------------------- */

/**
 * Can the button be offered? Never throws and never calls the network, so
 * a page render cannot be held up by a provider being slow.
 */
export async function generationAvailability(): Promise<{
  available: boolean;
  message?: string;
}> {
  const state = generationConfigured();
  return state.available
    ? { available: true }
    : { available: false, message: unavailableMessage(state.reason) };
}

function generationRecords(
  supabase: Awaited<ReturnType<typeof createClient>>,
): GenerationRecords {
  return {
    async beginGeneration(menuItemId) {
      const { data, error } = await rpcUntilTypesRegenerated(supabase)(
        "begin_menu_item_image_generation",
        { p_menu_item_id: menuItemId },
      );
      // The quota exceptions arrive here. They are rethrown verbatim so
      // quotaMessage() can recognise them; the caller never shows the raw
      // text to an owner.
      if (error || !data) {
        throw new Error(error?.message ?? "Could not start the generation.");
      }
      return data as string;
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
          p_generation: input.generation,
        },
      );
      if (error) throw new Error(error.message);
    },
    async fail(imageId, message) {
      await rpcUntilTypesRegenerated(supabase)("fail_menu_item_image", {
        p_image_id: imageId,
        p_error: message,
      });
    },
    async loadDish(menuItemId) {
      const from = supabase.from.bind(supabase) as unknown as (
        table: string,
      ) => {
        select: (columns: string) => {
          eq: (
            column: string,
            value: string,
          ) => { maybeSingle: () => Promise<{ data: UntypedRow | null }> };
        };
      };
      // Through RLS: a dish in another restaurant is simply absent.
      const { data } = await from("menu_items")
        .select("restaurant_id, name, description, ingredients, category")
        .eq("id", menuItemId)
        .maybeSingle();
      if (!data) return null;
      return {
        restaurantId: data.restaurant_id as string,
        name: (data.name as string) ?? "",
        description: (data.description as string | null) ?? null,
        ingredients: (data.ingredients as string[] | null) ?? null,
        category: (data.category as string | null) ?? null,
      };
    },
  };
}

/**
 * Generate one image for one dish, leaving it in 'pending_review'.
 *
 * Nothing here can put a picture in front of a diner: the generated
 * variants go to the private bucket, and only publishMenuPhoto() — a
 * separate, explicit act by a person — makes an image live.
 */
export async function generateMenuPhoto(
  restaurantId: string,
  menuItemId: string,
): Promise<{ ok: boolean; error?: string; imageId?: string }> {
  // Checked before authorization so that, in the normal disabled state,
  // this costs one environment read and nothing else.
  const state = generationConfigured();
  if (!state.available) {
    return { ok: false, error: unavailableMessage(state.reason) };
  }

  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };
  // Admin Phase 6: dish images are one of the AI menu tools.
  if (!(await isAiFeatureAllowed(restaurantId, "owner_tools"))) {
    return { ok: false, error: switchedOffMessage("owner_tools") };
  }

  const model = configuredModel();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!model || !apiKey) {
    // Unreachable given the check above; kept so the types are honest
    // rather than asserted away with a non-null assertion.
    return { ok: false, error: unavailableMessage("UNCONFIGURED") };
  }

  try {
    const result = await generateImage(menuItemId, {
      provider: recordingCost(
        new OpenRouterImageGenerationProvider({
          apiKey,
          model,
          quality: configuredQuality(model),
        }),
        restaurantId,
      ),
      records: generationRecords(auth.context.supabase),
      storage: storageGateway(),
      timeoutMs: generationTimeoutMs(),
    });
    revalidatePath("/dashboard/menu");
    return { ok: true, imageId: result.imageId };
  } catch (error) {
    // Quota answers first: they are the most actionable thing an owner can
    // be told, and they are not faults.
    const quota = quotaMessage(error);
    if (quota) return { ok: false, error: quota };
    if (error instanceof GenerationUnavailable) {
      return { ok: false, error: error.message };
    }
    if (error instanceof GenerationFailed) {
      return { ok: false, error: error.message };
    }
    if (error instanceof ImageRejected) {
      return { ok: false, error: "The generated image could not be used." };
    }
    return { ok: false, error: "The image could not be generated." };
  }
}

/**
 * Writes each generated image's cost to ai_usage (job "images"), so paid
 * image generation shows on the Admin page's Spending card like every
 * other AI use. A failed generation writes nothing: there is no usage
 * block to read, and the attempt is already counted by the database.
 */
function recordingCost(
  inner: ImageGenerationProvider,
  restaurantId: string,
): ImageGenerationProvider {
  return {
    name: inner.name,
    preflight: () => inner.preflight(),
    async generate(request) {
      const image = await inner.generate(request);
      const tally = newTally();
      addCall(tally, { usage: image.usage }, image.model);
      await recordAiUsage({ tally, job: "images", restaurantId });
      return image;
    },
  };
}
