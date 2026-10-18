import { describe, expect, it } from "vitest";
import {
  extractPages,
  readReply,
  rotate,
  type CallVisionModel,
  type VisionReply,
} from "@/lib/menu-import/vision-core";

/**
 * Reading menu photos one per request, retrying a failed photo on a
 * different model first, and merging in photo order. From a real
 * two-photo import that failed on 2026-10-18 with "Couldn't read a menu
 * from that response" (src/lib/menu-import/vision-core.ts).
 */

const MODELS = ["dots", "super-vl", "nano-omni"];

const menu = (category: string, ...items: [string, number | null][]) =>
  JSON.stringify({
    categories: [
      {
        name: category,
        items: items.map(([name, price]) => ({ name, price })),
      },
    ],
  });

const ok = (content: string, servedModel = "dots"): VisionReply => ({
  status: 200,
  content,
  finishReason: "stop",
  servedModel,
});

/** A fake model: replies per photo, in order of calls for that photo. */
function fake(replies: Record<string, VisionReply[]>) {
  const calls: Array<{ photo: string; models: string[] }> = [];
  const call: CallVisionModel = async (photo, models) => {
    calls.push({ photo, models });
    const queue = replies[photo];
    return queue.shift() ?? { status: 500, content: "" };
  };
  return { call, calls };
}

describe("reading a reply", () => {
  it("treats a busy model's 200-with-an-error as a failure, not a menu", () => {
    // What OpenRouter actually sent: HTTP 200, an error in the body, no reply.
    const r = readReply({
      status: 200,
      content: "",
      bodyError:
        "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)",
    });
    expect(r).toMatchObject({ ok: false, busy: true });
  });

  it("names a reply cut off by the output allowance", () => {
    const cut = menu("STARTERS", ["Samosa", 4.99]).slice(0, 40);
    expect(
      readReply({ status: 200, content: cut, finishReason: "length" }),
    ).toMatchObject({ ok: false, error: "reply cut off", busy: false });
  });

  it("reads a good reply wrapped in prose", () => {
    const r = readReply(
      ok(`Here you go:\n${menu("STARTERS", ["Samosa", 4.99])}`),
    );
    expect(r).toMatchObject({ ok: true, model: "dots" });
  });
});

describe("rotate", () => {
  it("starts a retry from the next model", () => {
    expect(rotate(MODELS, 0)).toEqual(MODELS);
    expect(rotate(MODELS, 1)).toEqual(["super-vl", "nano-omni", "dots"]);
    expect(rotate([], 1)).toEqual([]);
  });
});

describe("extractPages", () => {
  it("reads each photo separately and merges them in photo order", async () => {
    const { call, calls } = fake({
      p1: [ok(menu("STARTERS", ["Samosa", 4.99], ["Bhaji", null]))],
      p2: [ok(menu("CURRIES", ["Butter Chicken", 14.99]), "super-vl")],
    });
    const out = await extractPages(["p1", "p2"], MODELS, call);
    expect(out.ok).toBe(true);
    expect(out.drafts.map((d) => `${d.categoryName}/${d.name}`)).toEqual([
      "STARTERS/Samosa",
      "STARTERS/Bhaji",
      "CURRIES/Butter Chicken",
    ]);
    expect(out.drafts.map((d) => d.displayOrder)).toEqual([0, 1, 2]);
    expect(out.unpricedCount).toBe(1);
    expect(out.model).toBe("dots, super-vl");
    expect(calls).toHaveLength(2);
  });

  it("retries a failed photo once, on a different model first", async () => {
    const { call, calls } = fake({
      p1: [
        { status: 200, content: "", bodyError: "ResourceExhausted" },
        ok(menu("STARTERS", ["Samosa", 4.99]), "super-vl"),
      ],
    });
    const out = await extractPages(["p1"], MODELS, call);
    expect(out.ok).toBe(true);
    expect(calls.map((c) => c.models[0])).toEqual(["dots", "super-vl"]);
  });

  it("drops a dish read twice across overlapping photos", async () => {
    const { call } = fake({
      p1: [ok(menu("STARTERS", ["Samosa", 4.99]))],
      p2: [ok(menu("STARTERS", ["Samosa", 4.99], ["Pakora", 5.5]))],
    });
    const out = await extractPages(["p1", "p2"], MODELS, call);
    expect(out.drafts.map((d) => d.name)).toEqual(["Samosa", "Pakora"]);
  });

  it("never invents a price for a dish read without one", async () => {
    const { call } = fake({
      p1: [ok(menu("SPECIALS", ["Market fish", null]))],
    });
    const out = await extractPages(["p1"], MODELS, call);
    expect(out.drafts[0].price).toBeNull();
  });

  it("names the photo that couldn't be read, and keeps nothing half-done", async () => {
    const { call } = fake({
      p1: [ok(menu("STARTERS", ["Samosa", 4.99]))],
      p2: [ok("I can't read this image."), ok("Still can't.")],
    });
    const out = await extractPages(["p1", "p2"], MODELS, call);
    expect(out).toMatchObject({ ok: false, drafts: [] });
    expect(out.error).toBe(
      "Couldn't read photo 2. Try again, or retake it closer and straight on, in good light.",
    );
  });

  it("says the reader is busy when every failure was a busy model", async () => {
    const busy: VisionReply = { status: 429, content: "" };
    const { call } = fake({ p1: [busy, busy] });
    const out = await extractPages(["p1"], MODELS, call);
    expect(out.error).toBe(
      "The menu reader is busy right now. Please try again in a minute.",
    );
  });

  it("says when a photo took too long", async () => {
    const slow: VisionReply = { status: 0, content: "", timedOut: true };
    const { call } = fake({ p1: [slow, slow] });
    const out = await extractPages(["p1"], MODELS, call);
    expect(out.error).toContain("took too long");
  });
});
