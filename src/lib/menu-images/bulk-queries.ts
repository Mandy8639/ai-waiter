import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { createClient } from "@/lib/supabase/server";
import { PRIVATE_BUCKET } from "./paths";

/**
 * What the Menu photos page needs for "Generate for all dishes" and the
 * review list: which dishes have an image waiting or being made, and a
 * short-lived preview link for each generated image awaiting approval.
 */

export interface PendingReview {
  imageId: string;
  menuItemId: string;
  /** Signed for PREVIEW_SECONDS; null if signing failed. */
  url: string | null;
}

interface ImageRow {
  id: string;
  menu_item_id: string;
  status: string;
  source: string;
  variant_paths: Record<string, string> | null;
}

/**
 * Pending variants live in the private bucket with no policy, so the
 * browser is handed signed URLs (as previewMenuPhoto does for one dish).
 * Half an hour: long enough to work through a big menu's review list,
 * short enough not to be a durable public link. Reloading signs afresh.
 */
const PREVIEW_SECONDS = 1800;

export async function loadBulkPhotoState(
  supabase: Awaited<ReturnType<typeof createClient>>,
  restaurantId: string,
): Promise<{ busyDishIds: Set<string>; pending: PendingReview[] }> {
  // database.types.ts predates menu_item_images; asserted against the
  // migration (see src/lib/menu-images/menu-item-rows.ts).
  const from = supabase.from.bind(supabase) as unknown as (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        in: (
          column: string,
          values: string[],
        ) => {
          order: (
            column: string,
            options: { ascending: boolean },
          ) => Promise<{ data: ImageRow[] | null }>;
        };
      };
    };
  };

  // Through RLS: only this restaurant's members can read these rows.
  const { data } = await from("menu_item_images")
    .select("id, menu_item_id, status, source, variant_paths")
    .eq("restaurant_id", restaurantId)
    .in("status", ["generating", "pending_review"])
    .order("created_at", { ascending: true });
  const rows = data ?? [];

  const busyDishIds = new Set(rows.map((r) => r.menu_item_id));
  const waiting = rows.filter(
    (r) => r.status === "pending_review" && r.source === "ai_generated",
  );
  if (waiting.length === 0) return { busyDishIds, pending: [] };

  const paths = waiting.map(
    (r) =>
      r.variant_paths?.medium ??
      r.variant_paths?.large ??
      r.variant_paths?.small ??
      null,
  );
  const signable = paths.filter((p): p is string => p !== null);
  const signed = new Map<string, string>();
  if (signable.length > 0) {
    const { data: urls } = await createAdminClient()
      .storage.from(PRIVATE_BUCKET)
      .createSignedUrls(signable, PREVIEW_SECONDS);
    for (const u of urls ?? []) {
      if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
    }
  }

  return {
    busyDishIds,
    pending: waiting.map((r, i) => ({
      imageId: r.id,
      menuItemId: r.menu_item_id,
      url: paths[i] ? (signed.get(paths[i]) ?? null) : null,
    })),
  };
}
