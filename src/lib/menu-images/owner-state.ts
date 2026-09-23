import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { resolveDinerImage, type ImageSource } from "./resolve";

/**
 * What an owner needs to know about one dish's photo, in the words the UI
 * uses rather than the database's.
 *
 * Deliberately server-side: it reads menu_item_images, which only
 * restaurant members may see, and it decides what a diner would see using
 * the same resolver the diner pages use — so the owner's "this is what
 * diners see now" is literally the diner rule, not a second opinion.
 */

export interface OwnerPhotoState {
  /** The photo diners see right now, if any. */
  current: {
    imageId: string;
    src: string;
    /** A pre-existing image nobody has confirmed yet. */
    unverified: boolean;
    aiGenerated: boolean;
  } | null;
  /** A processed photo waiting for the owner to accept or discard it. */
  pending: { imageId: string } | null;
  /** The most recent failure, so the owner learns why nothing appeared. */
  failed: { imageId: string; error: string | null } | null;
}

interface ImageRow {
  id: string;
  status: string;
  source: ImageSource;
  variant_paths: Record<string, string> | null;
  external_url: string | null;
  error: string | null;
  created_at: string;
}

interface ItemRow {
  active_image_id: string | null;
  image_source: ImageSource | null;
  image_variants: Record<string, string> | null;
  image_url: string | null;
}

export async function loadOwnerPhotoState(
  supabase: Awaited<ReturnType<typeof createClient>>,
  restaurantId: string,
  menuItemId: string,
  supabaseUrl: string,
): Promise<OwnerPhotoState> {
  // database.types.ts predates phase 1; asserted against the migration.
  // See src/lib/menu-images/menu-item-rows.ts.
  const from = supabase.from.bind(supabase) as unknown as (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        eq: (
          column: string,
          value: string,
        ) => {
          maybeSingle: () => Promise<{ data: ItemRow | null }>;
          order: (
            column: string,
            options: { ascending: boolean },
          ) => Promise<{ data: ImageRow[] | null }>;
        };
      };
    };
  };

  const [{ data: item }, { data: images }] = await Promise.all([
    from("menu_items")
      .select("active_image_id, image_source, image_variants, image_url")
      .eq("id", menuItemId)
      .eq("restaurant_id", restaurantId)
      .maybeSingle(),
    from("menu_item_images")
      .select(
        "id, status, source, variant_paths, external_url, error, created_at",
      )
      .eq("menu_item_id", menuItemId)
      .eq("restaurant_id", restaurantId)
      .order("created_at", { ascending: false }),
  ]);

  const rows = images ?? [];

  const diner = item
    ? resolveDinerImage({
        activeImageId: item.active_image_id,
        imageSource: item.image_source,
        imageVariants: item.image_variants,
        legacyImageUrl: item.image_url,
        supabaseUrl,
      })
    : null;

  const current =
    item?.active_image_id && diner
      ? {
          imageId: item.active_image_id,
          src: diner.src,
          unverified: diner.unverified,
          aiGenerated: diner.aiGenerated,
        }
      : null;

  // Newest first, so "the" pending photo is the one just uploaded. More
  // than one should not happen — phase 1 allows a single pending image per
  // dish — but taking the newest is the sane reading if it ever does.
  const pendingRow = rows.find((r) => r.status === "pending_review");
  const failedRow = rows.find((r) => r.status === "failed");

  return {
    current,
    pending: pendingRow ? { imageId: pendingRow.id } : null,
    // A failure only matters while nothing newer has succeeded.
    failed:
      failedRow && !pendingRow
        ? { imageId: failedRow.id, error: failedRow.error }
        : null,
  };
}
