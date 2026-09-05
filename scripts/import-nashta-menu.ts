/**
 * One-off import of Nashta's real menu, transcribed from the in-store
 * boards.
 *
 *   npx tsx --env-file=.env.local scripts/import-nashta-menu.ts [--apply]
 *
 * Dry run by default. Nothing is written without --apply.
 *
 * Deliberate omissions, rather than guesses:
 *
 *  - Items priced "Ask at counter" are NOT imported. `menu_items.price` is
 *    NOT NULL, and the customer menu page neither filters nor selects
 *    `is_available`, so an unpriced row would render to diners as $0.00 on
 *    an item they could tap. The source notes for those items say
 *    explicitly not to price them from delivery-app markups, so inventing
 *    a number would be worse than leaving them out. They're listed at the
 *    end of the run for someone to add with real prices.
 *
 *  - Allergen and dietary flags beyond `is_vegetarian` are left unset.
 *    Guessing "contains dairy" or "contains nuts" from an item name is not
 *    safe: unset makes the AI say the menu doesn't specify, which is true,
 *    where a wrong guess could hurt someone.
 */
import { createClient } from "@supabase/supabase-js";

const RESTAURANT_SLUG = "my-restaurant";

interface Item {
  name: string;
  price: number;
}
interface Category {
  name: string;
  description?: string;
  items: Item[];
}

/**
 * The first block on the boards had no visible header in the source. Named
 * "Snacks" as the closest honest reading of its contents (pakora, samosa,
 * poha, chilla, puri, kachori) — rename in the dashboard if the boards say
 * something else.
 */
const MENU: Category[] = [
  {
    name: "Snacks",
    items: [
      { name: "Bread Pakora", price: 3.49 },
      { name: "Samosa (2 pcs)", price: 4.99 },
      { name: "Mirchi Bhajji", price: 7.99 },
      { name: "Sev Khaman", price: 12.99 },
      { name: "Sev Khamniy", price: 12.99 },
      { name: "White Khaman", price: 12.99 },
      { name: "Jalebi", price: 9.99 },
      { name: "Moong Chilla", price: 9.99 },
      { name: "Besan Mix Veg Chilla", price: 9.99 },
      { name: "Aloo Poha", price: 9.99 },
      { name: "Onion Poha", price: 9.99 },
      { name: "Mix Poha", price: 9.99 },
      { name: "Puri Aloo", price: 10.99 },
      { name: "Puri Chole", price: 10.99 },
      { name: "Chole Kulche", price: 10.99 },
      { name: "Chole Bhature (2 pcs)", price: 11.99 },
      { name: "Khasta Kachori Chat", price: 9.99 },
      { name: "Lilva Kachori", price: 12.99 },
      { name: "Aloo Gravy with Kachori", price: 10.99 },
      { name: "Methi Gota", price: 12.99 },
      { name: "Mix Pakora", price: 12.99 },
      { name: "Fafda", price: 14.99 },
    ],
  },
  {
    name: "Chaat",
    items: [
      { name: "Regular Vada Pav", price: 3.49 },
      { name: "Samosa Pav", price: 3.49 },
      { name: "Vada Pav (Cheese/Schezwan)", price: 3.99 },
      { name: "Vada Pav (Grilled)", price: 3.99 },
      { name: "Regular Dabeli", price: 3.99 },
      { name: "Bahubali Vada Pav", price: 4.99 },
      { name: "Dabeli (Cheese/Schezwan)", price: 4.99 },
      { name: "Dabeli (Grilled)", price: 4.99 },
      { name: "Pani Puri (7 pcs)", price: 6.99 },
      { name: "Bahubali Dabeli", price: 5.99 },
      { name: "Dahi Poori (9 pcs)", price: 7.99 },
      { name: "Dahi Vada", price: 7.99 },
      { name: "Sev Poori (9 pcs)", price: 7.99 },
      { name: "Masala Poori (9 pcs)", price: 7.99 },
      { name: "Aloo Tikki Chaat", price: 7.99 },
      { name: "Kurkure Tikki Chaat", price: 7.99 },
      { name: "Ragda Chaat", price: 7.99 },
      { name: "Chole Chaat", price: 7.99 },
      { name: "Kala Chana Chaat", price: 9.99 },
      { name: "Samosa Chaat", price: 8.99 },
      { name: "Papri Chaat", price: 8.99 },
      { name: "Bhel Puri", price: 7.99 },
      { name: "Dahi Kachori", price: 9.99 },
      { name: "Pav Bhaji", price: 10.99 },
      { name: "Extra Pav", price: 1.99 },
    ],
  },
  {
    name: "Paratha",
    description: "Served hot",
    items: [
      { name: "Aloo Paratha", price: 9.99 },
      { name: "Aloo Onion Paratha", price: 9.99 },
      { name: "Mix Veg Paratha", price: 9.99 },
      { name: "Mooli Paratha", price: 9.99 },
      { name: "Gobi Paratha", price: 9.99 },
      { name: "Paneer Paratha", price: 9.99 },
      // The source flags these four as hard to read on the board.
      { name: "Plain Paratha", price: 2.99 },
      { name: "Bajre ki Roti", price: 1.99 },
      { name: "Fresh Hot Roti", price: 0.99 },
      { name: "Methi Thepla", price: 1.99 },
    ],
  },
  {
    name: "Fasting Food",
    description: "Vrat ka Khana",
    items: [
      { name: "Sabudana Vada (4 pcs)", price: 9.99 },
      { name: "Sabudana Khichdi", price: 9.99 },
      { name: "Aloo ki Sukhi Bhaji", price: 9.99 },
      { name: "Sabudana Dry Fruit Khir", price: 9.99 },
    ],
  },
  {
    name: "Thali Special",
    items: [
      { name: "Halwa Puri Thali", price: 14.99 },
      { name: "Srikhand Puri Thali", price: 14.99 },
      { name: "Raspuri Thali", price: 14.99 },
      { name: "Gujrati Thali", price: 14.99 },
      { name: "Punjabi Thali", price: 14.99 },
      { name: "South Indian Thali", price: 14.99 },
    ],
  },
  {
    name: "Sandwiches & Rolls",
    items: [
      { name: "Vada Pav Sandwich Grill", price: 3.99 },
      { name: "Dabeli Sandwich Grill", price: 4.99 },
      { name: "Bread Jam Grill", price: 6.99 },
      { name: "Bread Jam Regular", price: 4.99 },
      { name: "Bahubali Aloo Tikki Sandwich", price: 9.99 },
      { name: "Aloo Cheese Sandwich", price: 9.99 },
      { name: "Mix Veg Sandwich", price: 9.99 },
      { name: "Vegetable Club Sandwich", price: 9.99 },
      { name: "Samosa Sandwich", price: 9.99 },
      { name: "Bombay Sandwich", price: 9.99 },
      { name: "Spicy Potato Sandwich", price: 9.99 },
      { name: "Chutney Sandwich", price: 9.99 },
      { name: "Mix Veg Roll (Spicy)", price: 9.99 },
      { name: "Kathi Roll", price: 10.99 },
      { name: "Paneer Sandwich", price: 10.99 },
      { name: "Paneer Bhurji Sandwich", price: 10.99 },
      { name: "Afghani Paneer Tikka Roll", price: 10.99 },
    ],
  },
  {
    name: "Starters",
    items: [
      { name: "French Fries", price: 6.99 },
      { name: "Peri Peri French Fries", price: 7.99 },
      { name: "Cheese French Fries", price: 7.99 },
      { name: "Potato Bites", price: 9.99 },
      { name: "Grilled Paneer Bites", price: 11.99 },
      { name: "Veg Fingers", price: 7.99 },
    ],
  },
  {
    name: "Indo Chinese",
    items: [
      { name: "Veg Momos (6 pcs)", price: 9.99 },
      { name: "Veg Fry Momo (6 pcs)", price: 9.99 },
      { name: "Veg Fry Schezwan Momo (6 pcs)", price: 10.99 },
      { name: "Veg Chowmein", price: 9.99 },
      { name: "Veg Noodles", price: 9.99 },
      { name: "Veg Noodles Soup", price: 9.99 },
      { name: "Veg Manchurian (Dry)", price: 12.99 },
      { name: "Veg Manchurian (Gravy)", price: 12.99 },
    ],
  },
  {
    name: "Soups",
    items: [
      { name: "Tomato Soup", price: 6.99 },
      { name: "Mix-Veg Soup", price: 6.99 },
      { name: "Hot & Sour Soup", price: 6.99 },
    ],
  },
  {
    name: "Main Course",
    items: [
      { name: "Palak Paneer with 2 Paratha", price: 12.99 },
      { name: "Chole with 2 Paratha", price: 12.99 },
      { name: "Mix Bhaji with 2 Roti", price: 12.99 },
      { name: "Aloo Curry with 2 Roti/2 Paratha", price: 12.99 },
    ],
  },
  {
    name: "South Indian",
    items: [
      { name: "Plain Dosa", price: 7.99 },
      { name: "Ghee Plain Dosa", price: 8.99 },
      { name: "Masala Dosa", price: 9.99 },
      { name: "Mysore Masala Dosa", price: 9.99 },
      { name: "Mix Veg Upma", price: 9.99 },
      { name: "Idli Sambar (3 pcs)", price: 9.99 },
      { name: "Vada Sambhar (3 pcs)", price: 10.99 },
      { name: "Peri Peri Masala Dosa", price: 9.99 },
      { name: "Paneer Masala Dosa", price: 10.99 },
      { name: "Paneer Ghee Dosa", price: 10.99 },
    ],
  },
  {
    name: "Shakes",
    items: [
      { name: "Cold Coffee", price: 4.99 },
      { name: "Kit-Kat Shake", price: 4.99 },
      { name: "Banana Shake", price: 4.99 },
      { name: "Banana Avocado Shake", price: 4.99 },
      { name: "Mango Shake", price: 4.99 },
      { name: "Mango Avocado Shake", price: 4.99 },
      { name: "Oreo Shake", price: 4.99 },
      { name: "Chocolate Shake", price: 4.99 },
      { name: "Malai Rabri Shake", price: 4.99 },
      { name: "Vanilla Shake", price: 4.99 },
      { name: "Kesar Pista Shake", price: 4.99 },
    ],
  },
  {
    name: "Hot Drinks",
    items: [
      { name: "Ginger Tea", price: 2.99 },
      { name: "Elaichi Tea", price: 2.99 },
      { name: "Hot Coffee", price: 2.99 },
      { name: "Hot Chocolate", price: 6.99 },
      { name: "Badam Milk", price: 6.99 },
    ],
  },
  {
    name: "Smoothies & Juices",
    items: [
      { name: "Sweet Lassi", price: 4.99 },
      { name: "Buttermilk", price: 4.99 },
      { name: "Rose Milk", price: 5.99 },
      { name: "Aam Ras / Mango Juice (16 oz)", price: 6.99 },
      { name: "Mango Lassi (16 oz)", price: 6.99 },
      { name: "Watermelon Juice (16 oz)", price: 8.99 },
      { name: "Mix Fruit Juice (16 oz)", price: 8.99 },
      { name: "Mix Veg Juice (16 oz)", price: 8.99 },
      { name: "Orange Juice (16 oz)", price: 8.99 },
      { name: "Pineapple Juice (16 oz)", price: 8.99 },
      { name: "Kiwi Juice (16 oz)", price: 8.99 },
      { name: "Sugarcane Juice (16 oz)", price: 8.99 },
    ],
  },
  {
    name: "Beverages & Soda",
    items: [
      { name: "Lemon Sarbat", price: 4.99 },
      { name: "Lemon Soda", price: 4.99 },
      { name: "Jaljeera Water", price: 4.99 },
      { name: "Aam Panna", price: 4.99 },
      { name: "Jaljeera Soda", price: 4.99 },
      { name: "Jeera Soda", price: 4.99 },
      { name: "Kokum Soda", price: 4.99 },
      { name: "Kacha Mango Soda", price: 4.99 },
      { name: "Pineapple Soda", price: 4.99 },
      { name: "Coconut Water", price: 4.99 },
    ],
  },
];

/** Everything the source priced as "Ask at counter" — reported, never invented. */
const UNPRICED = [
  "Chaat: Jain Vada Pav (Jain)",
  "Chaat: Jain Bhel (Jain)",
  "Fafda & Jalebi: Fafda (1 lb) — by weight",
  "Fafda & Jalebi: Jalebi (1 lb) — by weight",
  "Sweets: Gulab Jamun",
  "Sweets: Ras Malai",
  "Sweets: Rasgulla",
  "Sweets: Kaju Katli — by weight",
  "Sweets: Assorted Barfi — by weight",
  "Sweets: Assorted Laddu — by weight",
  "Sweets: Bengali Sweets — by weight",
  "Ice Cream & Kulfi: Kulfi",
  "Ice Cream & Kulfi: Kesar Pista Kulfi",
  "Ice Cream & Kulfi: Ice Cream",
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.error("Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.");
    process.exitCode = 1;
    return;
  }
  const db = createClient(url, key);

  const { data: restaurant, error: rErr } = await db
    .from("restaurants")
    .select("id, name")
    .eq("slug", RESTAURANT_SLUG)
    .single();
  if (rErr || !restaurant) {
    console.error(`Could not find restaurant "${RESTAURANT_SLUG}".`);
    process.exitCode = 1;
    return;
  }

  const totalItems = MENU.reduce((n, c) => n + c.items.length, 0);
  console.log(
    `${restaurant.name} — ${MENU.length} categories, ${totalItems} items`,
  );
  console.log(
    apply ? "MODE: APPLY\n" : "MODE: dry run (pass --apply to write)\n",
  );

  const { data: existingCats } = await db
    .from("categories")
    .select("id, name")
    .eq("restaurant_id", restaurant.id);
  const byName = new Map((existingCats ?? []).map((c) => [c.name, c.id]));

  let created = 0;
  let skipped = 0;

  for (const [ci, category] of MENU.entries()) {
    let categoryId = byName.get(category.name);

    if (!categoryId) {
      if (!apply) {
        console.log(
          `+ category ${category.name} (${category.items.length} items)`,
        );
        created += category.items.length;
        continue;
      }
      const { data: newCat, error } = await db
        .from("categories")
        .insert({
          restaurant_id: restaurant.id,
          name: category.name,
          description: category.description ?? null,
          display_order: ci + 1,
        })
        .select("id")
        .single();
      if (error || !newCat) {
        console.error(`  !! category ${category.name}: ${error?.message}`);
        continue;
      }
      categoryId = newCat.id;
      console.log(`+ category ${category.name}`);
    }

    for (const [ii, item] of category.items.entries()) {
      const row = {
        restaurant_id: restaurant.id,
        category_id: categoryId,
        name: item.name,
        slug: slugify(item.name),
        price: item.price,
        // Every item on these boards is vegetarian; the restaurant serves
        // no meat. Set so the AI's dietary filter and the menu's veg badge
        // work at all. Other allergen flags are left unset on purpose —
        // see this file's header.
        is_vegetarian: true,
        display_order: ii + 1,
      };
      if (!apply) continue;

      const { error } = await db.from("menu_items").insert(row);
      if (error) {
        if (error.message.includes("duplicate") || error.code === "23505") {
          skipped += 1;
        } else {
          console.error(`  !! ${item.name}: ${error.message}`);
        }
        continue;
      }
      created += 1;
    }
  }

  console.log(
    apply
      ? `\n${created} item(s) created, ${skipped} already present.`
      : `\n${created} item(s) would be created.`,
  );

  console.log(
    `\n${UNPRICED.length} item(s) NOT imported — priced "Ask at counter":`,
  );
  for (const line of UNPRICED) console.log(`  ${line}`);
  console.log(
    "\nAdd these from the dashboard once today's prices are known. The source\n" +
      "notes say not to price them from delivery-app markups.",
  );
}

main();
