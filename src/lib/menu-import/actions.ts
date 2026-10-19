"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
import { createAdminClient } from "@/lib/supabase/admin";
import type { StorageGateway } from "@/lib/menu-images/upload-core";
import { extractMenuFromImages } from "./vision";
import {
  ImportUploadRejected,
  authorizeImportUpload,
  loadImportPageDataUrls,
  type ImportRecords,
} from "./upload-core";

/**
 * Server actions for importing a menu from uploaded photographs.
 *
 * The flow is deliberately three steps with a human in the middle:
 *   upload -> extract (drafts) -> review & correct -> commit
 *
 * Nothing here writes to menu_items. Only commit_menu_import() does, and it
 * refuses an unpriced row rather than defaulting it — see the migration.
 */

const MANAGERS = ["owner", "manager"] as const;

export interface MenuImportState {
  error?: string;
  notice?: string;
}

/**
 * Storage access for import pages.
 *
 * The admin client is used for two operations only: minting a signed
 * upload URL for one exact object, and downloading a page the server
 * itself recorded. Every database read stays on the request-scoped client
 * so RLS still applies.
 */
function storageGateway(): Pick<
  StorageGateway,
  "createSignedUploadUrl" | "download" | "remove"
> {
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
    async remove(bucket, paths) {
      const { error } = await admin.storage.from(bucket).remove(paths);
      if (error) throw new Error(error.message);
    },
  };
}

function importRecords(
  supabase: Awaited<ReturnType<typeof createClient>>,
): ImportRecords {
  return {
    async create({ importId, restaurantId, sourcePaths }) {
      const { error } = await supabase.from("menu_imports").insert({
        id: importId,
        restaurant_id: restaurantId,
        status: "uploaded",
        source_paths: sourcePaths,
      });
      if (error) throw new Error(toFriendlyError(error, "menu import"));
    },
    async load(importId) {
      const { data } = await supabase
        .from("menu_imports")
        .select("restaurant_id, status, source_paths")
        .eq("id", importId)
        .maybeSingle();
      if (!data) return null;
      return {
        restaurantId: data.restaurant_id,
        status: data.status,
        sourcePaths: data.source_paths ?? [],
      };
    },
  };
}

export interface StartImportResult {
  ok: boolean;
  error?: string;
  importId?: string;
  pages?: Array<{
    index: number;
    path: string;
    signedUrl: string;
    token: string;
  }>;
}

/**
 * Step 1: create the import and authorize one upload per page.
 *
 * Carries no image bytes. The browser sends only how many pages it has and
 * what type each one is, and receives a credential bound to a single
 * server-chosen object path per page.
 */
export async function startMenuImport(
  restaurantId: string,
  contentTypes: string[],
): Promise<StartImportResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const result = await authorizeImportUpload(
      { restaurantId, contentTypes },
      {
        records: importRecords(auth.context.supabase),
        storage: storageGateway() as StorageGateway,
      },
    );
    return { ok: true, importId: result.importId, pages: result.pages };
  } catch (error) {
    return { ok: false, error: friendlyImportError(error) };
  }
}

/**
 * Step 2: extract, once every page has been uploaded.
 *
 * Takes an import id and nothing else. The page paths are read from the
 * row the server wrote, so a caller cannot point extraction at an object
 * it chose. Extraction itself is untouched: it receives the same data URLs
 * it always did, built here from the private objects instead of in the
 * browser.
 */
export async function extractUploadedImport(
  restaurantId: string,
  importId: string,
): Promise<MenuImportState> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { error: auth.error };

  const supabase = auth.context.supabase;
  const records = importRecords(supabase);

  let imageDataUrls: string[];
  try {
    imageDataUrls = await loadImportPageDataUrls(importId, restaurantId, {
      records,
      storage: storageGateway() as StorageGateway,
    });
  } catch (error) {
    const message = friendlyImportError(error);
    // A page that never arrived is recorded on the row, like any other
    // failure, so an abandoned import is diagnosable afterwards.
    await supabase
      .from("menu_imports")
      .update({ status: "failed", error: message })
      .eq("id", importId)
      .eq("restaurant_id", restaurantId);
    return { error: message };
  }

  await supabase
    .from("menu_imports")
    .update({ status: "extracting" })
    .eq("id", importId)
    .eq("restaurant_id", restaurantId);

  const result = await extractMenuFromImages({ imageDataUrls });

  if (!result.ok) {
    // Recorded on the row rather than only shown once, so a failed import
    // is still visible and diagnosable afterwards.
    await supabase
      .from("menu_imports")
      .update({
        status: "failed",
        error: result.error ?? "Extraction failed.",
        extraction_model: result.model ?? null,
      })
      .eq("id", importId);
    return { error: result.error };
  }

  const { error: itemsError } = await supabase.from("menu_import_items").insert(
    result.drafts.map((d) => ({
      import_id: importId,
      restaurant_id: restaurantId,
      category_name: d.categoryName,
      name: d.name,
      price: d.price,
      display_order: d.displayOrder,
    })),
  );

  if (itemsError) {
    await supabase
      .from("menu_imports")
      .update({
        status: "failed",
        error: toFriendlyError(itemsError, "menu items"),
      })
      .eq("id", importId);
    return { error: toFriendlyError(itemsError, "menu items") };
  }

  await supabase
    .from("menu_imports")
    .update({ status: "review", extraction_model: result.model ?? null })
    .eq("id", importId);

  redirect(`/dashboard/menu/import/${importId}`);
}

function friendlyImportError(error: unknown): string {
  if (error instanceof ImportUploadRejected) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "That menu import could not be started. Please try again.";
}

/** Saves the reviewer's corrections. Called before commit, and on its own as a save. */
export async function saveImportReview(
  restaurantId: string,
  importId: string,
  rows: Array<{
    id: string;
    name: string;
    price: number | null;
    include: boolean;
  }>,
): Promise<MenuImportState> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();

  for (const row of rows) {
    const { error } = await supabase
      .from("menu_import_items")
      .update({ name: row.name, price: row.price, include: row.include })
      .eq("id", row.id)
      .eq("import_id", importId)
      .eq("restaurant_id", restaurantId);
    if (error) return { error: toFriendlyError(error, "menu import") };
  }

  revalidatePath(`/dashboard/menu/import/${importId}`);
  return { notice: "Changes saved." };
}

export async function commitImport(
  restaurantId: string,
  _prev: MenuImportState,
  formData: FormData,
): Promise<MenuImportState> {
  const importId = String(formData.get("importId") ?? "");
  if (!importId) return { error: "Missing import." };

  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { error } = await supabase.rpc("commit_menu_import", {
    p_import_id: importId,
  });

  if (error) {
    // The function's own raised codes, turned into something a restaurant
    // owner can act on.
    const message = error.message ?? "";
    if (message.includes("MENU_IMPORT_UNPRICED_ITEMS")) {
      return {
        error:
          "Some items still have no price. Add a price, or untick them, then try again.",
      };
    }
    if (message.includes("MENU_IMPORT_PRICE_CONFLICT")) {
      return {
        error:
          "Some dishes are listed twice in the same section at different prices. Untick one, fix a price, or rename one, then save and try again.",
      };
    }
    if (message.includes("MENU_IMPORT_ALREADY_COMMITTED")) {
      return { error: "This import has already been added to your menu." };
    }
    if (message.includes("MENU_IMPORT_FORBIDDEN")) {
      return { error: "You don't have permission to change this menu." };
    }
    if (message.includes("MENU_IMPORT_NOT_READY")) {
      return { error: "This import isn't ready to add yet." };
    }
    return { error: toFriendlyError(error, "menu import") };
  }

  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}
