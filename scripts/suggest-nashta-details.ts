/**
 * One-off: fills ingredients and suggests allergens for an existing menu.
 *
 *   npx tsx --env-file=.env.local scripts/suggest-nashta-details.ts <slug> [--apply]
 *
 * Dry run by default.
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
import { createClient } from "@supabase/supabase-js";
import {
  parseSuggestions,
  SUGGESTION_PROMPT,
} from "../src/lib/menu-import/suggestions";

/**
 * 12, not 25. This model reasons before answering and most of its budget
 * goes to thinking that never reaches `content`: a 25-item batch measured
 * 6357 of 8000 completion tokens, so a batch that reasoned slightly more
 * truncated and failed to parse — two of seven batches did. Smaller
 * batches cut the reasoning load rather than raising a ceiling that would
 * be hit again later.
 */
const BATCH = 12;
const MODEL =
  process.env.MENU_IMPORT_VISION_MODEL ||
  "dots-studio/dots-3-note-preview:free";

async function ask(names: string[]) {
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
          content: `${SUGGESTION_PROMPT}\n\nDishes:\n${names.map((n) => `- ${n}`).join("\n")}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json();
  return parseSuggestions(json?.choices?.[0]?.message?.content ?? "");
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  const apply = process.argv.includes("--apply");
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

  const { data: items } = await db
    .from("menu_items")
    .select("id, name")
    .eq("restaurant_id", restaurant.id)
    .order("name");

  const all = items ?? [];
  console.log(`${restaurant.name}: ${all.length} items, ${MODEL}`);
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run\n");

  let ingredientLinks = 0;
  let allergenSuggestions = 0;
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
        continue;
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
    console.log(`${batchIng} ingredients, ${batchAlg} allergen suggestions`);
  }

  console.log(
    `\n${ingredientLinks} ingredient links, ${allergenSuggestions} allergen suggestions` +
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
