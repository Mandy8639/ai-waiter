/**
 * Menu translation (phase K), the parts with no database and no network:
 * what counts as the original, when a translation is out of date, and how
 * an AI draft is asked for and checked. Unit-tested.
 */
import { createHash } from "node:crypto";
import { languageInfo, type MenuLanguage } from "./languages";

export type TranslatableEntity = "menu_item" | "category";
export type TranslatableField = "name" | "description";

/**
 * The original exactly as the database hashes it
 * (menu_translation_source): descriptions trimmed, empty means none.
 */
export function sourceText(
  field: TranslatableField,
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  if (field === "description") {
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
  }
  return raw;
}

/** Same as the SQL menu_translation_hash(): sha256 of the UTF-8 text, hex. */
export function translationHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type TranslationState =
  | "missing"
  | "draft"
  | "approved"
  /** Approved, but the original has changed since: not shown to diners. */
  | "stale";

export function translationState(
  translation: { status: "draft" | "approved"; sourceHash: string } | null,
  currentSource: string,
): TranslationState {
  if (!translation) return "missing";
  if (translation.sourceHash !== translationHash(currentSource)) {
    return translation.status === "approved" ? "stale" : "draft";
  }
  return translation.status;
}

// AI drafting -------------------------------------------------------------------

/**
 * Only free models draft translations. This app must not spend money on AI
 * without the owner deciding to, and a paid model configured for the
 * waiter should not quietly start drafting menus too.
 */
export function isFreeModel(provider: string, model: string): boolean {
  return (
    provider === "openrouter" &&
    (model === "openrouter/free" || model.endsWith(":free"))
  );
}

export interface DraftField {
  key: string;
  kind: "dish name" | "dish description" | "category name";
  text: string;
}

export function draftPrompt(language: MenuLanguage, fields: DraftField[]) {
  const { english } = languageInfo(language);
  const system = [
    `You translate a restaurant's menu from English into ${english}.`,
    "Return ONLY a JSON object mapping each key to its translation, with no other text.",
    "Rules:",
    `- Dish names that are proper names (for example "Masala Dosa", "Pav Bhaji") are written out in ${english}'s own script as they sound, not translated word for word.`,
    "- Plain descriptive names and descriptions are translated naturally.",
    "- Never add, remove or change an ingredient, a quantity or a number.",
    "- Never add claims such as vegetarian, halal, spicy or allergen-free.",
    "- Keep it about the same length as the original.",
  ].join("\n");
  const user = JSON.stringify(
    Object.fromEntries(
      fields.map((f) => [f.key, { kind: f.kind, text: f.text }]),
    ),
  );
  return { system, user };
}

/**
 * Pulls the translations out of a model's reply. Anything missing, empty,
 * too long, or (for a non-Latin script) left in English is dropped rather
 * than saved — a skipped field just stays "missing" for the owner.
 */
export function parseDraftReply(
  reply: string,
  fields: DraftField[],
  language: MenuLanguage,
): Map<string, string> {
  const out = new Map<string, string>();
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;

  const latin = languageInfo(language).latin;
  for (const field of fields) {
    const value = (parsed as Record<string, unknown>)[field.key];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text === "" || text.length > 1000) continue;
    if (!latin && text === field.text.trim()) continue;
    out.set(field.key, text);
  }
  return out;
}
