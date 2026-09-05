import { describe, it, expect } from "vitest";
import {
  parseExtraction,
  extractJsonObject,
  normaliseCategoryName,
  EXTRACTION_PROMPT,
} from "@/lib/menu-import/extraction";

describe("extractJsonObject", () => {
  it("finds JSON wrapped in prose, which vision models routinely add", () => {
    const found = extractJsonObject(
      'Here is the menu:\n```json\n{"categories":[]}\n```\nHope that helps!',
    );
    expect(found).toBe('{"categories":[]}');
  });

  it("does not truncate on a brace inside an item name", () => {
    // "Combo {2 pcs}" is the kind of thing a naive lastIndexOf('}') breaks on.
    const text =
      '{"categories":[{"name":"A","items":[{"name":"Combo {2 pcs}","price":5}]}]}';
    expect(extractJsonObject(`noise ${text} more noise`)).toBe(text);
  });

  it("handles escaped quotes inside strings", () => {
    const text = '{"categories":[{"name":"The \\"Big\\" One","items":[]}]}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("returns null when there is no object at all", () => {
    expect(extractJsonObject("I could not read that image.")).toBeNull();
  });
});

describe("normaliseCategoryName", () => {
  it.each([
    ["SOUTH INDIAN  —", "SOUTH INDIAN"],
    ["  Chaat  ", "Chaat"],
    ["PARATHA :", "PARATHA"],
    ["Shakes   &   Juices", "Shakes & Juices"],
  ])("normalises %s", (input, expected) => {
    expect(normaliseCategoryName(input)).toBe(expected);
  });
});

describe("parseExtraction", () => {
  const good = JSON.stringify({
    categories: [
      {
        name: "CHAAT",
        items: [
          { name: "Pani Puri (7 pcs)", price: 6.99 },
          { name: "Jain Bhel", price: null },
        ],
      },
      { name: "SWEETS", items: [{ name: "Gulab Jamun", price: null }] },
    ],
  });

  it("keeps a null price as null — never zero", () => {
    // The single most important behaviour in this module. A board that
    // gives no price must not become a $0.00 item a diner can order.
    const out = parseExtraction(good);
    expect(out.ok).toBe(true);
    const jain = out.drafts.find((d) => d.name === "Jain Bhel");
    expect(jain?.price).toBeNull();
    expect(jain?.price).not.toBe(0);
  });

  it("counts unpriced items so the UI can say so before committing", () => {
    expect(parseExtraction(good).unpricedCount).toBe(2);
  });

  it("preserves item names exactly, including piece counts", () => {
    const out = parseExtraction(good);
    expect(out.drafts.map((d) => d.name)).toContain("Pani Puri (7 pcs)");
  });

  it("drops a duplicate of the same dish in the same category", () => {
    // Long boards get photographed in overlapping sections.
    const out = parseExtraction(
      JSON.stringify({
        categories: [
          {
            name: "Chaat",
            items: [
              { name: "Bhel Puri", price: 7.99 },
              { name: "bhel puri", price: 7.99 },
            ],
          },
        ],
      }),
    );
    expect(out.drafts).toHaveLength(1);
  });

  it("keeps the same dish name under two different categories", () => {
    const out = parseExtraction(
      JSON.stringify({
        categories: [
          { name: "Lunch", items: [{ name: "Masala Dosa", price: 9.99 }] },
          { name: "Dinner", items: [{ name: "Masala Dosa", price: 11.99 }] },
        ],
      }),
    );
    expect(out.drafts).toHaveLength(2);
  });

  it.each([
    ["not JSON at all", "Sorry, I can't read this image."],
    ["malformed JSON", '{"categories": [ }'],
    ["wrong shape", '{"items": ["Dosa"]}'],
    [
      "a negative price",
      '{"categories":[{"name":"A","items":[{"name":"X","price":-5}]}]}',
    ],
    [
      "a price as a string",
      '{"categories":[{"name":"A","items":[{"name":"X","price":"9.99"}]}]}',
    ],
  ])("fails safely on %s, importing nothing", (_label, input) => {
    const out = parseExtraction(input);
    expect(out.ok).toBe(false);
    expect(out.drafts).toHaveLength(0);
    expect(out.error).toBeTruthy();
    // The message reaches a restaurant owner, so it must not be a raw
    // parser or Zod error.
    expect(out.error).not.toMatch(/zod|unexpected token|SyntaxError/i);
  });

  it("treats an empty menu as a failure worth explaining, not a silent success", () => {
    const out = parseExtraction('{"categories":[]}');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no menu items/i);
  });
});

describe("EXTRACTION_PROMPT", () => {
  it("forbids inventing a price in as many words", () => {
    // Asserted because it is the instruction the whole feature rests on;
    // an edit that softens it should fail a test, not pass review.
    expect(EXTRACTION_PROMPT).toMatch(/NEVER invent/);
    expect(EXTRACTION_PROMPT).toMatch(/null/);
    expect(EXTRACTION_PROMPT).toMatch(/ask at counter/i);
  });
});
