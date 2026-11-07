/**
 * Creates "Lantern Table", the fictional restaurant behind the public
 * /demo page (src/app/(marketing)/demo/page.tsx).
 *
 *   npx tsx --env-file=.env.local scripts/create-demo-restaurant.ts --owner you@example.com [--apply]
 *
 * Dry run by default. Nothing is written without --apply.
 *
 * Everything here is invented on purpose: the name, the dishes, the prices.
 * It must never resemble a real restaurant. The owner is a real Tableside
 * account (yours), so the demo can be edited from the dashboard like any
 * other restaurant, and its allergens are recorded as confirmed by that
 * owner — the allergy hold and the menu only trust confirmed allergens.
 *
 * Inserted directly with the secret key rather than through
 * create_restaurant(), which needs a signed-in caller; the rows written are
 * the same three that function writes (restaurant, settings, owner), plus
 * the menu. Like every new restaurant it starts in basic mode.
 *
 * Re-running is safe: it stops if the slug already exists.
 */
import { createClient } from "@supabase/supabase-js";

const SLUG = "lantern-table-demo";
const NAME = "Lantern Table";
const DESCRIPTION =
  "A demo restaurant for trying Tableside. The dishes are made up, and orders placed here are never cooked.";

type Allergen = "Tree nuts" | "Milk" | "Wheat" | "Eggs" | "Soy" | "Sesame";
type Spice = "none" | "mild" | "medium" | "hot";

interface Dish {
  name: string;
  description: string;
  price: number;
  minutes: number;
  vegetarian?: boolean;
  vegan?: boolean;
  spice?: Spice;
  allergens?: Allergen[];
}

const MENU: { name: string; description?: string; dishes: Dish[] }[] = [
  {
    name: "Small plates",
    dishes: [
      {
        name: "Crispy Cauliflower",
        description: "Fried florets, chilli honey glaze, toasted sesame.",
        price: 11,
        minutes: 10,
        vegetarian: true,
        spice: "mild",
        allergens: ["Wheat", "Sesame"],
      },
      {
        name: "Charred Corn Ribs",
        description: "Lime, smoked paprika butter, crumbled feta.",
        price: 9,
        minutes: 8,
        vegetarian: true,
        spice: "mild",
        allergens: ["Milk"],
      },
      {
        name: "Lantern Wings",
        description: "Six wings, sticky gochujang glaze, pickled cucumber.",
        price: 13,
        minutes: 14,
        spice: "hot",
        allergens: ["Soy", "Wheat", "Sesame"],
      },
      {
        name: "Garden Soup",
        description: "Roasted tomato and red pepper, basil oil.",
        price: 8,
        minutes: 5,
        vegetarian: true,
        vegan: true,
        spice: "none",
      },
    ],
  },
  {
    name: "Mains",
    dishes: [
      {
        name: "Braised Short Rib",
        description:
          "Slow-braised beef, buttery mash and garlic greens. Our heartiest plate.",
        price: 24,
        minutes: 15,
        spice: "none",
        allergens: ["Milk"],
      },
      {
        name: "Lantern Burger",
        description:
          "Smashed beef patty, cheddar, house pickles, brioche bun, fries.",
        price: 17,
        minutes: 12,
        spice: "none",
        allergens: ["Milk", "Wheat", "Eggs", "Sesame"],
      },
      {
        name: "Cashew Curry",
        description: "Paneer in a rich cashew and tomato sauce, with rice.",
        price: 18,
        minutes: 15,
        vegetarian: true,
        spice: "medium",
        allergens: ["Tree nuts", "Milk"],
      },
      {
        name: "Coconut Vegetable Curry",
        description:
          "Seasonal vegetables in coconut and lemongrass, with rice.",
        price: 16,
        minutes: 12,
        vegetarian: true,
        vegan: true,
        spice: "mild",
      },
      {
        name: "Lemon Herb Salmon",
        description: "Pan-seared salmon, herbed potatoes, charred lemon.",
        price: 23,
        minutes: 16,
        spice: "none",
        allergens: ["Milk"],
      },
      {
        name: "Wild Mushroom Pasta",
        description: "Fresh tagliatelle, mixed mushrooms, parmesan, thyme.",
        price: 19,
        minutes: 13,
        vegetarian: true,
        spice: "none",
        allergens: ["Wheat", "Eggs", "Milk"],
      },
    ],
  },
  {
    name: "Sides",
    dishes: [
      {
        name: "Garlic Naan",
        description: "Brushed with garlic butter.",
        price: 4,
        minutes: 6,
        vegetarian: true,
        spice: "none",
        allergens: ["Wheat", "Milk"],
      },
      {
        name: "Fries",
        description: "Sea salt, with house ketchup.",
        price: 5,
        minutes: 7,
        vegetarian: true,
        vegan: true,
        spice: "none",
      },
    ],
  },
  {
    name: "Desserts",
    dishes: [
      {
        name: "Sticky Toffee Pudding",
        description: "Warm date sponge, toffee sauce, vanilla ice cream.",
        price: 9,
        minutes: 6,
        vegetarian: true,
        spice: "none",
        allergens: ["Wheat", "Milk", "Eggs"],
      },
      {
        name: "Mango Sorbet",
        description: "Two scoops, fresh mint.",
        price: 7,
        minutes: 2,
        vegetarian: true,
        vegan: true,
        spice: "none",
      },
    ],
  },
  {
    name: "Drinks",
    dishes: [
      {
        name: "Ginger Lemonade",
        description: "Fresh ginger, lemon, sparkling water.",
        price: 5,
        minutes: 2,
        vegetarian: true,
        vegan: true,
        spice: "none",
      },
      {
        name: "Mango Lassi",
        description: "Yoghurt, mango, a pinch of cardamom.",
        price: 6,
        minutes: 3,
        vegetarian: true,
        spice: "none",
        allergens: ["Milk"],
      },
    ],
  },
];

const TABLES = ["1", "2", "3", "4", "5", "6", "7", "8"];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const ownerEmail = argValue("--owner")?.toLowerCase();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.error("Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.");
    process.exitCode = 1;
    return;
  }
  if (!ownerEmail) {
    console.error("Pass --owner <email of the Tableside account to own it>.");
    process.exitCode = 1;
    return;
  }
  const db = createClient(url, key);

  console.log(`Supabase project: ${new URL(url).hostname.split(".")[0]}`);
  console.log(
    apply ? "MODE: APPLY\n" : "MODE: dry run (pass --apply to write)\n",
  );

  const { data: existing } = await db
    .from("restaurants")
    .select("id")
    .eq("slug", SLUG)
    .maybeSingle();
  if (existing) {
    console.log(`"${SLUG}" already exists (${existing.id}). Nothing to do.`);
    return;
  }

  // Find the owner. listUsers pages; the account count is small.
  let ownerId: string | undefined;
  for (let page = 1; !ownerId && page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw error;
    ownerId = data.users.find((u) => u.email?.toLowerCase() === ownerEmail)?.id;
    if (data.users.length < 200) break;
  }
  if (!ownerId) {
    console.error(`No Tableside account with the email ${ownerEmail}.`);
    process.exitCode = 1;
    return;
  }

  const dishCount = MENU.reduce((n, c) => n + c.dishes.length, 0);
  console.log(`${NAME} (/r/${SLUG}), owner ${ownerEmail}`);
  console.log(
    `${MENU.length} categories, ${dishCount} dishes, ${TABLES.length} tables`,
  );
  for (const c of MENU) {
    console.log(`  ${c.name}`);
    for (const d of c.dishes) {
      const tags = [
        d.vegan ? "vegan" : d.vegetarian ? "veg" : null,
        d.spice && d.spice !== "none" ? d.spice : null,
        ...(d.allergens ?? []),
      ].filter(Boolean);
      console.log(`    $${d.price}  ${d.name}  [${tags.join(", ")}]`);
    }
  }
  if (!apply) return;

  const { data: restaurant, error: rErr } = await db
    .from("restaurants")
    .insert({ name: NAME, slug: SLUG, description: DESCRIPTION })
    .select("id")
    .single();
  if (rErr || !restaurant) throw rErr ?? new Error("restaurant insert");
  const rid = restaurant.id;

  const must = (error: { message: string } | null, what: string) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };

  must(
    (await db.from("restaurant_settings").insert({ restaurant_id: rid })).error,
    "settings",
  );
  must(
    (
      await db
        .from("restaurant_users")
        .insert({ restaurant_id: rid, user_id: ownerId, role: "owner" })
    ).error,
    "owner",
  );

  const allergenNames = [
    ...new Set(MENU.flatMap((c) => c.dishes.flatMap((d) => d.allergens ?? []))),
  ];
  const { data: allergenRows, error: aErr } = await db
    .from("allergens")
    .insert(allergenNames.map((name) => ({ restaurant_id: rid, name })))
    .select("id, name");
  must(aErr, "allergens");
  const allergenId = new Map(allergenRows!.map((a) => [a.name, a.id]));

  const now = new Date().toISOString();
  for (const [ci, category] of MENU.entries()) {
    const { data: cat, error: cErr } = await db
      .from("categories")
      .insert({
        restaurant_id: rid,
        name: category.name,
        description: category.description ?? null,
        display_order: ci + 1,
      })
      .select("id")
      .single();
    must(cErr, `category ${category.name}`);

    for (const [di, d] of category.dishes.entries()) {
      const allergens = d.allergens ?? [];
      const { data: item, error: iErr } = await db
        .from("menu_items")
        .insert({
          restaurant_id: rid,
          category_id: cat!.id,
          name: d.name,
          slug: slugify(d.name),
          description: d.description,
          price: d.price,
          preparation_time: d.minutes,
          is_vegetarian: Boolean(d.vegetarian),
          is_vegan: Boolean(d.vegan),
          is_spicy: d.spice === "medium" || d.spice === "hot",
          spice_level: d.spice ?? null,
          spice_level_source: "restaurant",
          details_source: "restaurant",
          contains_nuts: allergens.includes("Tree nuts"),
          contains_dairy: allergens.includes("Milk"),
          contains_gluten: allergens.includes("Wheat"),
          display_order: di + 1,
        })
        .select("id")
        .single();
      must(iErr, `dish ${d.name}`);

      if (allergens.length > 0) {
        must(
          (
            await db.from("menu_item_allergens").insert(
              allergens.map((a) => ({
                restaurant_id: rid,
                menu_item_id: item!.id,
                allergen_id: allergenId.get(a)!,
                confirmed_at: now,
                confirmed_by: ownerId,
              })),
            )
          ).error,
          `allergens for ${d.name}`,
        );
      }
    }
  }

  must(
    (
      await db.from("tables").insert(
        TABLES.map((n) => ({
          restaurant_id: rid,
          table_number: n,
          display_name: `Table ${n}`,
        })),
      )
    ).error,
    "tables",
  );

  console.log(`\nCreated ${NAME}: /r/${SLUG}`);
  console.log(
    "Next: add dish photos from Menu → Photos in the dashboard, then check /demo.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
