import { describe, expect, it } from "vitest";
import {
  draftPrompt,
  isFreeModel,
  parseDraftReply,
  sourceText,
  translationHash,
  translationState,
  type DraftField,
} from "@/lib/translations/core";
import { chooseMenuLanguage } from "@/lib/translations/languages";
import {
  GLOSSARY_ALLERGENS,
  allergenWithTranslation,
  labelWithTranslation,
} from "@/lib/translations/glossary";
import { ALLERGEN_VOCABULARY } from "@/lib/menu-import/suggestions";

/**
 * Phase K, the parts without a database: which language a diner sees,
 * when a translation is out of date, what the AI is asked and what of its
 * reply is kept, and the fixed safety glossary.
 */

describe("which language a diner sees", () => {
  const available = ["hi", "es"];

  it("uses the diner's own choice when the menu has it", () => {
    expect(
      chooseMenuLanguage({ cookie: "es", acceptLanguage: "hi-IN", available }),
    ).toBe("es");
  });

  it("shows the original when the diner chose it, whatever their phone says", () => {
    expect(
      chooseMenuLanguage({
        cookie: "original",
        acceptLanguage: "hi",
        available,
      }),
    ).toBeNull();
  });

  it("otherwise follows the phone's languages, first match wins", () => {
    expect(
      chooseMenuLanguage({
        cookie: undefined,
        acceptLanguage: "hi-IN,hi;q=0.9,en;q=0.8",
        available,
      }),
    ).toBe("hi");
    expect(
      chooseMenuLanguage({
        cookie: undefined,
        acceptLanguage: "fr-FR,es;q=0.5",
        available,
      }),
    ).toBe("es");
  });

  it("stops at English: an English phone sees the menu as written", () => {
    expect(
      chooseMenuLanguage({
        cookie: undefined,
        acceptLanguage: "en-US,hi;q=0.5",
        available,
      }),
    ).toBeNull();
  });

  it("falls back to the original for a language the menu no longer has", () => {
    expect(
      chooseMenuLanguage({ cookie: "te", acceptLanguage: null, available }),
    ).toBeNull();
  });
});

describe("when a translation is shown", () => {
  const source = "Crisp rice crepe with spiced potato.";
  const hash = translationHash(source);

  it("shows an approved translation of the current original", () => {
    expect(
      translationState({ status: "approved", sourceHash: hash }, source),
    ).toBe("approved");
  });

  it("marks an approved translation stale once the original changes", () => {
    expect(
      translationState(
        { status: "approved", sourceHash: hash },
        "Now with peanut chutney.",
      ),
    ).toBe("stale");
  });

  it("keeps drafts as drafts, and reports what's missing", () => {
    expect(
      translationState({ status: "draft", sourceHash: hash }, source),
    ).toBe("draft");
    expect(translationState(null, source)).toBe("missing");
  });

  it("reads descriptions the way the database does: trimmed, empty is none", () => {
    expect(sourceText("description", "  Hot.  ")).toBe("Hot.");
    expect(sourceText("description", "   ")).toBeNull();
    expect(sourceText("description", null)).toBeNull();
    expect(sourceText("name", " Dosa ")).toBe(" Dosa ");
  });
});

describe("AI drafting", () => {
  it("only ever uses a free model", () => {
    expect(isFreeModel("openrouter", "openrouter/free")).toBe(true);
    expect(
      isFreeModel("openrouter", "meta-llama/llama-3.3-70b-instruct:free"),
    ).toBe(true);
    expect(isFreeModel("openrouter", "anthropic/claude-opus-5")).toBe(false);
    expect(isFreeModel("anthropic", "claude-opus-5")).toBe(false);
  });

  const fields: DraftField[] = [
    { key: "f0", kind: "dish name", text: "Masala Dosa" },
    { key: "f1", kind: "dish description", text: "Crisp rice crepe." },
    { key: "f2", kind: "category name", text: "Mains" },
  ];

  it("asks for JSON only, and forbids inventing ingredients or claims", () => {
    const { system, user } = draftPrompt("hi", fields);
    expect(system).toContain("into Hindi");
    expect(system).toMatch(/Never add, remove or change an ingredient/);
    expect(system).toMatch(/Never add claims/);
    expect(JSON.parse(user)).toEqual({
      f0: { kind: "dish name", text: "Masala Dosa" },
      f1: { kind: "dish description", text: "Crisp rice crepe." },
      f2: { kind: "category name", text: "Mains" },
    });
  });

  it("keeps good translations, even from a chatty reply wrapped in a code fence", () => {
    const reply =
      'Here you go:\n```json\n{"f0": "मसाला डोसा", "f1": "कुरकुरा चावल का क्रेप।", "f2": "मुख्य व्यंजन"}\n```';
    expect(Object.fromEntries(parseDraftReply(reply, fields, "hi"))).toEqual({
      f0: "मसाला डोसा",
      f1: "कुरकुरा चावल का क्रेप।",
      f2: "मुख्य व्यंजन",
    });
  });

  it("drops what's missing, empty, invented or left in English", () => {
    const reply = JSON.stringify({
      f0: "Masala Dosa", // untranslated into a non-Latin script
      f1: "   ",
      f9: "a key nobody asked for",
    });
    expect(parseDraftReply(reply, fields, "hi").size).toBe(0);
  });

  it("accepts a Spanish name that is the same as the English", () => {
    const reply = JSON.stringify({ f0: "Masala Dosa" });
    expect(parseDraftReply(reply, fields, "es").get("f0")).toBe("Masala Dosa");
  });

  it("accepts a reply in the request's own shape, with the translation in text", () => {
    const reply = JSON.stringify({
      f0: { kind: "dish name", text: "Masala Dosa" },
      f1: { kind: "dish description", text: "Crepe de arroz crujiente." },
      f2: { kind: "category name" },
    });
    expect(Object.fromEntries(parseDraftReply(reply, fields, "es"))).toEqual({
      f0: "Masala Dosa",
      f1: "Crepe de arroz crujiente.",
    });
  });

  it("still drops an English echo in that shape for a non-Latin script", () => {
    const reply = JSON.stringify({
      f0: { kind: "dish name", text: "Masala Dosa" },
    });
    expect(parseDraftReply(reply, fields, "hi").size).toBe(0);
  });

  it("returns nothing for a reply that isn't JSON", () => {
    expect(parseDraftReply("Sorry, I can't help.", fields, "te").size).toBe(0);
  });
});

describe("the safety glossary", () => {
  it("covers every allergen the menu tools use", () => {
    expect([...GLOSSARY_ALLERGENS].sort()).toEqual(
      [...ALLERGEN_VOCABULARY].sort(),
    );
  });

  it("always keeps the English word, with the translation beside it", () => {
    expect(allergenWithTranslation("Peanuts", "hi")).toBe("Peanuts (मूंगफली)");
    expect(labelWithTranslation("Vegetarian", "te")).toBe(
      "Vegetarian · శాకాహారం",
    );
  });

  it("shows only the English for an allergen it doesn't know, or with no language chosen", () => {
    expect(allergenWithTranslation("Lupin", "hi")).toBe("Lupin");
    expect(allergenWithTranslation("Peanuts", null)).toBe("Peanuts");
  });

  it("adds nothing when the word is the same in both languages", () => {
    expect(labelWithTranslation("Halal", "es")).toBe("Halal");
  });
});
