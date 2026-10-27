/**
 * The waiter's fixed replies — the ones the app says when the model can't
 * be trusted to — in the languages phase E supports.
 *
 * WHY THESE EXIST. When a guard exhausts its retry, the model refuses, or a
 * turn runs out of tool calls, the diner gets one of these instead of
 * anything the model wrote. Until phase E they were English only, so a
 * diner who asked in Hindi — the exact turn a guard is most likely to
 * catch, since the guards only recently learned Hindi — got "I wasn't able
 * to pull that up from the menu" back. Live on 2026-09-25, that happened.
 *
 * HAND-WRITTEN, NEVER GENERATED. These are the replies that exist because
 * the model is not trustworthy on this turn; asking the model to translate
 * them would put it straight back in charge. They carry no menu facts, so
 * a fixed string per language is all they need. Hindi phrasing avoids a
 * gendered first person ("मैं ... सकता/सकती"), since the waiter has none.
 *
 * No `server-only`, so it is unit-testable directly.
 */

export type FallbackLanguage = "en" | "hi" | "es";

export type FallbackKey =
  "menuFact" | "cartState" | "decline" | "toolLimit" | "didNotCatch";

const TEXT: Record<FallbackKey, Record<FallbackLanguage, string>> = {
  menuFact: {
    en: "I wasn't able to pull that up from the menu just now — could you try asking again, or check with the staff?",
    hi: "माफ़ कीजिए, अभी मेन्यू से यह जानकारी नहीं मिल पाई — कृपया दोबारा पूछें, या स्टाफ़ से पूछ लें।",
    es: "Ahora mismo no he podido consultarlo en el menú. ¿Puedes volver a preguntar, o consultarlo con el personal?",
  },
  cartState: {
    en: "I couldn't confirm what's in your cart just now — could you open the cart to check, or ask me again?",
    hi: "अभी आपके कार्ट में क्या है, यह पक्का नहीं हो पाया — कृपया कार्ट खोलकर देख लें, या दोबारा पूछें।",
    es: "Ahora mismo no he podido comprobar qué hay en tu carrito. ¿Puedes abrir el carrito para verlo, o volver a preguntarme?",
  },
  decline: {
    en: "I'm not able to help with that. Is there something else about the menu or your order I can help with?",
    hi: "माफ़ कीजिए, इसमें मदद नहीं हो पाएगी। क्या मेन्यू या आपके ऑर्डर के बारे में कुछ और बताऊँ?",
    es: "No puedo ayudarte con eso. ¿Hay algo más sobre el menú o tu pedido en lo que pueda ayudarte?",
  },
  toolLimit: {
    en: "I'm having trouble finishing that in one go — could you break that into a smaller request?",
    hi: "यह एक बार में पूरा नहीं हो पा रहा — क्या आप इसे छोटे-छोटे हिस्सों में पूछ सकते हैं?",
    es: "No consigo terminar eso de una vez. ¿Podrías pedirlo por partes?",
  },
  didNotCatch: {
    en: "Sorry, I didn't quite catch that — could you say it a different way?",
    hi: "माफ़ कीजिए, बात ठीक से समझ नहीं आई — क्या आप इसे दूसरे तरीके से कह सकते हैं?",
    es: "Perdona, no te he entendido bien. ¿Puedes decirlo de otra manera?",
  },
};

const DEVANAGARI = /\p{Script=Devanagari}/u;

/**
 * Spanish punctuation and letters English never uses, or a handful of
 * words that are unmistakably Spanish in a diner's message. Deliberately
 * conservative: a message this misses gets English, which is what every
 * diner got before, not a wrong language.
 */
const SPANISH =
  /[¿¡ñÑ]|(?<![\p{L}])(hola|gracias|por favor|quiero|quisiera|cu[aá]nto|cu[aá]nta|tienen|tiene|qu[eé]|d[oó]nde|la cuenta|el men[uú]|me gustar[ií]a|puedo|pedir)(?![\p{L}])/iu;

/**
 * Which language to answer a fixed reply in, from the diner's own message.
 * Hindi typed in English letters gets English: the diner reads Latin
 * script, and a Devanagari reply they didn't write in could be harder to
 * read, not easier.
 */
export function fallbackLanguage(message: string): FallbackLanguage {
  if (DEVANAGARI.test(message)) return "hi";
  if (SPANISH.test(message)) return "es";
  return "en";
}

export function fallbackText(
  key: FallbackKey,
  language: FallbackLanguage,
): string {
  return TEXT[key][language];
}

/**
 * When the model came back with nothing after its menu lookups had found
 * dishes (busy-Saturday audit: "what do you recommend?" got "didn't quite
 * catch that" while search_menu had returned the whole menu). The dishes
 * and prices come from those lookups, never the model; only the words
 * around them are fixed, here, per language.
 */
export type FoundDishesKind = "favorites" | "found";

const FOUND_DISHES: Record<
  FoundDishesKind,
  Record<FallbackLanguage, (list: string) => string>
> = {
  favorites: {
    en: (list) =>
      `Some favorites here: ${list}. Tap a dish to see more, or ask me about any of them.`,
    hi: (list) =>
      `यहाँ के कुछ पसंदीदा: ${list}। किसी डिश पर टैप करके और देखें, या उसके बारे में पूछें।`,
    es: (list) =>
      `Algunos favoritos de la casa: ${list}. Toca un plato para ver más, o pregúntame por cualquiera.`,
  },
  found: {
    en: (list) =>
      `Here's what I found on the menu: ${list}. Tap a dish to see more, or ask me about any of them.`,
    hi: (list) =>
      `मेन्यू में ये मिले: ${list}। किसी डिश पर टैप करके और देखें, या उसके बारे में पूछें।`,
    es: (list) =>
      `Esto es lo que he encontrado en el menú: ${list}. Toca un plato para ver más, o pregúntame por cualquiera.`,
  },
};

/** `dishes` already formatted, e.g. "Butter Chicken ($18.00)". */
export function foundDishesText(
  dishes: readonly string[],
  kind: FoundDishesKind,
  language: FallbackLanguage,
): string {
  return FOUND_DISHES[kind][language](dishes.join(", "));
}

const ALL_TEXTS = new Set(
  Object.values(TEXT).flatMap((byLanguage) => Object.values(byLanguage)),
);

/**
 * Is this reply one of the fixed ones above, i.e. the waiter couldn't
 * answer? Exact match only: the texts are hand-written and never vary.
 * Used by the Chef to look apologetic (src/lib/chef/core.ts); it changes
 * nothing about when a fixed reply is sent.
 */
export function isFallbackText(reply: string): boolean {
  return ALL_TEXTS.has(reply.trim());
}
