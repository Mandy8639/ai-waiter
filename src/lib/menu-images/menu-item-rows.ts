/**
 * Row shapes for `menu_items` columns the generated Supabase types do not
 * know about yet.
 *
 * Originally the image columns from phase 1; phase B added the dietary
 * claim columns (`is_halal`, `is_kosher`) to the same
 * problem and so to the same place.
 *
 * `src/lib/supabase/database.types.ts` predates both migrations, so the
 * generated client rejects those columns by name and infers
 * `SelectQueryError` for any select mentioning them.
 *
 * Regenerating is not possible in this environment: `supabase gen types`
 * shells out to Docker even when given `--db-url`, Docker is not installed
 * here, and the only other source of truth is production, which is off
 * limits. Serving the migration-built schema over a socket was tried and
 * fails at the same Docker call.
 *
 * So these interfaces state the columns exactly as the migration declares
 * them, and each query casts its rows once, here-documented, instead of
 * scattering `any` through the pages. Everything downstream — the
 * resolver, the components — is then fully typed.
 *
 * DELETE THIS FILE when database.types.ts is regenerated; the generated
 * types will say the same thing, and better.
 */
import type { ImageSource } from "./resolve";

/** The three columns publish_menu_item_image() maintains, plus the legacy URL. */
export interface MenuItemImageFields {
  image_url: string | null;
  active_image_id: string | null;
  image_source: ImageSource | null;
  image_variants: Record<string, string> | null;
}

/**
 * The two columns phase B added. Kept as their own interface so the
 * dietary claims travel together and a select that forgets one fails to
 * type-check rather than silently reading `undefined` as "not stated".
 */
export interface MenuItemDietaryClaimFields {
  is_halal: boolean;
  is_kosher: boolean;
}

/** Selected by the owner's edit form. */
export interface MenuItemEditRow extends MenuItemDietaryClaimFields {
  id: string;
  name: string;
  slug: string;
  category_id: string;
  description: string | null;
  price: number | string;
  image_url: string | null;
  is_available: boolean;
  is_vegetarian: boolean;
  is_vegan: boolean;
  is_spicy: boolean;
  spice_level: string | null;
  contains_nuts: boolean;
  contains_dairy: boolean;
  contains_gluten: boolean;
  preparation_time: number | null;
  portion_note: string | null;
  display_order: number;
}

/** Selected by the menu page purely to decide which filter chips to offer. */
export interface DietFlagRow extends MenuItemDietaryClaimFields {
  is_vegetarian: boolean;
  is_vegan: boolean;
  is_spicy: boolean;
}

/** Selected by the diner menu list. */
export interface MenuListRow
  extends MenuItemImageFields, MenuItemDietaryClaimFields {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  is_vegetarian: boolean;
  is_vegan: boolean;
  is_spicy: boolean;
  category_id: string;
}

/** The column list to add to a select that needs an image. */
export const MENU_ITEM_IMAGE_COLUMNS =
  "image_url, active_image_id, image_source, image_variants";

/** The column list to add to a select that needs the dietary claims. */
export const MENU_ITEM_DIETARY_CLAIM_COLUMNS = "is_halal, is_kosher";

/**
 * Narrows rows the generated types cannot describe yet.
 *
 * Deliberately a named function rather than an inline cast: it is greppable
 * when the types are regenerated, and it documents at every call site that
 * the shape is asserted against the migration rather than inferred.
 */
export function asRowsWithNewColumns<T>(rows: unknown): T[] {
  return (rows ?? []) as T[];
}

/** Selected by the dish detail page. */
export interface MenuItemDetailRow
  extends MenuItemImageFields, MenuItemDietaryClaimFields {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  is_vegetarian: boolean;
  is_vegan: boolean;
  is_spicy: boolean;
  spice_level: string | null;
  contains_nuts: boolean;
  contains_dairy: boolean;
  contains_gluten: boolean;
  preparation_time: number | null;
  portion_note: string | null;
}
