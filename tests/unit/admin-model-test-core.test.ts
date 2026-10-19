// The Admin page's model Test: what passes for each job, and which lists
// may be tested or saved at all (src/lib/admin/model-test-core.ts).
import { describe, expect, it } from "vitest";
import {
  allPassed,
  BOARD_ITEMS,
  formatCost,
  formatSeconds,
  gradeDraft,
  gradeStaff,
  gradeSuggestions,
  gradeVision,
  gradeWaiter,
  listProblem,
  sameModelList,
  sampleToolOutcome,
  SAMPLE_MENU,
  SUGGESTION_TEST_DISHES,
  DRAFT_TEST_FIELD,
} from "@/lib/admin/model-test-core";
import type { LoopToolOutcome } from "@/lib/ai/loop";

const searched: LoopToolOutcome = {
  toolName: "search_menu",
  result: { ok: true, data: {} },
};

describe("gradeWaiter", () => {
  const good = {
    toolOutcomes: [searched],
    finalText: "Try the Paneer Tikka or the Dal Makhani, both mild.",
    refused: false,
    guardCorrectionExhausted: false,
  };

  it("passes a reply that looked the menu up and names vegetarian dishes", () => {
    expect(allPassed(gradeWaiter(good))).toBe(true);
  });

  it("fails a reply that answered from memory", () => {
    expect(allPassed(gradeWaiter({ ...good, toolOutcomes: [] }))).toBe(false);
  });

  it("fails a reply that recommends meat for a vegetarian", () => {
    const checks = gradeWaiter({
      ...good,
      finalText: "The Paneer Tikka and the Lamb Biryani are great.",
    });
    expect(allPassed(checks)).toBe(false);
  });

  it("fails a reply that names no dish from the menu", () => {
    expect(
      allPassed(gradeWaiter({ ...good, finalText: "Try our veggie burger!" })),
    ).toBe(false);
  });

  it("fails a reply that leaks its instructions", () => {
    const checks = gradeWaiter({
      ...good,
      finalText: "My instructions say to call the tool. Paneer Tikka is mild.",
    });
    expect(checks.find((c) => !c.ok)?.label).toMatch(/instructions/);
  });

  it("fails a refusal or an exhausted guard", () => {
    expect(allPassed(gradeWaiter({ ...good, refused: true }))).toBe(false);
    expect(
      allPassed(gradeWaiter({ ...good, guardCorrectionExhausted: true })),
    ).toBe(false);
  });
});

describe("sampleToolOutcome", () => {
  it("serves the sample menu, filtered as the real search is", () => {
    const veg = sampleToolOutcome("search_menu", { dietary: "vegetarian" });
    const items = (veg.result.data as { items: { name: string }[] }).items;
    expect(items.length).toBe(SAMPLE_MENU.filter((d) => d.isVegetarian).length);
    expect(items.map((i) => i.name)).not.toContain("Lamb Biryani");
  });

  it("ignores search words that match no dish rather than returning nothing", () => {
    const r = sampleToolOutcome("search_menu", {
      dietary: "vegetarian",
      query: "not spicy",
    });
    expect(
      (r.result.data as { items: unknown[] }).items.length,
    ).toBeGreaterThan(0);
  });

  it("returns nothing vegan, because nothing on it is", () => {
    const r = sampleToolOutcome("search_menu", { dietary: "vegan" });
    expect((r.result.data as { items: unknown[] }).items).toEqual([]);
  });

  it("looks a dish up by id", () => {
    const r = sampleToolOutcome("get_menu_item", {
      menuItemId: SAMPLE_MENU[0].id,
    });
    expect(r.result.ok).toBe(true);
    expect(
      sampleToolOutcome("get_menu_item", { menuItemId: "nope" }).result.ok,
    ).toBe(false);
  });

  it("refuses anything that would change a cart or an order", () => {
    for (const tool of ["add_item_to_cart", "submit_order", "call_staff"]) {
      expect(sampleToolOutcome(tool, {}).result.ok).toBe(false);
    }
  });
});

describe("gradeStaff", () => {
  it("passes sold out for the right dish", () => {
    expect(
      allPassed(
        gradeStaff({
          kind: "sold_out",
          target: "Paneer Tikka",
          until: "next_opening",
        }),
      ),
    ).toBe(true);
  });

  it("fails the wrong command or the wrong dish", () => {
    expect(allPassed(gradeStaff({ kind: "unknown" }))).toBe(false);
    expect(
      allPassed(
        gradeStaff({ kind: "sold_out", target: "samosa", until: "manual" }),
      ),
    ).toBe(false);
  });
});

describe("gradeVision", () => {
  const drafts = BOARD_ITEMS.map(([name, price]) => ({
    name,
    price,
    category: "Menu",
    description: null,
  }));
  const outcome = (d: typeof drafts) => ({
    ok: true,
    drafts: d,
    unpricedCount: 0,
  });

  it("passes every price read and none invented", () => {
    expect(allPassed(gradeVision(outcome(drafts) as never))).toBe(true);
  });

  it("allows one price missed", () => {
    const one = drafts.map((d, i) => (i === 0 ? { ...d, price: 1 } : d));
    expect(allPassed(gradeVision(outcome(one) as never))).toBe(true);
  });

  it("fails two prices missed", () => {
    const two = drafts.map((d, i) => (i < 2 ? { ...d, price: 1 } : d));
    expect(allPassed(gradeVision(outcome(two) as never))).toBe(false);
  });

  it("fails a price invented for the ask-at-counter line", () => {
    const trap = [
      ...drafts,
      {
        name: "Market price today",
        price: 20,
        category: "Menu",
        description: null,
      },
    ];
    expect(allPassed(gradeVision(outcome(trap) as never))).toBe(false);
  });

  it("fails an unreadable reply", () => {
    expect(
      allPassed(
        gradeVision({ ok: false, drafts: [], unpricedCount: 0 } as never),
      ),
    ).toBe(false);
  });
});

describe("gradeSuggestions", () => {
  const suggestion = (name: string) => ({
    name,
    ingredients: ["rice"],
    allergens: ["Milk"],
    description: null,
    prepTimeMinutes: null,
    portionNote: null,
    spiceLevel: null,
  });

  it("passes all five dishes with ingredients", () => {
    expect(
      allPassed(
        gradeSuggestions({
          ok: true,
          suggestions: SUGGESTION_TEST_DISHES.map(suggestion),
        }),
      ),
    ).toBe(true);
  });

  it("fails a missing dish", () => {
    expect(
      allPassed(
        gradeSuggestions({
          ok: true,
          suggestions: SUGGESTION_TEST_DISHES.slice(1).map(suggestion),
        }),
      ),
    ).toBe(false);
  });
});

describe("gradeDraft", () => {
  it("passes a translation and fails an echo or nothing", () => {
    expect(
      allPassed(gradeDraft(new Map([["d1", "Cubos de queso fresco"]]))),
    ).toBe(true);
    expect(
      allPassed(gradeDraft(new Map([["d1", DRAFT_TEST_FIELD.text]]))),
    ).toBe(false);
    expect(allPassed(gradeDraft(new Map()))).toBe(false);
  });
});

describe("listProblem", () => {
  const known = new Set([
    "a/paid",
    "a/free:free",
    "b/free:free",
    "openrouter/free",
  ]);
  const base = { provider: "openrouter", known };

  it("accepts one to three known models", () => {
    expect(
      listProblem({ ...base, job: "waiter", models: ["a/paid"] }),
    ).toBeNull();
    expect(
      listProblem({
        ...base,
        job: "waiter",
        models: ["a/paid", "a/free:free", "b/free:free"],
      }),
    ).toBeNull();
  });

  it("refuses an empty, repeated or too-long list", () => {
    expect(listProblem({ ...base, job: "waiter", models: [] })).toMatch(/main/);
    expect(
      listProblem({ ...base, job: "waiter", models: ["a/paid", " a/paid "] }),
    ).toMatch(/twice/);
    expect(
      listProblem({
        ...base,
        job: "waiter",
        models: ["a/paid", "a/free:free", "b/free:free", "c"],
      }),
    ).toMatch(/three/);
  });

  it("refuses a paid model for a free-only job", () => {
    expect(
      listProblem({
        ...base,
        job: "drafts",
        models: ["a/free:free", "a/paid"],
      }),
    ).toMatch(/only uses free models/);
    expect(
      listProblem({ ...base, job: "suggestions", models: ["a/free:free"] }),
    ).toBeNull();
  });

  it("refuses a name OpenRouter doesn't list, or when the list is unknown", () => {
    expect(
      listProblem({ ...base, job: "vision", models: ["typo/model"] }),
    ).toMatch(/doesn't list typo\/model/);
    expect(
      listProblem({ ...base, known: null, job: "vision", models: ["a/paid"] }),
    ).toMatch(/Couldn't check/);
  });

  it("refuses the any-free-model alias", () => {
    expect(
      listProblem({ ...base, job: "drafts", models: ["openrouter/free"] }),
    ).toMatch(/different model each time/);
  });

  it("leaves the waiter to Vercel when it runs on Anthropic", () => {
    expect(
      listProblem({
        ...base,
        provider: "anthropic",
        job: "waiter",
        models: ["a/paid"],
      }),
    ).toMatch(/Anthropic/);
  });
});

describe("formatting", () => {
  it("shows cost as free, cents or dollars", () => {
    expect(formatCost(0)).toBe("free");
    expect(formatCost(null)).toBe("cost unknown");
    expect(formatCost(0.008)).toBe("0.8¢");
    expect(formatCost(0.00042)).toBe("0.04¢");
    expect(formatCost(1.2)).toBe("$1.20");
  });

  it("shows time in seconds", () => {
    expect(formatSeconds(3140)).toBe("3.1 s");
  });

  it("compares lists in order", () => {
    expect(sameModelList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameModelList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameModelList(["a"], ["a", "b"])).toBe(false);
  });
});
