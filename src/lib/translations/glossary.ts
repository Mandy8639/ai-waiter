import type { MenuLanguage } from "./languages";

/**
 * Safety words, translated once and fixed (phase K).
 *
 * Allergens and dietary labels are never sent to the AI and never come from
 * a restaurant's own translations. They come from this list, and they are
 * always shown WITH the English word — "Peanuts (मूंगफली)" — so the source
 * of truth is on the screen even if a translation here were wrong.
 *
 * These translations were written without a fluent reviewer for every
 * language. Have a fluent speaker check a language before relying on it,
 * and change an entry only with one. An allergen or label missing here is
 * simply shown in English.
 */

const ALLERGENS: Record<string, Record<MenuLanguage, string>> = {
  Milk: { hi: "दूध", es: "Leche", gu: "દૂધ", te: "పాలు" },
  Eggs: { hi: "अंडे", es: "Huevos", gu: "ઈંડાં", te: "గుడ్లు" },
  Fish: { hi: "मछली", es: "Pescado", gu: "માછલી", te: "చేప" },
  Shellfish: { hi: "शेलफ़िश", es: "Mariscos", gu: "શેલફિશ", te: "షెల్ఫిష్" },
  "Tree nuts": {
    hi: "मेवे",
    es: "Frutos secos",
    gu: "સૂકો મેવો",
    te: "గింజలు",
  },
  Peanuts: { hi: "मूंगफली", es: "Maní", gu: "મગફળી", te: "వేరుశనగ" },
  Wheat: { hi: "गेहूं", es: "Trigo", gu: "ઘઉં", te: "గోధుమ" },
  Soy: { hi: "सोया", es: "Soja", gu: "સોયા", te: "సోయా" },
  Sesame: { hi: "तिल", es: "Sésamo", gu: "તલ", te: "నువ్వులు" },
  Mustard: { hi: "सरसों", es: "Mostaza", gu: "રાઈ", te: "ఆవాలు" },
  Celery: { hi: "सेलेरी", es: "Apio", gu: "સેલરી", te: "సెలెరీ" },
  Sulphites: { hi: "सल्फाइट", es: "Sulfitos", gu: "સલ્ફાઇટ", te: "సల్ఫైట్లు" },
};

const LABELS: Record<string, Record<MenuLanguage, string>> = {
  Vegetarian: {
    hi: "शाकाहारी",
    es: "Vegetariano",
    gu: "શાકાહારી",
    te: "శాకాహారం",
  },
  Vegan: { hi: "वीगन", es: "Vegano", gu: "વીગન", te: "వీగన్" },
  Spicy: { hi: "तीखा", es: "Picante", gu: "તીખું", te: "కారం" },
  Halal: { hi: "हलाल", es: "Halal", gu: "હલાલ", te: "హలాల్" },
  Kosher: { hi: "कोशर", es: "Kosher", gu: "કોશર", te: "కోషర్" },
};

function lookup(
  table: Record<string, Record<MenuLanguage, string>>,
  english: string,
  language: MenuLanguage | null,
): string | null {
  if (!language) return null;
  const key = Object.keys(table).find(
    (k) => k.toLowerCase() === english.trim().toLowerCase(),
  );
  const translated = key ? table[key][language] : null;
  // Nothing to add when the word is the same (Spanish "Halal").
  return translated && translated !== english ? translated : null;
}

/** "Peanuts" → "Peanuts (मूंगफली)"; unknown allergens stay as written. */
export function allergenWithTranslation(
  english: string,
  language: MenuLanguage | null,
): string {
  const t = lookup(ALLERGENS, english, language);
  return t ? `${english} (${t})` : english;
}

/** "Vegetarian" → "Vegetarian · शाकाहारी". */
export function labelWithTranslation(
  english: string,
  language: MenuLanguage | null,
): string {
  const t = lookup(LABELS, english, language);
  return t ? `${english} · ${t}` : english;
}

export const GLOSSARY_ALLERGENS = Object.keys(ALLERGENS);
export const GLOSSARY_LABELS = Object.keys(LABELS);
