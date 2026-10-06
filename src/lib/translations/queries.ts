import "server-only";
import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  sourceText,
  translationState,
  type TranslatableEntity,
  type TranslatableField,
  type TranslationState,
} from "./core";
import {
  MENU_LANGUAGE_COOKIE,
  chooseMenuLanguage,
  isMenuLanguage,
  type MenuLanguage,
} from "./languages";

// database.types.ts predates 20261003090000, so the new table and
// functions are reached through untyped handles.
type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function rpc(): Promise<Rpc> {
  const supabase = await createClient();
  return supabase.rpc.bind(supabase) as unknown as Rpc;
}

// For the diner ---------------------------------------------------------------

export interface DinerTranslations {
  language: MenuLanguage | null;
  available: MenuLanguage[];
  dishName: (id: string) => string | null;
  dishDescription: (id: string) => string | null;
  categoryName: (id: string) => string | null;
}

/**
 * The menu's translations for this diner: the language they chose (or
 * their browser's, if the menu has it), approved and current translations
 * only. Everything returns null where there is no translation, and the
 * page shows the original.
 */
export async function getDinerTranslations(
  restaurantId: string,
): Promise<DinerTranslations> {
  const call = await rpc();
  const { data: langRows } = await call("get_menu_languages", {
    target_restaurant_id: restaurantId,
  });
  const available = ((langRows ?? []) as Array<{ menu_language: string }>)
    .map((r) => r.menu_language)
    .filter(isMenuLanguage);

  const language = chooseMenuLanguage({
    cookie: (await cookies()).get(MENU_LANGUAGE_COOKIE)?.value,
    acceptLanguage: (await headers()).get("accept-language"),
    available,
  });

  const map = new Map<string, string>();
  if (language) {
    const { data } = await call("get_menu_translations", {
      target_restaurant_id: restaurantId,
      p_language: language,
    });
    for (const row of (data ?? []) as Array<{
      translated_entity: string;
      translated_entity_id: string;
      translated_field: string;
      translated_text: string;
    }>) {
      map.set(
        `${row.translated_entity}:${row.translated_entity_id}:${row.translated_field}`,
        row.translated_text,
      );
    }
  }

  return {
    language,
    available,
    dishName: (id) => map.get(`menu_item:${id}:name`) ?? null,
    dishDescription: (id) => map.get(`menu_item:${id}:description`) ?? null,
    categoryName: (id) => map.get(`category:${id}:name`) ?? null,
  };
}

// For the owner ---------------------------------------------------------------

export interface WorkbenchRow {
  entity: TranslatableEntity;
  entityId: string;
  field: TranslatableField;
  /** "Category", "Dish name" or "Masala Dosa · description". */
  context: string;
  source: string;
  translationId: string | null;
  text: string | null;
  origin: "ai" | "owner" | null;
  state: TranslationState;
}

interface CategoryRow {
  id: string;
  name: string;
  display_order: number | null;
}
interface DishRow {
  id: string;
  name: string;
  description: string | null;
  category_id: string;
  display_order: number | null;
}
interface TranslationRow {
  id: string;
  entity: TranslatableEntity;
  entity_id: string;
  field: TranslatableField;
  text: string;
  source_hash: string;
  status: "draft" | "approved";
  origin: "ai" | "owner";
}

/** Every translatable field of the menu, in menu order, with its translation (if any) in one language. */
export async function getTranslationWorkbench(
  restaurantId: string,
  language: MenuLanguage,
): Promise<WorkbenchRow[]> {
  const supabase = await createClient();
  const untyped = supabase as unknown as {
    from: (table: string) => ReturnType<typeof supabase.from>;
  };
  const [categories, items, translations] = await Promise.all([
    supabase
      .from("categories")
      .select("id, name, display_order")
      .eq("restaurant_id", restaurantId),
    supabase
      .from("menu_items")
      .select("id, name, description, category_id, display_order")
      .eq("restaurant_id", restaurantId),
    untyped
      .from("menu_translations")
      .select("id, entity, entity_id, field, text, source_hash, status, origin")
      .eq("restaurant_id", restaurantId)
      .eq("language", language),
  ]);

  const byKey = new Map(
    ((translations.data ?? []) as unknown as TranslationRow[]).map((t) => [
      `${t.entity}:${t.entity_id}:${t.field}`,
      t,
    ]),
  );

  const rows: WorkbenchRow[] = [];
  function add(
    entity: TranslatableEntity,
    entityId: string,
    field: TranslatableField,
    raw: string | null,
    context: string,
  ) {
    const source = sourceText(field, raw);
    if (source === null) return;
    const t = byKey.get(`${entity}:${entityId}:${field}`) ?? null;
    rows.push({
      entity,
      entityId,
      field,
      context,
      source,
      translationId: t?.id ?? null,
      text: t?.text ?? null,
      origin: t?.origin ?? null,
      state: translationState(
        t ? { status: t.status, sourceHash: t.source_hash } : null,
        source,
      ),
    });
  }

  const byOrder = (a: { display_order: number | null }, b: typeof a) =>
    (a.display_order ?? 0) - (b.display_order ?? 0);
  const cats = ((categories.data ?? []) as CategoryRow[]).sort(byOrder);
  const dishes = ((items.data ?? []) as DishRow[]).sort(byOrder);

  const addDish = (d: DishRow) => {
    add("menu_item", d.id, "name", d.name, "Dish name");
    add(
      "menu_item",
      d.id,
      "description",
      d.description,
      `${d.name} · description`,
    );
  };

  for (const c of cats) {
    add("category", c.id, "name", c.name, "Category");
    dishes.filter((d) => d.category_id === c.id).forEach(addDish);
  }
  const known = new Set(cats.map((c) => c.id));
  dishes.filter((d) => !known.has(d.category_id)).forEach(addDish);
  return rows;
}
