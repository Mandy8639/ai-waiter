/**
 * The languages a menu can be translated into (phase K), and how a diner's
 * is chosen. Pure, so the choice is unit-tested.
 */

export const MENU_LANGUAGES = [
  { code: "hi", english: "Hindi", native: "हिन्दी", latin: false },
  { code: "es", english: "Spanish", native: "Español", latin: true },
  { code: "gu", english: "Gujarati", native: "ગુજરાતી", latin: false },
  { code: "te", english: "Telugu", native: "తెలుగు", latin: false },
] as const;

export type MenuLanguage = (typeof MENU_LANGUAGES)[number]["code"];

/** The cookie a diner's choice is kept in. "original" means the menu as written. */
export const MENU_LANGUAGE_COOKIE = "tableside_menu_lang";

export function isMenuLanguage(value: unknown): value is MenuLanguage {
  return MENU_LANGUAGES.some((l) => l.code === value);
}

export function languageInfo(code: MenuLanguage) {
  return MENU_LANGUAGES.find((l) => l.code === code)!;
}

/**
 * Which language to show the menu in: the diner's own choice if they made
 * one, otherwise the first of their browser's languages the menu is
 * actually available in, otherwise the menu as written (null). A choice
 * of a language the menu no longer has falls back to the original rather
 * than showing a half-empty translation.
 */
export function chooseMenuLanguage(options: {
  cookie: string | undefined;
  acceptLanguage: string | null;
  available: readonly string[];
}): MenuLanguage | null {
  const { cookie, acceptLanguage, available } = options;
  if (cookie === "original") return null;
  if (isMenuLanguage(cookie) && available.includes(cookie)) return cookie;

  for (const part of (acceptLanguage ?? "").split(",")) {
    const primary = part.split(";")[0].trim().toLowerCase().split("-")[0];
    if (primary === "en") return null; // the menu as written
    if (isMenuLanguage(primary) && available.includes(primary)) return primary;
  }
  return null;
}
