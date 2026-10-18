import { describe, expect, it } from "vitest";
import {
  normalizeName,
  resolveTarget,
  type Catalog,
} from "@/lib/staff-assistant/resolve-core";
import {
  doneText,
  planAction,
  planIntent,
  replyForPlan,
  statusText,
  undoFor,
  type PlanContext,
} from "@/lib/staff-assistant/plan-core";
import {
  executeAction,
  type AssistantDb,
} from "@/lib/staff-assistant/execute-core";
import { parseInterpretation } from "@/lib/staff-assistant/interpret-core";
import type { StaffAction } from "@/lib/staff-assistant/intent";

/**
 * The staff assistant after the command is read: finding the dish, never
 * guessing between several, asking before prices and anything the model
 * read, the role lines, what's said afterwards and how it's undone.
 */

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const catalog: Catalog = {
  dishes: [
    {
      id: id(1),
      name: "Grilled Salmon",
      price: 18,
      available: true,
      backAt: null,
    },
    {
      id: id(2),
      name: "Salmon Tikka",
      price: 16,
      available: true,
      backAt: null,
    },
    { id: id(3), name: "Mango Lassi", price: 5, available: true, backAt: null },
    {
      id: id(4),
      name: "Garlic Naan",
      price: 3,
      available: false,
      backAt: null,
    },
    {
      id: id(5),
      name: "Masala Chai",
      price: 2.5,
      available: true,
      backAt: null,
    },
  ],
  options: [
    {
      id: id(11),
      name: "Oat milk",
      groupName: "Milk",
      dishName: "Masala Chai",
      available: true,
    },
    {
      id: id(12),
      name: "Oat Milk",
      groupName: "Milk",
      dishName: "Latte",
      available: true,
    },
    {
      id: id(13),
      name: "Extra naan",
      groupName: "Sides",
      dishName: "Butter Chicken",
      available: true,
    },
  ],
};

const NY = "America/New_York";
const now = new Date("2026-11-04T01:00:00Z"); // 8pm Tuesday in New York

const ctx = (patch: Partial<PlanContext> = {}): PlanContext => ({
  catalog,
  role: "kitchen",
  state: { pausedUntil: null, busyExtraMinutes: 0 },
  source: "rules",
  timeZone: NY,
  now,
  ...patch,
});

describe("finding the dish", () => {
  it("normalises names for matching", () => {
    expect(normalizeName("The Samosas!")).toBe("samosa");
    expect(normalizeName("Mac & Cheese")).toBe("mac and cheese");
  });

  it("uses an exact name over partial ones", () => {
    const r = resolveTarget(catalog, "mango lassi");
    expect(r).toMatchObject({
      type: "one",
      match: { type: "dish", dish: { id: id(3) } },
    });
  });

  it("treats every add-on with one name as one thing", () => {
    const r = resolveTarget(catalog, "oat milk");
    expect(r.type).toBe("one");
    if (r.type === "one" && r.match.type === "options") {
      expect(r.match.options.map((o) => o.id)).toEqual([id(11), id(12)]);
    }
  });

  it("asks when a name matches several dishes", () => {
    const r = resolveTarget(catalog, "salmon");
    expect(r.type).toBe("several");
  });

  it("finds nothing rather than something close", () => {
    expect(resolveTarget(catalog, "lobster").type).toBe("none");
    expect(resolveTarget(catalog, "").type).toBe("none");
  });

  it("never matches an add-on for a price", () => {
    expect(resolveTarget(catalog, "oat milk", { dishesOnly: true }).type).toBe(
      "none",
    );
  });
});

describe("planning", () => {
  it("86 runs straight away, until the next opening", () => {
    expect(
      planIntent(
        { kind: "sold_out", target: "mango lassi", until: "next_opening" },
        ctx(),
      ),
    ).toEqual({
      type: "run",
      action: { kind: "dish_sold_out", dishId: id(3), until: "next_opening" },
    });
  });

  it("an ambiguous name asks which, and changes nothing", () => {
    const plan = planIntent(
      { kind: "sold_out", target: "salmon", until: "next_opening" },
      ctx(),
    );
    expect(plan.type).toBe("choose");
    if (plan.type !== "choose") return;
    expect(plan.text).toContain("Nothing has been changed yet");
    expect(plan.buttons.map((b) => b.label)).toEqual([
      "Grilled Salmon",
      "Salmon Tikka",
    ]);
    expect(plan.buttons.every((b) => !b.confirmed)).toBe(true);
  });

  it("narrows an ambiguous name to what the command would change", () => {
    const withOneOff: Catalog = {
      ...catalog,
      dishes: catalog.dishes.map((d) =>
        d.id === id(2) ? { ...d, available: false } : d,
      ),
    };
    expect(
      planIntent(
        { kind: "back", target: "salmon" },
        ctx({ catalog: withOneOff }),
      ),
    ).toEqual({
      type: "run",
      action: { kind: "dish_back", dishId: id(2) },
    });
  });

  it("a price change always asks first, and only owners and managers may", () => {
    const intent = {
      kind: "set_price" as const,
      target: "mango lassi",
      price: 5.5,
    };
    expect(planIntent(intent, ctx()).type).toBe("refused");
    const plan = planIntent(intent, ctx({ role: "manager" }));
    expect(plan).toMatchObject({
      type: "confirm",
      text: "Change Mango Lassi from $5.00 to $5.50?",
    });
    expect(
      planAction(
        { kind: "set_price", dishId: id(3), price: 5.5 },
        ctx({ role: "manager" }),
        {
          confirmed: true,
        },
      ).type,
    ).toBe("run");
    // A forged "yes" from the kitchen is still refused.
    expect(
      planAction({ kind: "set_price", dishId: id(3), price: 5.5 }, ctx(), {
        confirmed: true,
      }).type,
    ).toBe("refused");
  });

  it("anything the model read asks first", () => {
    const plan = planIntent(
      { kind: "sold_out", target: "mango lassi", until: "next_opening" },
      ctx({ source: "ai" }),
    );
    expect(plan).toMatchObject({
      type: "confirm",
      text: "I think you want me to mark Mango Lassi sold out until you next open. Should I?",
    });
  });

  it("front-of-house staff can't use it", () => {
    expect(
      planIntent({ kind: "pause", minutes: 60 }, ctx({ role: "staff" })).type,
    ).toBe("refused");
  });

  it("refuses ids that aren't on this restaurant's menu", () => {
    expect(
      planAction({ kind: "dish_back", dishId: id(99) }, ctx(), {
        confirmed: true,
      }).type,
    ).toBe("not_found");
  });

  it("keeps pauses and waits inside what the kitchen board allows", () => {
    expect(planIntent({ kind: "pause", minutes: 60 }, ctx())).toEqual({
      type: "run",
      action: { kind: "pause", minutes: 60 },
    });
    expect(planIntent({ kind: "pause", minutes: 2 }, ctx()).type).toBe(
      "refused",
    );
    expect(planIntent({ kind: "busy", extraMinutes: 200 }, ctx()).type).toBe(
      "refused",
    );
  });

  it("doesn't resume what isn't paused, or clear a wait that isn't on", () => {
    expect(planIntent({ kind: "resume" }, ctx()).type).toBe("answered");
    expect(planIntent({ kind: "busy_off" }, ctx()).type).toBe("answered");
  });

  it("says when a price is already right", () => {
    expect(
      planIntent(
        { kind: "set_price", target: "mango lassi", price: 5 },
        ctx({ role: "owner" }),
      ),
    ).toMatchObject({ type: "answered" });
  });
});

describe("after a change", () => {
  it("says when a dish comes back, in the restaurant's time", () => {
    expect(
      doneText(
        { kind: "dish_sold_out", dishId: id(3), until: "next_opening" },
        catalog,
        { backAt: "2026-11-04T16:00:00Z" },
        NY,
        now,
      ),
    ).toBe("Done: Mango Lassi is sold out. Back tomorrow 11:00 AM, by itself.");
  });

  it("says when a pause ends", () => {
    expect(
      doneText(
        { kind: "pause", minutes: 60 },
        catalog,
        { pausedUntil: "2026-11-04T02:00:00Z" },
        NY,
        now,
      ),
    ).toBe(
      "Done: new orders are paused until 9:00 PM. They start again by themselves.",
    );
  });

  it("offers an undo that puts things back as they were", () => {
    const before = {
      catalog,
      state: { pausedUntil: null, busyExtraMinutes: 10 },
    };
    const undo = (a: StaffAction) => undoFor(a, before, now)?.action;
    expect(
      undo({ kind: "dish_sold_out", dishId: id(3), until: "next_opening" }),
    ).toEqual({
      kind: "dish_back",
      dishId: id(3),
    });
    expect(undo({ kind: "dish_back", dishId: id(4) })).toEqual({
      kind: "dish_sold_out",
      dishId: id(4),
      until: "manual",
    });
    expect(undo({ kind: "pause", minutes: 60 })).toEqual({ kind: "resume" });
    expect(undo({ kind: "busy", extraMinutes: 20 })).toEqual({
      kind: "busy",
      extraMinutes: 10,
    });
    expect(undo({ kind: "set_price", dishId: id(3), price: 6 })).toEqual({
      kind: "set_price",
      dishId: id(3),
      price: 5,
    });
    expect(
      undoFor({ kind: "set_price", dishId: id(3), price: 6 }, before, now)
        ?.confirmed,
    ).toBe(true);
  });

  it("an undo of a resume restores the pause that was there", () => {
    const before = {
      catalog,
      state: { pausedUntil: "2026-11-04T01:40:00Z", busyExtraMinutes: 0 },
    };
    expect(undoFor({ kind: "resume" }, before, now)?.action).toEqual({
      kind: "pause",
      minutes: 40,
    });
  });
});

describe("replies", () => {
  it("a question can be cancelled; a yes carries the action, confirmed", () => {
    const reply = replyForPlan({
      type: "confirm",
      text: "Change it?",
      action: { kind: "set_price", dishId: id(3), price: 6 },
    });
    expect(reply.cancellable).toBe(true);
    expect(reply.buttons).toEqual([
      expect.objectContaining({ label: "Yes, change it", confirmed: true }),
    ]);
  });

  it("lists what's sold out and whether ordering is paused", () => {
    const text = statusText(
      ctx({
        state: { pausedUntil: "infinity", busyExtraMinutes: 15 },
        catalog: {
          ...catalog,
          dishes: catalog.dishes.map((d) =>
            d.id === id(3)
              ? { ...d, available: false, backAt: "2026-11-04T16:00:00Z" }
              : d,
          ),
          options: catalog.options.map((o) => ({
            ...o,
            available: o.name.toLowerCase() !== "oat milk",
          })),
        },
      }),
    );
    expect(text).toContain("New orders are paused until someone resumes them.");
    expect(text).toContain("15 minutes longer");
    expect(text).toContain("• Mango Lassi — back tomorrow 11:00 am");
    expect(text).toContain("• Garlic Naan");
    expect(text).toContain("Oat milk (on 2 dishes)");
  });
});

describe("running an action", () => {
  function fakeDb(fail: string[] = [], priceRows = true) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const db: AssistantDb = {
      async rpc(fn, args) {
        calls.push({ fn, args });
        if (fail.includes(fn))
          return { data: null, error: { message: "denied" } };
        if (fn === "set_menu_item_sold_out_until_next_opening") {
          return { data: "2026-11-04T16:00:00+00:00", error: null };
        }
        if (fn === "pause_new_orders") return { data: "infinity", error: null };
        return { data: null, error: null };
      },
      async updateDishPrice(_r, dishId) {
        calls.push({ fn: "price", args: { dishId } });
        return { updatedIds: priceRows ? [dishId] : [], error: null };
      },
    };
    return { db, calls };
  }

  it("uses the dashboard's own functions", async () => {
    const { db, calls } = fakeDb();
    const out = await executeAction(db, "r1", {
      kind: "dish_sold_out",
      dishId: id(3),
      until: "next_opening",
    });
    expect(out).toMatchObject({
      ok: true,
      result: { backAt: "2026-11-04T16:00:00.000Z" },
    });
    expect(calls).toEqual([
      {
        fn: "set_menu_item_sold_out_until_next_opening",
        args: { p_menu_item_id: id(3) },
      },
    ]);

    await executeAction(db, "r1", {
      kind: "options_sold_out",
      optionIds: [id(11), id(12)],
    });
    expect(
      calls.filter((c) => c.fn === "set_modifier_option_availability"),
    ).toHaveLength(2);

    const paused = await executeAction(db, "r1", {
      kind: "pause",
      minutes: null,
    });
    expect(paused).toMatchObject({
      ok: true,
      result: { pausedUntil: "infinity" },
    });
  });

  it("never reports a change the database refused", async () => {
    const { db } = fakeDb(["set_menu_item_availability"]);
    const out = await executeAction(db, "r1", {
      kind: "dish_back",
      dishId: id(4),
    });
    expect(out.ok).toBe(false);
    expect(out.calls).toEqual([
      expect.objectContaining({
        fn: "set_menu_item_availability",
        ok: false,
        error: "denied",
      }),
    ]);
  });

  it("treats a price update RLS quietly refused as a failure", async () => {
    const { db } = fakeDb([], false);
    const out = await executeAction(db, "r1", {
      kind: "set_price",
      dishId: id(3),
      price: 6,
    });
    expect(out.ok).toBe(false);
    expect(out.calls[0]).toMatchObject({ ok: false });
  });

  it("says how far it got when one add-on fails partway", async () => {
    let n = 0;
    const db: AssistantDb = {
      async rpc() {
        n += 1;
        return n === 2
          ? { data: null, error: { message: "boom" } }
          : { data: null, error: null };
      },
      async updateDishPrice() {
        return { updatedIds: [], error: null };
      },
    };
    const out = await executeAction(db, "r1", {
      kind: "options_back",
      optionIds: [id(11), id(12), id(13)],
    });
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.error).toContain("Only 1 of 3");
  });
});

describe("the model's reading", () => {
  it("accepts one command in the agreed shape", () => {
    expect(
      parseInterpretation(
        'Sure! {"kind":"sold_out","target":"salmon","until":"next_opening"}',
      ),
    ).toEqual({ kind: "sold_out", target: "salmon", until: "next_opening" });
  });

  it("reads anything else as not understood", () => {
    for (const raw of [
      null,
      "",
      "I paused it for you!",
      '{"kind":"delete_dish","target":"salmon"}',
      '{"kind":"set_price","target":"lassi","price":-4}',
      '{"kind":"pause","minutes":"lots"}',
    ]) {
      expect(parseInterpretation(raw)).toEqual({ kind: "unknown" });
    }
  });
});
