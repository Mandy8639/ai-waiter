/**
 * The server side of "generate a picture for this dish".
 *
 * Written against interfaces (no `server-only`, no Supabase client) so the
 * whole lifecycle — including both failure paths — is testable with a fake
 * provider and a fake storage, which matters more than usual here: the
 * real provider cannot be exercised at all today, because no free image
 * model exists. See generation-provider.ts.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN. Two things must never happen: a
 * restaurant losing a quota slot to a request that was never made, and a
 * generated image becoming visible to a diner without a person approving
 * it. The sequence below is arranged around exactly those:
 *
 *   1. preflight            — no quota consumed if the model cannot serve
 *   2. beginGeneration      — NOW the attempt is reserved and counted
 *   3. provider.generate    — the only step that might be billed
 *   4. processUploadedImage — validate and sanitize before anything is stored
 *   5. write PRIVATE only   — never the published bucket, whatever happens
 *   6. complete(...)        — the row reaches 'pending_review', not 'active'
 *
 * Step 1 before step 2 is the whole reason `GenerationUnavailable` and
 * `GenerationFailed` are different types. Step 4 before step 5 means a
 * model returning something that is not an image writes nothing at all.
 * Step 6 stops at 'pending_review' because phase 1's
 * publish_menu_item_image() is the only thing that may make an image live,
 * and an owner has to ask for it — an AI picture of food nobody has
 * plated is precisely the image that must not appear on a menu by itself.
 */
import { buildGenerationPrompt, type DishForPrompt } from "./generation-prompt";
import {
  GenerationFailed,
  GenerationUnavailable,
  type ImageGenerationProvider,
} from "./generation-provider";
import { PRIVATE_BUCKET, imagePrefix, variantPath } from "./paths";
import { ImageRejected, processUploadedImage } from "./processing";
import { PUBLISHED_CACHE_CONTROL, type StorageGateway } from "./upload-core";

/** The phase 1 database functions this flow needs. */
export interface GenerationRecords {
  /**
   * begin_menu_item_image_generation(): enforces every cap from the
   * append-only ledger and returns the image id to generate into. It
   * throws MENU_IMAGE_GENERATION_* when a limit is hit — those are quota
   * answers, not faults, and the caller turns them into owner-readable
   * sentences.
   */
  beginGeneration(menuItemId: string): Promise<string>;
  complete(input: {
    imageId: string;
    originalPath: string;
    variantPaths: Record<string, string>;
    width: number;
    height: number;
    byteSize: number;
    mimeType: string;
    contentSha256: string;
    /** The database refuses an ai_generated image without provider and model. */
    generation: {
      provider: string;
      model: string;
      prompt: string;
    };
  }): Promise<void>;
  fail(imageId: string, error: string): Promise<void>;
  /** The dish, for the prompt. Read through RLS like everything else. */
  loadDish(menuItemId: string): Promise<
    | (DishForPrompt & {
        restaurantId: string;
      })
    | null
  >;
}

export interface GenerateResult {
  imageId: string;
  variantPaths: Record<string, string>;
  prompt: string;
  provider: string;
  model: string;
}

/**
 * Generates one image for one dish and leaves it awaiting review.
 *
 * Throws GenerationUnavailable when nothing was attempted, GenerationFailed
 * when an attempt was made and did not produce a usable image, and
 * ImageRejected when the model returned bytes that are not a usable photo.
 * The last two both leave the image row 'failed' and the attempt counted,
 * because both may have been billed.
 */
export async function generateImage(
  menuItemId: string,
  deps: {
    provider: ImageGenerationProvider;
    records: GenerationRecords;
    storage: StorageGateway;
    timeoutMs: number;
  },
): Promise<GenerateResult> {
  const dish = await deps.records.loadDish(menuItemId);
  if (!dish) {
    throw new GenerationFailed("That dish could not be found.");
  }
  // Built before the quota is reserved: a dish with no usable name can
  // never produce a sound prompt, and finding that out should not cost an
  // attempt.
  const prompt = buildGenerationPrompt(dish);

  // Step 1. Throws GenerationUnavailable, which by design happens before
  // anything is reserved.
  await deps.provider.preflight();

  // Step 2. From here on, the attempt exists in the append-only ledger and
  // counts against the daily caps whatever follows.
  const imageId = await deps.records.beginGeneration(menuItemId);

  const identity = {
    restaurantId: dish.restaurantId,
    menuItemId,
    imageId,
  };
  const prefix = imagePrefix(identity);
  const written: string[] = [];

  try {
    const generated = await deps.provider.generate({
      prompt,
      timeoutMs: deps.timeoutMs,
    });

    // Step 4. Validation before storage: a model that returns an HTML
    // error page, an SVG, a 40-megapixel bomb or a 3-byte stub is
    // rejected here, having written nothing.
    const processed = await processUploadedImage(generated.bytes);

    // The extension comes from what sharp actually decoded, not from what
    // was requested. `output_format: "webp"` is a request, and a provider
    // that ignores it must not leave a PNG sitting at a .webp path.
    const original = `${prefix}original.${extensionFor(processed.source.format)}`;
    await deps.storage.upload(PRIVATE_BUCKET, original, generated.bytes, {
      contentType: `image/${processed.source.format}`,
      cacheControl: PUBLISHED_CACHE_CONTROL,
    });
    written.push(original);

    const variantPaths: Record<string, string> = {};
    for (const variant of processed.variants) {
      const path = variantPath(identity, variant.name);
      // PRIVATE. An AI image that nobody has looked at is the single most
      // important thing in this system never to publish automatically.
      await deps.storage.upload(PRIVATE_BUCKET, path, variant.body, {
        contentType: "image/webp",
        cacheControl: PUBLISHED_CACHE_CONTROL,
      });
      written.push(path);
      variantPaths[variant.name] = path;
    }

    await deps.records.complete({
      imageId,
      originalPath: original,
      variantPaths,
      width: processed.source.width,
      height: processed.source.height,
      byteSize: processed.source.bytes,
      mimeType: `image/${processed.source.format}`,
      contentSha256: processed.source.sha256,
      generation: {
        provider: generated.provider,
        model: generated.model,
        // Kept so an owner reviewing the picture can see what was asked
        // for, and so a bad prompt is diagnosable after the fact.
        prompt,
      },
    });

    return {
      imageId,
      variantPaths,
      prompt,
      provider: generated.provider,
      model: generated.model,
    };
  } catch (error) {
    // Cleanup first, for the same reason as processUpload(): if marking
    // the row failed itself throws, orphaned objects are the worse
    // outcome. Unlike an upload, the original is removed too — it is not
    // evidence for a retry, it is a machine's output that nobody wants.
    if (written.length > 0) {
      await deps.storage.remove(PRIVATE_BUCKET, written).catch(() => {});
    }
    await deps.records.fail(imageId, ownerMessage(error)).catch(() => {});
    throw error;
  }
}

function extensionFor(format: "jpeg" | "png" | "webp"): "jpg" | "png" | "webp" {
  return format === "jpeg" ? "jpg" : format;
}

/**
 * What gets stored on the row's error column, and shown to the owner. A
 * generator's raw error is never surfaced: it can carry provider names,
 * model ids and account state that a restaurant has no use for and should
 * not see.
 */
function ownerMessage(error: unknown): string {
  if (error instanceof ImageRejected) {
    return "The generated image could not be used.";
  }
  if (error instanceof GenerationFailed) {
    return error.message;
  }
  if (error instanceof GenerationUnavailable) {
    return error.message;
  }
  return "The image could not be generated.";
}

/**
 * Quota errors raised by begin_menu_item_image_generation(), turned into
 * sentences an owner can act on. Anything unrecognised falls through to a
 * generic message rather than leaking a Postgres exception.
 */
export function quotaMessage(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (text.includes("MENU_IMAGE_GENERATION_RESTAURANT_LIMIT")) {
    return "This restaurant has used all of today's AI image generations. The limit resets 24 hours after each one.";
  }
  if (text.includes("MENU_IMAGE_GENERATION_ITEM_LIMIT")) {
    return "This dish has used all of today's AI image generations. Try again tomorrow, or upload a photo.";
  }
  if (text.includes("MENU_IMAGE_GENERATION_PENDING_EXISTS")) {
    return "There is already a generated image waiting for review on this dish. Approve or reject it first.";
  }
  if (text.includes("MENU_IMAGE_FORBIDDEN")) {
    return "Only an owner or manager can generate images.";
  }
  return null;
}
