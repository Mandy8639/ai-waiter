import { describe, expect, it } from "vitest";
import { buildHistoryMessages, buildRecentToolContext } from "@/lib/ai/history";
import type { ConversationMessage } from "@/lib/ai/conversation";

function msg(partial: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: partial.id ?? "id",
    role: partial.role ?? "user",
    content: partial.content ?? "",
    toolName: partial.toolName ?? null,
    toolSuccess: partial.toolSuccess ?? null,
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("buildHistoryMessages", () => {
  it("keeps only user/assistant rows, in order", () => {
    const history: ConversationMessage[] = [
      msg({ role: "user", content: "hi" }),
      msg({
        role: "tool",
        content: "{}",
        toolName: "search_menu",
        toolSuccess: true,
      }),
      msg({ role: "assistant", content: "hello" }),
    ];

    expect(buildHistoryMessages(history)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("returns an empty array for an all-tool history", () => {
    const history: ConversationMessage[] = [
      msg({
        role: "tool",
        content: "{}",
        toolName: "search_menu",
        toolSuccess: true,
      }),
    ];
    expect(buildHistoryMessages(history)).toEqual([]);
  });
});

describe("buildRecentToolContext", () => {
  it("returns undefined when there are no tool rows", () => {
    const history: ConversationMessage[] = [
      msg({ role: "user", content: "hi" }),
      msg({ role: "assistant", content: "hello" }),
    ];
    expect(buildRecentToolContext(history)).toBeUndefined();
  });

  it("returns undefined when the only tool rows failed", () => {
    const history: ConversationMessage[] = [
      msg({
        role: "tool",
        content: '{"ok":false,"error":"nope"}',
        toolName: "get_menu_item",
        toolSuccess: false,
      }),
    ];
    expect(buildRecentToolContext(history)).toBeUndefined();
  });

  it("includes a successful tool call's name and content", () => {
    const history: ConversationMessage[] = [
      msg({
        role: "tool",
        content: '{"ok":true,"data":{"items":[]}}',
        toolName: "search_menu",
        toolSuccess: true,
      }),
    ];
    const result = buildRecentToolContext(history);
    expect(result).toContain("search_menu");
    expect(result).toContain('{"ok":true,"data":{"items":[]}}');
  });

  it("excludes failed calls while including successful ones", () => {
    const history: ConversationMessage[] = [
      msg({
        role: "tool",
        content: '{"ok":false,"error":"not found"}',
        toolName: "get_menu_item",
        toolSuccess: false,
      }),
      msg({
        role: "tool",
        content: '{"ok":true,"data":{"id":"abc"}}',
        toolName: "get_menu_item",
        toolSuccess: true,
      }),
    ];
    const result = buildRecentToolContext(history);
    expect(result).not.toContain("not found");
    expect(result).toContain('{"ok":true,"data":{"id":"abc"}}');
  });

  it("keeps only the trailing window (most recent 3), oldest-of-the-window first", () => {
    const history: ConversationMessage[] = [
      msg({
        role: "tool",
        content: "first",
        toolName: "search_menu",
        toolSuccess: true,
      }),
      msg({
        role: "tool",
        content: "second",
        toolName: "search_menu",
        toolSuccess: true,
      }),
      msg({
        role: "tool",
        content: "third",
        toolName: "search_menu",
        toolSuccess: true,
      }),
      msg({
        role: "tool",
        content: "fourth",
        toolName: "search_menu",
        toolSuccess: true,
      }),
    ];
    const result = buildRecentToolContext(history) ?? "";
    expect(result).not.toContain("first");
    expect(result).toContain("second");
    expect(result).toContain("third");
    expect(result).toContain("fourth");
    // oldest-of-the-window (second) appears before the newest (fourth)
    expect(result.indexOf("second")).toBeLessThan(result.indexOf("fourth"));
  });

  it("Turn 1 -> Turn 2 -> Turn 3: the modifier information discovered in Turn 2's get_menu_item call is present when building Turn 3's context", () => {
    // Mirrors the exact live conversation shape captured in the Phase 2A
    // Turn-3 investigation: Turn 1 asks about vegetarian dishes
    // (search_menu), Turn 2 asks for the item (get_menu_item, discovering
    // its required "Spice level" modifier group), Turn 3 answers "Medium
    // please" — this is the turn that previously lost the modifier data.
    const history: ConversationMessage[] = [
      // Turn 1
      msg({ role: "user", content: "What vegetarian dishes do you have?" }),
      msg({
        role: "tool",
        toolName: "search_menu",
        toolSuccess: true,
        content:
          '{"ok":true,"data":{"items":[{"id":"item-1","name":"Paneer Dosa","price":9.5}]}}',
      }),
      msg({
        role: "assistant",
        content: "We have one vegetarian dish: Paneer Dosa — $9.50.",
      }),
      // Turn 2
      msg({ role: "user", content: "I'll have the Paneer Dosa" }),
      msg({
        role: "tool",
        toolName: "get_menu_item",
        toolSuccess: true,
        content:
          '{"ok":true,"data":{"id":"item-1","name":"Paneer Dosa","modifierGroups":[{"name":"Spice level","isRequired":true,"options":[{"name":"Medium"}]}]}}',
      }),
      msg({
        role: "assistant",
        content:
          "The Paneer Dosa requires a spice-level selection. The only option is Medium. Would you like that?",
      }),
      // Turn 3's own new user message is NOT part of history — it's
      // passed separately as the turn's userMessage, same as production.
    ];

    const recentToolContext = buildRecentToolContext(history);
    expect(recentToolContext).toBeDefined();
    expect(recentToolContext).toContain("get_menu_item");
    expect(recentToolContext).toContain("Spice level");
    expect(recentToolContext).toContain("Medium");

    // And the plain history array still only carries user/assistant text
    // (buildHistoryMessages's return type itself guarantees no "tool" role
    // can appear) — the tool result is surfaced exclusively via
    // recentToolContext.
    const historyMessages = buildHistoryMessages(history);
    expect(historyMessages).toHaveLength(4);
  });
});
