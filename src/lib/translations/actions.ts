"use server";

import { switchedOffMessage } from "@/lib/admin/restaurant-switches-core";
import { isAiFeatureAllowed } from "@/lib/admin/restaurant-switches";

import { z } from "zod";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { draftTranslations } from "./draft";
import { getTranslationWorkbench } from "./queries";
import { MENU_LANGUAGE_COOKIE, isMenuLanguage } from "./languages";
import type { DraftField } from "./core";

/**
 * Menu translation (phase K). Owners and managers only; every write goes
 * through save_menu_translation()/approve_menu_translation(), which read
 * the original from the database themselves. Saving always makes a draft;
 * only approving publishes.
 */

export interface TranslationActionResult {
  error?: string;
  message?: string;
}

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

const PATH = "/dashboard/menu/translations";

const entitySchema = z.enum(["menu_item", "category"]);
const fieldSchema = z.enum(["name", "description"]);

async function authorize(restaurantId: string) {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { ok: false as const, error: auth.error };
  const supabase = auth.context.supabase;
  return {
    ok: true as const,
    rpc: supabase.rpc.bind(supabase) as unknown as Rpc,
    supabase,
  };
}

function friendly(message: string): string {
  if (message.includes("TRANSLATION_FORBIDDEN")) {
    return "Only an owner or manager can edit translations.";
  }
  if (message.includes("TRANSLATION_NO_SOURCE")) {
    return "That dish or category has changed. Reload the page.";
  }
  if (message.includes("text_length")) {
    return "A translation has to be between 1 and 1,000 characters.";
  }
  return "Couldn't save. Please try again.";
}

/** A person types or edits a translation. Always saved as a draft. */
export async function saveTranslation(
  restaurantId: string,
  input: {
    entity: string;
    entityId: string;
    field: string;
    language: string;
    text: string;
  },
): Promise<TranslationActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  const entity = entitySchema.safeParse(input.entity);
  const field = fieldSchema.safeParse(input.field);
  if (
    !entity.success ||
    !field.success ||
    !z.uuid().safeParse(input.entityId).success ||
    !isMenuLanguage(input.language)
  ) {
    return { error: "Couldn't save. Please reload and try again." };
  }
  const text = input.text.trim();
  if (text.length === 0 || text.length > 1000) {
    return { error: "A translation has to be between 1 and 1,000 characters." };
  }

  const { error } = await auth.rpc("save_menu_translation", {
    target_restaurant_id: restaurantId,
    p_entity: entity.data,
    p_entity_id: input.entityId,
    p_field: field.data,
    p_language: input.language,
    p_text: text,
    p_origin: "owner",
  });
  if (error) return { error: friendly(error.message) };
  revalidatePath(PATH);
  return {};
}

/** A person approves a translation as right for the current original. Only this publishes. */
export async function approveTranslation(
  restaurantId: string,
  translationId: string,
): Promise<TranslationActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!z.uuid().safeParse(translationId).success) {
    return { error: "Couldn't approve. Please reload and try again." };
  }
  const { error } = await auth.rpc("approve_menu_translation", {
    p_translation_id: translationId,
  });
  if (error) return { error: friendly(error.message) };
  revalidatePath(PATH);
  return {};
}

/** Throw a translation away; the field goes back to showing the original. */
export async function deleteTranslation(
  restaurantId: string,
  translationId: string,
): Promise<TranslationActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!z.uuid().safeParse(translationId).success) return {};
  const untyped = auth.supabase as unknown as {
    from: (table: string) => {
      delete: () => {
        eq: (
          c: string,
          v: string,
        ) => {
          eq: (
            c: string,
            v: string,
          ) => Promise<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await untyped
    .from("menu_translations")
    .delete()
    .eq("id", translationId)
    .eq("restaurant_id", restaurantId);
  if (error) return { error: friendly(error.message) };
  revalidatePath(PATH);
  return {};
}

/**
 * How many fields one press drafts, so a large menu can't outrun the
 * request: two batches at up to 45 s each (with retries) fit the page's
 * maxDuration.
 */
const DRAFT_LIMIT = 40;
const BATCH_SIZE = 20;

/**
 * Drafts every field that has no translation yet, or whose approved one
 * the original has overtaken, using the free model. Never touches a
 * current draft or approval a person already made, and never publishes.
 */
export async function draftMissingTranslations(
  restaurantId: string,
  language: string,
): Promise<TranslationActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!(await isAiFeatureAllowed(restaurantId, "owner_tools"))) {
    return { error: switchedOffMessage("owner_tools") };
  }
  if (!isMenuLanguage(language)) return { error: "Choose a language." };

  const rows = await getTranslationWorkbench(restaurantId, language);
  const todo = rows.filter((r) => r.state === "missing" || r.state === "stale");
  if (todo.length === 0) {
    return { message: "Nothing left to draft in this language." };
  }

  const batch = todo.slice(0, DRAFT_LIMIT);
  let saved = 0;
  let failedBatches = 0;
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    const chunk = batch.slice(i, i + BATCH_SIZE);
    const fields: DraftField[] = chunk.map((row, j) => ({
      key: `f${i + j}`,
      kind:
        row.entity === "category"
          ? "category name"
          : row.field === "name"
            ? "dish name"
            : "dish description",
      text: row.source,
    }));
    const result = await draftTranslations(language, fields, restaurantId);
    if (!result.ok) {
      if (result.reason === "not_free") {
        return {
          error:
            "Drafting only runs on a free AI model, and a paid one is configured. Type translations instead, or switch the AI back to a free model.",
        };
      }
      if (result.reason === "not_configured") {
        return { error: "The AI isn't set up for this restaurant." };
      }
      failedBatches += 1;
      continue;
    }
    for (const [j, row] of chunk.entries()) {
      const text = result.translations.get(`f${i + j}`);
      if (!text) continue;
      const { error } = await auth.rpc("save_menu_translation", {
        target_restaurant_id: restaurantId,
        p_entity: row.entity,
        p_entity_id: row.entityId,
        p_field: row.field,
        p_language: language,
        p_text: text,
        p_origin: "ai",
      });
      if (!error) saved += 1;
    }
  }

  revalidatePath(PATH);
  const left = todo.length - saved;
  if (saved === 0) {
    return {
      error:
        failedBatches > 0
          ? "The free AI model didn't answer. Try again in a minute."
          : "The AI didn't return usable drafts. Try again, or type them in.",
    };
  }
  return {
    message: `Drafted ${saved} ${saved === 1 ? "translation" : "translations"}. Nothing is shown to diners until you approve it.${left > 0 ? ` ${left} still to draft — press again.` : ""}`,
  };
}

/** A diner picks the menu's language, or goes back to the original. */
export async function setMenuLanguage(language: string): Promise<void> {
  const value = isMenuLanguage(language) ? language : "original";
  (await cookies()).set(MENU_LANGUAGE_COOKIE, value, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
