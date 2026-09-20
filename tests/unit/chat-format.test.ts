import { describe, expect, it } from "vitest";
import {
  chatPlainText,
  parseChatMarkdown,
  parseInline,
} from "@/lib/ai/chat-format";

/**
 * The chat used to print the waiter's markdown verbatim: a diner saw
 * `**Masala Dosa**` and a pipe-drawn table (observed live 2026-09-19).
 * These pin both halves of the fix — the constructs the waiter uses are
 * understood, and nothing the model writes can become a link or markup.
 */

describe("parseInline", () => {
  it("reads bold, italic and inline code", () => {
    expect(parseInline("The **Masala Dosa** is *mild* — `$9.99`")).toEqual([
      { type: "text", text: "The " },
      { type: "strong", children: [{ type: "text", text: "Masala Dosa" }] },
      { type: "text", text: " is " },
      { type: "em", children: [{ type: "text", text: "mild" }] },
      { type: "text", text: " — " },
      { type: "code", text: "$9.99" },
    ]);
  });

  it("leaves an unmatched asterisk as text", () => {
    expect(parseInline("Rated 5* by nobody")).toEqual([
      { type: "text", text: "Rated 5* by nobody" },
    ]);
  });

  it("does not treat multiplication-style asterisks as emphasis", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([
      { type: "text", text: "2 * 3 * 4" },
    ]);
  });

  it("drops link targets and keeps the words", () => {
    // A clickable URL chosen by a model is what an injection would want.
    expect(parseInline("See [our menu](https://evil.example) now")).toEqual([
      { type: "text", text: "See our menu now" },
    ]);
  });

  it("keeps HTML as literal text", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
      { type: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });
});

describe("parseChatMarkdown", () => {
  it("renders the reply observed live as a paragraph, a table and a question", () => {
    const reply = [
      "The standard **Masala Dosa** is **$9.99**.",
      "",
      "| Dosa | Price |",
      "|------|-------|",
      "| Masala Dosa | $9.99 |",
      "| Paneer Masala Dosa | $10.99 |",
      "",
      "Would you like me to add one?",
    ].join("\n");

    const blocks = parseChatMarkdown(reply);
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "table",
      "paragraph",
    ]);
    const table = blocks[1];
    if (table.type !== "table") throw new Error("expected a table");
    expect(table.header).toHaveLength(2);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1][0]).toEqual([
      { type: "text", text: "Paneer Masala Dosa" },
    ]);
  });

  it("groups bullets, including wrapped continuation lines", () => {
    const blocks = parseChatMarkdown(
      "- **Fafda** — crispy\n  and not spicy\n- Jalebi\n\nAnything else?",
    );
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    if (blocks[0].type !== "list") throw new Error("expected a list");
    expect(blocks[0].items).toHaveLength(2);
    expect(chatPlainText("- **Fafda** — crispy\n  and not spicy")).toBe(
      "Fafda — crispy and not spicy",
    );
    expect(blocks[1].type).toBe("paragraph");
  });

  it("recognises numbered lists and headings", () => {
    const blocks = parseChatMarkdown("### Light options\n1. Soup\n2) Salad");
    expect(blocks[0].type).toBe("heading");
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true });
  });

  it("keeps a pipe line without a separator as text", () => {
    const blocks = parseChatMarkdown("| just a pipe |");
    expect(blocks).toHaveLength(1);
    expect(chatPlainText("| just a pipe |")).toBe("| just a pipe |");
  });

  it("joins consecutive lines into one paragraph and skips rules", () => {
    const blocks = parseChatMarkdown("Line one\nLine two\n---\nAfter");
    expect(blocks).toHaveLength(2);
    if (blocks[0].type !== "paragraph") throw new Error("expected paragraph");
    expect(blocks[0].lines).toHaveLength(2);
  });

  it("returns nothing for an empty reply", () => {
    expect(parseChatMarkdown("   \n\n")).toEqual([]);
  });
});
