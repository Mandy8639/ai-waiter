import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMenuGraph } from "@/lib/menu-graph/core";

// add_item_to_cart's side of the allergy hold: the real tool, with the
// database and the cart stubbed. The rule itself is in
// ai-allergy-hold.test.ts.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/cart/get-cart", () => ({ getCart: vi.fn() }));

const addToCart = vi.fn();
vi.mock("@/lib/cart/actions", () => ({
  addToCart: (...args: unknown[]) => addToCart(...args),
  updateCartItemQuantity: vi.fn(),
  removeCartItem: vi.fn(),
  clearCart: vi.fn(),
}));

const db = vi.hoisted(() => ({
  userMessages: [] as string[],
  lastReply: null as string | null,
  earlierCalls: [] as { content: string; createdAt: string }[],
  menuLoads: 0,
}));
vi.mock("@/lib/ai/conversation", () => ({
  getUserMessages: async () => db.userMessages,
  getLatestAssistantMessage: async () => db.lastReply,
  getLatestUserMessageTimestamp: async () => "2026-10-30T12:00:00Z",
  getSuccessfulToolCalls: async () => db.earlierCalls,
}));

const graph = buildMenuGraph({
  currency: "USD",
  sections: [{ id: "mains", name: "Mains" }],
  dishes: [
    {
      id: "butter",
      name: "Butter Chicken",
      price: 15,
      sectionId: "mains",
      isVegetarian: false,
      isVegan: false,
      isHalal: false,
      isKosher: false,
      isSpicy: false,
      containsNuts: false,
      containsDairy: true,
      containsGluten: false,
    },
  ],
  ingredients: [],
  allergens: [],
  pairings: [],
});
vi.mock("@/lib/menu-graph/load", () => ({
  loadMenuGraph: async () => {
    db.menuLoads += 1;
    return { graph, currency: "USD" };
  },
}));

const { cartTools } = await import("@/lib/ai/tools/cart");
const tool = cartTools.find((t) => t.name === "add_item_to_cart")!;
const context = {
  restaurantId: "r1",
  restaurantSlug: "r",
  customerSessionId: "s1",
  turnIdempotencyKey: "k",
};
const add = (extra: object = {}) =>
  tool.execute(
    { menuItemId: "butter", quantity: 1, selectedOptionIds: [], ...extra },
    context,
  );

beforeEach(() => {
  addToCart.mockReset();
  addToCart.mockResolvedValue({ success: true });
  db.userMessages = [];
  db.lastReply = null;
  db.earlierCalls = [];
  db.menuLoads = 0;
});

describe("add_item_to_cart with a stated allergy", () => {
  it("doesn't touch the cart, and says so", async () => {
    db.userMessages = ["I'm allergic to dairy", "butter chicken please"];
    const result = await add();
    expect(addToCart).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      data: { added: false, heldForAllergy: true, dish: "Butter Chicken" },
    });
  });

  it("can't be talked past on the first try", async () => {
    db.userMessages = ["I'm allergic to dairy", "butter chicken please"];
    await add({ guestAcceptedAllergyRisk: true });
    expect(addToCart).not.toHaveBeenCalled();
  });

  it("adds it after the guest was told and said yes", async () => {
    db.userMessages = ["I'm allergic to dairy", "yes, add it anyway"];
    db.lastReply = "The Butter Chicken contains dairy. Still want it?";
    await add({ guestAcceptedAllergyRisk: true });
    expect(addToCart).toHaveBeenCalledOnce();
  });

  it("costs a guest with no allergy no menu read", async () => {
    db.userMessages = ["butter chicken please"];
    await add();
    expect(db.menuLoads).toBe(0);
    expect(addToCart).toHaveBeenCalledOnce();
  });
});
