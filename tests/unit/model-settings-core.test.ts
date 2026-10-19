import { describe, expect, it } from "vitest";
import {
  AI_JOBS,
  cleanModelList,
  isPaidModel,
  parseEnvList,
  resolveModels,
} from "@/lib/ai/model-settings-core";

const base = {
  provider: "openrouter",
  freeOnly: false,
  savedApplies: true,
  saved: null as string[] | null,
  env: [] as string[],
  defaults: ["d/one:free", "d/two:free"],
};

describe("resolveModels", () => {
  it("uses the saved list first, then the Vercel variable, then the default", () => {
    expect(resolveModels({ ...base, saved: ["s/a"], env: ["e/a"] })).toEqual({
      models: ["s/a"],
      source: "saved",
    });
    expect(resolveModels({ ...base, env: ["e/a", "e/b"] })).toEqual({
      models: ["e/a", "e/b"],
      source: "env",
    });
    expect(resolveModels(base)).toEqual({
      models: ["d/one:free", "d/two:free"],
      source: "default",
    });
  });

  it("treats an empty or blank saved list as nothing saved", () => {
    expect(resolveModels({ ...base, saved: [], env: ["e/a"] }).source).toBe(
      "env",
    );
    expect(resolveModels({ ...base, saved: [" ", ""] }).source).toBe("default");
  });

  it("drops paid models from a free-only job, falling through when none are left", () => {
    expect(
      resolveModels({
        ...base,
        freeOnly: true,
        saved: ["paid/model", "x/free:free"],
      }),
    ).toEqual({ models: ["x/free:free"], source: "saved" });
    expect(
      resolveModels({
        ...base,
        freeOnly: true,
        saved: ["paid/model"],
        env: ["paid/other"],
      }),
    ).toEqual({ models: ["d/one:free", "d/two:free"], source: "default" });
  });

  it("ignores a saved list where it can't apply (the waiter on Anthropic)", () => {
    expect(
      resolveModels({
        ...base,
        provider: "anthropic",
        savedApplies: false,
        saved: ["anthropic/claude-haiku"],
        defaults: ["claude-opus-5"],
      }),
    ).toEqual({ models: ["claude-opus-5"], source: "default" });
  });

  it("keeps a paid waiter and still finds free models for drafts", () => {
    // AI drafts default to the waiter's list plus the vetted free list,
    // filtered to free: a paid waiter no longer switches drafting off.
    const drafts = resolveModels({
      ...base,
      freeOnly: true,
      defaults: ["anthropic/claude-haiku", "dots/dots-3:free"],
    });
    expect(drafts.models).toEqual(["dots/dots-3:free"]);
  });
});

describe("list helpers", () => {
  it("cleans and de-duplicates, keeping order", () => {
    expect(cleanModelList([" a ", "b", "a", ""])).toEqual(["a", "b"]);
    expect(parseEnvList("a, b ,,a")).toEqual(["a", "b"]);
    expect(parseEnvList(undefined)).toEqual([]);
  });

  it("marks only :free OpenRouter models as free", () => {
    expect(isPaidModel("openrouter", "x/y:free")).toBe(false);
    expect(isPaidModel("openrouter", "anthropic/claude-haiku")).toBe(true);
    expect(isPaidModel("anthropic", "claude-opus-5")).toBe(true);
  });

  it("lists five jobs, with suggestions and drafts free-only", () => {
    expect(AI_JOBS.map((j) => j.job)).toEqual([
      "waiter",
      "staff_assistant",
      "vision",
      "suggestions",
      "drafts",
    ]);
    expect(AI_JOBS.filter((j) => j.freeOnly).map((j) => j.job)).toEqual([
      "suggestions",
      "drafts",
    ]);
  });
});
