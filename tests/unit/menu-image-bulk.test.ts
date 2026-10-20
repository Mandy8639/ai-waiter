import { describe, expect, it, vi } from "vitest";
import {
  BULK_BATCH_SIZE,
  chunk,
  pickBulkTargets,
  runBatch,
  type DishResult,
} from "@/lib/menu-images/bulk-core";

/**
 * "Generate for all dishes" on the Menu photos page: which dishes are
 * asked for, and when a run stops.
 */

describe("pickBulkTargets", () => {
  it("takes only dishes with no photo, nothing waiting, and a name", () => {
    expect(
      pickBulkTargets([
        { id: "a", name: "Dal", activeImageId: null, hasPendingImage: false },
        { id: "b", name: "Naan", activeImageId: "img", hasPendingImage: false },
        { id: "c", name: "Chai", activeImageId: null, hasPendingImage: true },
        { id: "d", name: "  ", activeImageId: null, hasPendingImage: false },
        {
          id: "e",
          name: "Biryani",
          activeImageId: null,
          hasPendingImage: false,
        },
      ]),
    ).toEqual(["a", "e"]);
  });
});

describe("runBatch", () => {
  const ok = (id: string): DishResult => ({ ok: true, imageId: `img-${id}` });

  it("generates the batch in parallel and carries on", async () => {
    let running = 0;
    let peak = 0;
    const one = vi.fn(async (id: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return ok(id);
    });
    const r = await runBatch(["1", "2", "3"], one);
    expect(r).toEqual({ generated: 3, failed: 0, stop: null, message: null });
    expect(peak).toBe(3);
  });

  it("never runs more than one batch's worth, whatever it is given", async () => {
    const one = vi.fn(async (id: string) => ok(id));
    const ids = Array.from({ length: BULK_BATCH_SIZE + 3 }, (_, i) => `${i}`);
    await runBatch(ids, one);
    expect(one).toHaveBeenCalledTimes(BULK_BATCH_SIZE);
  });

  it("counts a single dish's failure and keeps going", async () => {
    const r = await runBatch(["1", "2"], async (id) =>
      id === "2"
        ? { ok: false, error: "This dish has used all…", kind: "dish" }
        : ok(id),
    );
    expect(r).toEqual({
      generated: 1,
      failed: 1,
      stop: null,
      message: "This dish has used all…",
    });
  });

  it("stops on the restaurant's daily limit, with its sentence", async () => {
    const r = await runBatch(["1", "2"], async (id) =>
      id === "2"
        ? {
            ok: false,
            error: "This restaurant has used all of today's…",
            kind: "restaurant_limit",
          }
        : ok(id),
    );
    expect(r.stop).toBe("restaurant_limit");
    expect(r.message).toBe("This restaurant has used all of today's…");
    expect(r.generated).toBe(1);
  });

  it("stops when the generator is unavailable", async () => {
    const r = await runBatch(["1"], async () => ({
      ok: false,
      error: "AI image generation is temporarily unavailable.",
      kind: "unavailable",
    }));
    expect(r.stop).toBe("unavailable");
  });

  it("treats a thrown error as one dish failing, not the run", async () => {
    const r = await runBatch(["1", "2"], async (id) => {
      if (id === "1") throw new Error("boom");
      return ok(id);
    });
    expect(r).toMatchObject({ generated: 1, failed: 1, stop: null });
  });
});

describe("chunk", () => {
  it("splits into pieces of at most the given size", () => {
    expect(chunk([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ]);
    expect(chunk([], 3)).toEqual([]);
  });
});
