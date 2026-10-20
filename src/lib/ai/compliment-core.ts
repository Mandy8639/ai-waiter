import type { FallbackLanguage } from "./fallback-text";

/**
 * A diner who only says something kind ("I like the food here", "that was
 * delicious, thanks!") gets a fixed, warm reply instead of the model.
 *
 * WHY NOT THE MODEL. On 2026-10-20 a diner who had finished eating told the
 * waiter "I like the food here" and got the menu pitched back at them. The
 * prompt now says not to (src/lib/ai/system-prompt.ts), but the free waiter
 * model kept offering "a drink, dessert?" in 6 of 8 tries anyway. A thank-
 * you needs no menu facts, so a hand-written reply is both right and free.
 *
 * DELIBERATELY NARROW. Anything with a question, a request, a complaint or
 * a "but" goes to the model as before: "loved the naan, can we get two
 * more?" is an order, and "good but cold" is a complaint. Missing a
 * compliment costs nothing (the model answers, as it always did); catching
 * a request by mistake would ignore the diner, so the rules err that way.
 *
 * No `server-only`, so it is unit-testable directly.
 */

const POSITIVE =
  /(?<![\p{L}])(thanks?|thank you|thx|ty|cheers|love[ds]?|lovely|liked?|enjoy(ed|ing)?|delicious|tasty|yummy|amazing|awesome|great|excellent|fantastic|wonderful|perfect|superb|so good|very good|really good|was good|is good|good food|nice food|well done|shukriya|dhanyavaa?d|bahut acc?h(a|i)|ac?ch(a|i) (tha|thi|hai)|mast|gracias|delicios[oa]|riqu[ií]sim[oa]|muy ric[oa]|me encant[oó]|buen[ií]sim[oa]|धन्यवाद|शुक्रिया|स्वादिष्ट|बहुत अच्छा|बहुत बढ़िया|मज़ा आ गया|मजा आ गया)(?![\p{L}])/iu;

/** Anything that asks for something, or isn't wholly happy. */
const NOT_ONLY_PRAISE =
  /\?|(?<![\p{L}])(order|add|get|want|more|another|bring|can|could|would|will|need|bill|check|menu|recommend|suggest|what|how|where|when|which|why|who|is there|do you|allerg\w*|spic\w*|price|cost|cart|pay|please|not|no|n't|never|but|however|though|bad|cold|late|slow|wrong|salty|bland|too|raw|burnt|sick|cuenta|quiero|pero|nahi|nahin|lekin|नहीं|लेकिन|बिल|और)(?![\p{L}])/iu;

/** Long messages are rarely only a thank-you; let the model read them. */
const MAX_LENGTH = 100;

export function isOnlyCompliment(message: string): boolean {
  const text = message.trim();
  if (text.length === 0 || text.length > MAX_LENGTH) return false;
  return POSITIVE.test(text) && !NOT_ONLY_PRAISE.test(text);
}

const REPLY: Record<FallbackLanguage, string> = {
  en: "Thank you, that's lovely to hear! 😊 Whenever you're ready, I can ask for your bill or call a member of staff over. Just say the word.",
  hi: "बहुत-बहुत धन्यवाद, सुनकर अच्छा लगा! 😊 बिल चाहिए या किसी स्टाफ़ को बुलाना हो, तो बस बता दीजिए।",
  es: "¡Muchas gracias, qué alegría oírlo! 😊 Cuando quieras, pido la cuenta o llamo a alguien del personal. Solo dímelo.",
};

/** Hand-written per language, never generated (see fallback-text.ts). */
export function complimentReply(language: FallbackLanguage): string {
  return REPLY[language];
}
