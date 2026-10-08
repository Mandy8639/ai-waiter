"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { rowsFromRules, type HoursRule } from "./core";

/**
 * Managing menus (phase L). Owners and managers, through the
 * RLS-respecting client: menus/menu_hours/menu_sections policies enforce
 * the same thing, and the default menu can't be deleted, unpublished or
 * demoted whatever is sent. database.types.ts predates 20261004090000,
 * hence the untyped handle.
 */

export interface MenuActionResult {
  error?: string;
}

type Result = Promise<{ error: { message: string; code?: string } | null }>;
interface Untyped {
  from: (table: string) => {
    insert: (
      rows: Record<string, unknown> | Record<string, unknown>[],
    ) => Result;
    update: (row: Record<string, unknown>) => {
      eq: (c: string, v: string) => { eq: (c: string, v: string) => Result };
    };
    delete: () => {
      eq: (c: string, v: string) => { eq: (c: string, v: string) => Result };
    };
  };
}

const PATHS = ["/dashboard/menu/menus", "/dashboard/menu"];
const uuid = z.uuid();

async function authorize(restaurantId: string) {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { ok: false as const, error: auth.error };
  return {
    ok: true as const,
    db: auth.context.supabase as unknown as Untyped,
  };
}

function done(): MenuActionResult {
  for (const p of PATHS) revalidatePath(p);
  return {};
}

function friendly(error: { message: string; code?: string }): string {
  if (error.code === "23505" || error.message.includes("name_unique")) {
    return "There's already a menu with that name.";
  }
  if (error.message.includes("default_is_published")) {
    return "The default menu is always published.";
  }
  return "Couldn't save. Please try again.";
}

const nameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Give the menu a name.")
      .max(40, "Keep it to 40 characters."),
  );

/** New menus start as drafts: diners don't see them until published. */
export async function createMenu(
  restaurantId: string,
  name: string,
): Promise<MenuActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { error } = await auth.db.from("menus").insert({
    restaurant_id: restaurantId,
    name: parsed.data,
    is_published: false,
  });
  return error ? { error: friendly(error) } : done();
}

export async function renameMenu(
  restaurantId: string,
  menuId: string,
  name: string,
): Promise<MenuActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!uuid.safeParse(menuId).success) return { error: "Menu not found." };
  const { error } = await auth.db
    .from("menus")
    .update({ name: parsed.data })
    .eq("id", menuId)
    .eq("restaurant_id", restaurantId);
  return error ? { error: friendly(error) } : done();
}

export async function setMenuPublished(
  restaurantId: string,
  menuId: string,
  published: boolean,
): Promise<MenuActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!uuid.safeParse(menuId).success) return { error: "Menu not found." };
  const { error } = await auth.db
    .from("menus")
    .update({ is_published: published })
    .eq("id", menuId)
    .eq("restaurant_id", restaurantId);
  return error ? { error: friendly(error) } : done();
}

/** Replaces a menu's hours. No rules means always on. */
export async function setMenuHours(
  restaurantId: string,
  menuId: string,
  rules: HoursRule[],
): Promise<MenuActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!uuid.safeParse(menuId).success) return { error: "Menu not found." };
  const checked = rowsFromRules(rules);
  if (!checked.ok) return { error: checked.error };

  const { error: clearError } = await auth.db
    .from("menu_hours")
    .delete()
    .eq("menu_id", menuId)
    .eq("restaurant_id", restaurantId);
  if (clearError) return { error: friendly(clearError) };
  if (checked.rows.length > 0) {
    const { error } = await auth.db.from("menu_hours").insert(
      checked.rows.map((r) => ({
        menu_id: menuId,
        restaurant_id: restaurantId,
        day_of_week: r.day,
        opens_at: r.opens,
        closes_at: r.closes,
      })),
    );
    if (error) return { error: friendly(error) };
  }
  return done();
}

/** Puts a section on, or takes it off, a menu. */
export async function setMenuSection(
  restaurantId: string,
  menuId: string,
  categoryId: string,
  included: boolean,
): Promise<MenuActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!uuid.safeParse(menuId).success || !uuid.safeParse(categoryId).success) {
    return { error: "Not found." };
  }
  const { error } = included
    ? await auth.db.from("menu_sections").insert({
        menu_id: menuId,
        category_id: categoryId,
        restaurant_id: restaurantId,
      })
    : await auth.db
        .from("menu_sections")
        .delete()
        .eq("menu_id", menuId)
        .eq("category_id", categoryId);
  if (error && error.code !== "23505") return { error: friendly(error) };
  return done();
}

/** Any menu but the default. Its sections stay on whatever other menus they're on. */
export async function deleteMenu(
  restaurantId: string,
  menuId: string,
): Promise<MenuActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!uuid.safeParse(menuId).success) return { error: "Menu not found." };
  const { error } = await auth.db
    .from("menus")
    .delete()
    .eq("id", menuId)
    .eq("restaurant_id", restaurantId);
  return error ? { error: friendly(error) } : done();
}
