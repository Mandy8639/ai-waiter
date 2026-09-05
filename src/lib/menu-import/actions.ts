"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
import { extractMenuFromImages } from "./vision";

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

/** Pages are read in the browser and posted as data URLs — see the upload form. */
export async function createAndExtractImport(
  restaurantId: string,
  _prev: MenuImportState,
  formData: FormData,
): Promise<MenuImportState> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { error: auth.error };

  const pages = formData.getAll("page").map(String).filter(Boolean);
  if (pages.length === 0) {
    return { error: "Add at least one photo of your menu." };
  }
  if (pages.length > 8) {
    // A practical ceiling: more pages in one call means a longer request
    // and a likelier truncation, both of which read as "it broke".
    return { error: "Please import up to 8 pages at a time." };
  }

  const supabase = await createClient();

  const { data: created, error: createError } = await supabase
    .from("menu_imports")
    .insert({ restaurant_id: restaurantId, status: "extracting" })
    .select("id")
    .single();

  if (createError || !created) {
    return { error: toFriendlyError(createError, "menu import") };
  }

  const result = await extractMenuFromImages({ imageDataUrls: pages });

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
      .eq("id", created.id);
    return { error: result.error };
  }

  const { error: itemsError } = await supabase.from("menu_import_items").insert(
    result.drafts.map((d) => ({
      import_id: created.id,
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
      .eq("id", created.id);
    return { error: toFriendlyError(itemsError, "menu items") };
  }

  await supabase
    .from("menu_imports")
    .update({ status: "review", extraction_model: result.model ?? null })
    .eq("id", created.id);

  redirect(`/dashboard/menu/import/${created.id}`);
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
