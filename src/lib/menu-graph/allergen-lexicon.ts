/**
 * The menu knowledge graph's allergen vocabulary: one canonical name per
 * allergen group, the words diners and restaurants use for each, and the
 * ingredient words that suggest a dish contains one.
 *
 * THE ONE-WAY RULE. Everything here can only ADD caution. A word match
 * makes a dish "likely contains dairy (made with paneer)"; the absence of
 * any match never makes a dish "dairy-free". That is the same rule
 * src/lib/menu/diet-filters.ts applies to the restaurant's own flags: a
 * missing allergen means "not stated", and only the restaurant can say a
 * dish is free of something. An inference that lowered caution would turn
 * a gap in the data into a promise a diner with an allergy acts on.
 *
 * Pure: no `server-only`, unit-tested in tests/unit/menu-graph.test.ts.
 */

export const ALLERGEN_GROUPS = [
  "dairy",
  "egg",
  "fish",
  "shellfish",
  "nuts",
  "peanuts",
  "gluten",
  "soy",
  "sesame",
  "mustard",
] as const;

export type AllergenGroup = (typeof ALLERGEN_GROUPS)[number];

export const ALLERGEN_LABELS: Record<AllergenGroup, string> = {
  dairy: "Dairy",
  egg: "Egg",
  fish: "Fish",
  shellfish: "Shellfish",
  nuts: "Tree nuts",
  peanuts: "Peanuts",
  gluten: "Gluten",
  soy: "Soy",
  sesame: "Sesame",
  mustard: "Mustard",
};

/**
 * What a diner or a restaurant's own allergen list might call each group.
 * Matched as whole words, case-insensitively, after plurals are trimmed.
 */
const NAMES: Record<AllergenGroup, string[]> = {
  dairy: ["dairy", "milk", "lactose", "casein", "whey"],
  egg: ["egg", "eggs"],
  fish: ["fish"],
  shellfish: [
    "shellfish",
    "crustacean",
    "crustaceans",
    "mollusc",
    "molluscs",
    "mollusk",
    "mollusks",
  ],
  nuts: ["nut", "nuts", "tree nut", "tree nuts"],
  peanuts: ["peanut", "peanuts", "groundnut", "groundnuts"],
  gluten: ["gluten", "wheat", "coeliac", "celiac"],
  soy: ["soy", "soya", "soybean", "soybeans"],
  sesame: ["sesame"],
  mustard: ["mustard"],
};

/**
 * Words in an ingredient or dish name that suggest the group. Kept to
 * words that almost always mean it in a restaurant kitchen ("butter" in
 * "Butter Chicken" is real butter; "peanut" in a dish is peanuts), with
 * Indian-kitchen terms because that's who uses Tableside today.
 */
const INGREDIENT_WORDS: Record<AllergenGroup, string[]> = {
  dairy: [
    "milk",
    "cream",
    "butter",
    "ghee",
    "paneer",
    "cheese",
    "yoghurt",
    "yogurt",
    "curd",
    "dahi",
    "raita",
    "lassi",
    "malai",
    "khoa",
    "khoya",
    "kheer",
    "rasmalai",
    "makhani",
    "buttermilk",
    "chaas",
    "whey",
    "mozzarella",
    "parmesan",
    "kulfi",
    "shrikhand",
    "rabri",
    "custard",
    "ice cream",
    "milkshake",
  ],
  egg: ["egg", "eggs", "omelette", "omelet", "mayonnaise", "mayo", "anda"],
  fish: [
    "fish",
    "salmon",
    "tuna",
    "cod",
    "tilapia",
    "pomfret",
    "surmai",
    "anchovy",
    "anchovies",
    "machli",
    "macher",
  ],
  shellfish: [
    "shrimp",
    "prawn",
    "prawns",
    "crab",
    "lobster",
    "scallop",
    "scallops",
    "mussel",
    "mussels",
    "clam",
    "clams",
    "oyster",
    "oysters",
    "squid",
    "calamari",
    "jhinga",
  ],
  nuts: [
    "cashew",
    "cashews",
    "kaju",
    "almond",
    "almonds",
    "badam",
    "pistachio",
    "pistachios",
    "pista",
    "walnut",
    "walnuts",
    "hazelnut",
    "hazelnuts",
    "pecan",
    "pecans",
    "macadamia",
    "praline",
    "marzipan",
    "korma",
  ],
  peanuts: ["peanut", "peanuts", "groundnut", "groundnuts", "chikki"],
  gluten: [
    "wheat",
    "flour",
    "maida",
    "atta",
    "naan",
    "roti",
    "chapati",
    "paratha",
    "kulcha",
    "puri",
    "bhatura",
    "semolina",
    "sooji",
    "suji",
    "rava",
    "barley",
    "rye",
    "bread",
    "bun",
    "pasta",
    "noodles",
    "samosa",
    "seitan",
  ],
  soy: ["soy", "soya", "tofu", "edamame", "tempeh", "miso"],
  sesame: ["sesame", "til", "tahini"],
  mustard: ["mustard", "sarson", "rai"],
};

/** Lower-case, single-spaced, with a trailing plural "s" trimmed per word. */
function words(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

function hasWord(haystack: string, word: string): boolean {
  return haystack.includes(` ${word} `);
}

/** The groups a diner's own words name ("I can't have milk or peanuts"). */
export function allergenGroupsIn(text: string): AllergenGroup[] {
  const hay = words(text);
  return ALLERGEN_GROUPS.filter((group) =>
    NAMES[group].some((name) => hasWord(hay, name)),
  );
}

/** Which group a restaurant's allergen entry belongs to, if any. */
export function groupOfAllergenName(name: string): AllergenGroup | null {
  const hay = words(name);
  // Whole words, so "Peanuts" is peanuts and never tree nuts.
  for (const group of ALLERGEN_GROUPS) {
    if (NAMES[group].some((n) => hasWord(hay, n))) return group;
  }
  return null;
}

/**
 * The ingredient words in a name that suggest each group: "Paneer Butter
 * Masala" → dairy (paneer, butter). Only positives; see the one-way rule.
 */
export function suggestedGroups(
  name: string,
): { group: AllergenGroup; word: string }[] {
  const hay = words(name);
  const found: { group: AllergenGroup; word: string }[] = [];
  for (const group of ALLERGEN_GROUPS) {
    const word = INGREDIENT_WORDS[group].find((w) => hasWord(hay, w));
    if (word) found.push({ group, word });
  }
  return found;
}
