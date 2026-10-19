// "Confirm all reviewed" for nutrition confirms a dish only if its saved
// numbers still match the ones the reviewer marked.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const rpc = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/restaurants/authorize", () => ({
  authorizeRestaurantAction: async () => ({
    ok: true,
    context: { supabase: { rpc } },
  }),
}));

const drafts = new Map<
  string,
  { calories: number; proteinG: number; carbsG: number; fatG: number }
>();
vi.mock("@/lib/nutrition/queries", () => ({
  getDraftNutrition: async () => drafts,
}));

import { confirmReviewedNutrition } from "@/lib/review/actions";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

afterEach(() => {
  vi.clearAllMocks();
  drafts.clear();
});

describe("confirmReviewedNutrition", () => {
  it("confirms unchanged drafts and leaves changed or vanished ones", async () => {
    drafts.set(A, { calories: 200, proteinG: 15, carbsG: 8, fatG: 11 });
    drafts.set(B, { calories: 260, proteinG: 10, carbsG: 30, fatG: 8 });
    // C is no longer a draft (confirmed or removed elsewhere).

    const result = await confirmReviewedNutrition("r1", [
      { itemId: A, signature: "200|15|8|11" },
      { itemId: B, signature: "250|10|30|8" },
      { itemId: C, signature: "100|1|1|1" },
    ]);

    expect(result).toEqual({
      confirmedIds: [A],
      changedIds: [B],
      error: undefined,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("confirm_menu_item_nutrition", {
      p_menu_item_id: A,
    });
  });

  it("refuses a malformed request without confirming anything", async () => {
    const result = await confirmReviewedNutrition("r1", [
      { itemId: "not-a-uuid", signature: "1|1|1|1" },
    ]);
    expect(result.error).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
});
