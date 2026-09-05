/**
 * One-off: fills ingredients and suggests allergens for an existing menu.
 *
 *   npx tsx --env-file=.env.local scripts/suggest-nashta-details.ts <slug> [--apply]
 *   npx tsx --env-file=.env.local scripts/suggest-nashta-details.ts <slug> --portions-only [--apply]
 *
 * Dry run by default. --portions-only fills just the portion notes on a
 * menu whose other details are already written, without putting a single
 * new allergen suggestion in front of a human who has already reviewed
 * that dish.
 *
 * Mirrors src/lib/menu-import/suggest-actions.ts, which is the in-app path,
 * but runs with the service key so a whole menu can be processed in one go
 * rather than 25 at a time through a form.
 *
 * Ingredients are written directly. Allergens are written with confirmed_at
 * NULL — invisible to diners until a human confirms them per dish. That is
 * the point, not an implementation detail: a dish name cannot tell you
 * whether THIS kitchen uses cashew paste.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  parseSuggestions,
  PORTION_PROMPT,
  SPICE_PROMPT,
  SUGGESTION_PROMPT,
} from "../src/lib/menu-import/suggestions";

/**
 * Sized by measurement, twice.
 *
 * This model reasons before answering and most of its budget goes to
 * thinking that never reaches `content`: a 25-item batch measured 6357 of
 * 8000 completion tokens, and two of seven batches truncated. At 12, all
 * thirteen passed.
 *
 * Adding descriptions then roughly doubled the output per item and one
 * batch of 12 truncated again — the same failure, from the other side of
 * the budget. 8 restores the headroom.
 *
 * Re-running is safe: the script only fills fields that are still empty,
 * so a failed batch is picked up by simply running it again.
 */
const BATCH = 8;

/**
 * --portions-only asks a much narrower question, so it can afford much
 * bigger batches: one short sentence per dish instead of a description,
 * a prep time, an ingredient list and an allergen list.
 */
const PORTION_BATCH = 20;
const MODEL =
  process.env.MENU_IMPORT_VISION_MODEL ||
  "dots-studio/dots-3-note-preview:free";

async function ask(names: string[], prompt = SUGGESTION_PROMPT) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [
        {
          role: "user",
          content: `${prompt}\n\nDishes:\n${names.map((n) => `- ${n}`).join("\n")}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json();
  return parseSuggestions(json?.choices?.[0]?.message?.content ?? "");
}

/**
 * Fills portion notes only, on items that have none.
 *
 * Separate from the main pass because the menu it is aimed at already has
 * ingredients, allergens and descriptions. Re-asking the full prompt would
 * write almost nothing (only empty fields are filled) while generating a
 * fresh crop of unconfirmed allergen rows, each of which lands back in the
 * review queue of someone who has already been through that dish.
 */
async function fillPortionNotes(
  db: SupabaseClient,
  restaurantId: string,
  apply: boolean,
): Promise<void> {
  const { data: items } = await db
    .from("menu_items")
    .select("id, name")
    .eq("restaurant_id", restaurantId)
    .is("portion_note", null)
    .order("name");

  const all = items ?? [];
  console.log(`${all.length} items without a portion note\n`);

  let written = 0;
  let skipped = 0;
  let failedBatches = 0;

  for (let i = 0; i < all.length; i += PORTION_BATCH) {
    const batch = all.slice(i, i + PORTION_BATCH);
    process.stdout.write(
      `batch ${i / PORTION_BATCH + 1} (${batch.length} items)… `,
    );

    let result = await ask(
      batch.map((b) => b.name),
      PORTION_PROMPT,
    );
    if (!result.ok) {
      process.stdout.write("retrying… ");
      result = await ask(
        batch.map((b) => b.name),
        PORTION_PROMPT,
      );
    }
    if (!result.ok) {
      console.log(`FAILED: ${result.error}`);
      failedBatches += 1;
      continue;
    }

    const byName = new Map(batch.map((b) => [b.name.toLowerCase(), b.id]));
    let batchWritten = 0;

    for (const s of result.suggestions) {
      const menuItemId = byName.get(s.name.toLowerCase());
      if (!menuItemId) continue;
      // null is a real answer here, not a failure: most dishes feed one
      // person and saying so on every line is noise, not service.
      if (!s.portionNote) {
        skipped += 1;
        continue;
      }
      if (!apply) {
        batchWritten += 1;
        console.log(`\n  ${s.name}: ${s.portionNote}`);
        continue;
      }
      const { error } = await db
        .from("menu_items")
        .update({ portion_note: s.portionNote, details_source: "ai_draft" })
        .eq("id", menuItemId);
      if (!error) batchWritten += 1;
    }

    written += batchWritten;
    console.log(`${batchWritten} portion notes`);
  }

  console.log(
    `\n${written} portion notes, ${skipped} dishes left blank as single-serving` +
      (failedBatches ? `, ${failedBatches} batch(es) failed after retry` : ""),
  );
}

/**
 * Fills spice levels only, on items that have none.
 *
 * Same reasoning as fillPortionNotes: re-running the full prompt over a
 * menu that already has ingredients, allergens and descriptions writes
 * almost nothing while generating a fresh crop of unconfirmed allergen
 * rows for a human who has already reviewed those dishes.
 */
async function fillSpiceLevels(
  db: SupabaseClient,
  restaurantId: string,
  apply: boolean,
): Promise<void> {
  const { data: items } = await db
    .from("menu_items")
    .select("id, name")
    .eq("restaurant_id", restaurantId)
    .is("spice_level", null)
    .order("name");

  const all = items ?? [];
  console.log(`${all.length} items without a spice level\n`);

  let written = 0;
  let failedBatches = 0;
  const tally = new Map<string, number>();

  for (let i = 0; i < all.length; i += PORTION_BATCH) {
    const batch = all.slice(i, i + PORTION_BATCH);
    process.stdout.write(
      `batch ${i / PORTION_BATCH + 1} (${batch.length} items)… `,
    );

    let result = await ask(
      batch.map((b) => b.name),
      SPICE_PROMPT,
    );
    if (!result.ok) {
      process.stdout.write("retrying… ");
      result = await ask(
        batch.map((b) => b.name),
        SPICE_PROMPT,
      );
    }
    if (!result.ok) {
      console.log(`FAILED: ${result.error}`);
      failedBatches += 1;
      continue;
    }

    const byName = new Map(batch.map((b) => [b.name.toLowerCase(), b.id]));
    let batchWritten = 0;

    for (const s of result.suggestions) {
      const menuItemId = byName.get(s.name.toLowerCase());
      if (!menuItemId || !s.spiceLevel) continue;
      tally.set(s.spiceLevel, (tally.get(s.spiceLevel) ?? 0) + 1);
      if (!apply) {
        batchWritten += 1;
        continue;
      }
      const { error } = await db
        .from("menu_items")
        .update({
          spice_level: s.spiceLevel,
          is_spicy: s.spiceLevel !== "none",
          spice_level_source: "ai_draft",
        })
        .eq("id", menuItemId);
      if (!error) batchWritten += 1;
    }

    written += batchWritten;
    console.log(`${batchWritten} spice levels`);
  }

  console.log(
    `\n${written} spice levels` +
      (failedBatches ? `, ${failedBatches} batch(es) failed after retry` : ""),
  );
  console.log(
    [...tally.entries()].map(([k, v]) => `  ${k}: ${v}`).join("\n") || "",
  );
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  const apply = process.argv.includes("--apply");
  const portionsOnly = process.argv.includes("--portions-only");
  const spiceOnly = process.argv.includes("--spice-only");
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
  );

  const { data: restaurant } = await db
    .from("restaurants")
    .select("id, name")
    .eq("slug", slug)
    .single();
  if (!restaurant) {
    console.error(`No restaurant with slug "${slug}".`);
    process.exitCode = 1;
    return;
  }

  console.log(`${restaurant.name}, ${MODEL}`);
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run\n");

  if (portionsOnly) {
    await fillPortionNotes(db, restaurant.id, apply);
    return;
  }

  if (spiceOnly) {
    await fillSpiceLevels(db, restaurant.id, apply);
    return;
  }

  const { data: items } = await db
    .from("menu_items")
    .select("id, name")
    .eq("restaurant_id", restaurant.id)
    .order("name");

  const all = items ?? [];
  console.log(`${all.length} items\n`);

  let ingredientLinks = 0;
  let allergenSuggestions = 0;
  let descriptions = 0;
  let unmatched = 0;
  let failedBatches = 0;

  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    process.stdout.write(`batch ${i / BATCH + 1} (${batch.length} items)… `);

    // One retry: the residual failures are transient (a truncated or empty
    // completion), not a bad prompt, so asking again usually succeeds.
    let result = await ask(batch.map((b) => b.name));
    if (!result.ok) {
      process.stdout.write("retrying… ");
      result = await ask(batch.map((b) => b.name));
    }
    if (!result.ok) {
      console.log(`FAILED: ${result.error}`);
      failedBatches += 1;
      continue;
    }

    const byName = new Map(batch.map((b) => [b.name.toLowerCase(), b.id]));
    let batchIng = 0;
    let batchAlg = 0;
    let batchDesc = 0;

    for (const s of result.suggestions) {
      const menuItemId = byName.get(s.name.toLowerCase());
      if (!menuItemId) {
        // A dish the model renamed or invented. Skipped rather than matched
        // loosely — attaching an allergen to the wrong dish is the exact
        // failure this feature exists to avoid.
        unmatched += 1;
        continue;
      }
      if (!apply) {
        batchIng += s.ingredients.length;
        batchAlg += s.allergens.length;
        if (s.description) batchDesc += 1;
        continue;
      }

      // Description and prep time go straight onto the item — they are not
      // staged like allergens, because prose that is wrong is a menu that
      // reads oddly, not a diner in hospital. details_source marks them as
      // unreviewed so the dashboard can flag them without hiding them.
      //
      // Only written when the model actually produced something, and only
      // over an EMPTY field: a description someone has already written by
      // hand must never be overwritten by a guess from a dish name.
      if (s.description || s.prepTimeMinutes !== null || s.spiceLevel) {
        const { data: existing } = await db
          .from("menu_items")
          .select("description, preparation_time, spice_level")
          .eq("id", menuItemId)
          .single();

        const patch: Record<string, unknown> = {};
        if (s.spiceLevel && !existing?.spice_level) {
          patch.spice_level = s.spiceLevel;
          // Kept in step with the level: is_spicy is what the AI's
          // spicyOnly filter reads.
          patch.is_spicy = s.spiceLevel !== "none";
          patch.spice_level_source = "ai_draft";
        }
        if (s.description && !existing?.description) {
          patch.description = s.description;
        }
        if (s.prepTimeMinutes !== null && !existing?.preparation_time) {
          patch.preparation_time = s.prepTimeMinutes;
        }
        if (Object.keys(patch).length > 0) {
          patch.details_source = "ai_draft";
          const { error } = await db
            .from("menu_items")
            .update(patch)
            .eq("id", menuItemId);
          if (!error && patch.description) batchDesc += 1;
        }
      }

      for (const name of s.ingredients) {
        const { data: ing } = await db
          .from("ingredients")
          .upsert(
            { restaurant_id: restaurant.id, name },
            { onConflict: "restaurant_id,name" },
          )
          .select("id")
          .single();
        if (!ing) continue;
        const { error } = await db.from("menu_item_ingredients").insert({
          restaurant_id: restaurant.id,
          menu_item_id: menuItemId,
          ingredient_id: ing.id,
        });
        if (!error) batchIng += 1;
      }

      for (const name of s.allergens) {
        const { data: alg } = await db
          .from("allergens")
          .upsert(
            { restaurant_id: restaurant.id, name },
            { onConflict: "restaurant_id,name" },
          )
          .select("id")
          .single();
        if (!alg) continue;
        // confirmed_at omitted on purpose: NULL is what keeps this a
        // suggestion rather than a claim, and away from diners.
        const { error } = await db.from("menu_item_allergens").insert({
          restaurant_id: restaurant.id,
          menu_item_id: menuItemId,
          allergen_id: alg.id,
        });
        if (!error) batchAlg += 1;
      }
    }

    ingredientLinks += batchIng;
    allergenSuggestions += batchAlg;
    descriptions += batchDesc;
    console.log(
      `${batchIng} ingredients, ${batchAlg} allergens, ${batchDesc} descriptions`,
    );
  }

  console.log(
    `\n${ingredientLinks} ingredient links, ${allergenSuggestions} allergen suggestions, ${descriptions} descriptions` +
      (unmatched ? `, ${unmatched} unmatched dish names skipped` : "") +
      (failedBatches ? `, ${failedBatches} batch(es) failed after retry` : ""),
  );
  if (apply) {
    console.log(
      "\nAllergens are UNCONFIRMED and invisible to diners until someone\n" +
        "confirms them dish by dish at /dashboard/menu/allergen-review.",
    );
  }
}

main();
