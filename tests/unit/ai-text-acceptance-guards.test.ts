import { describe, it, expect } from "vitest";
import {
  buildTextAcceptanceGuards,
  MENU_FACT_GUARD_ID,
  ALLERGY_HOLD_GUARD_ID,
  CART_STATE_GUARD_ID,
  MENU_CLAIM_GUARD_ID,
} from "@/lib/ai/providers/text-acceptance-guards";

const appendUserMessage = (messages: string[], text: string) => [
  ...messages,
  text,
];

describe("buildTextAcceptanceGuards", () => {
  it("always includes the cart-state and menu-claim guards — both gate themselves on the model's reply, not on a per-turn flag", () => {
    const guards = buildTextAcceptanceGuards({ appendUserMessage });
    expect(guards.map((g) => g.id)).toEqual([
      ALLERGY_HOLD_GUARD_ID,
      CART_STATE_GUARD_ID,
      MENU_CLAIM_GUARD_ID,
    ]);
  });

  it("adds the menu guard only when the customer's message asked for restaurant facts", () => {
    const guards = buildTextAcceptanceGuards({
      requiresAuthoritativeMenuSource: true,
      appendUserMessage,
    });
    // Order matters: the first guard to reject owns the one corrective
    // round. The cart guard sits before the menu-claim guard so a cart
    // total gets the more specific instruction (read the cart).
    expect(guards.map((g) => g.id)).toEqual([
      ALLERGY_HOLD_GUARD_ID,
      MENU_FACT_GUARD_ID,
      CART_STATE_GUARD_ID,
      MENU_CLAIM_GUARD_ID,
    ]);
  });

  it("gives every guard the caller's own appendUserMessage — the one provider-specific piece", () => {
    const guards = buildTextAcceptanceGuards({
      requiresAuthoritativeMenuSource: true,
      appendUserMessage,
    });
    for (const guard of guards) {
      expect(guard.appendUserMessage).toBe(appendUserMessage);
      expect(guard.correctiveInstruction.length).toBeGreaterThan(0);
    }
  });

  it("wires the cart guard to reject an unbacked cart-state claim", () => {
    const cartGuard = buildTextAcceptanceGuards({ appendUserMessage }).find(
      (g) => g.id === CART_STATE_GUARD_ID,
    )!;
    expect(
      cartGuard.shouldAccept(
        [{ toolName: "add_item_to_cart", result: { ok: true, data: {} } }],
        "You now have two dosas in your order.",
      ),
    ).toBe(false);
    expect(
      cartGuard.shouldAccept(
        [{ toolName: "get_cart", result: { ok: true, data: {} } }],
        "You now have two dosas in your order.",
      ),
    ).toBe(true);
  });
});
