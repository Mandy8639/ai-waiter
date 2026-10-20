// The Admin page's side-by-side test: what can be compared, and the plain
// notes under the two answers (src/lib/admin/compare-core.ts).
import { describe, expect, it } from "vitest";
import {
  compareNotes,
  compareProblem,
  type CompareAnswer,
} from "@/lib/admin/compare-core";

const known = new Set(["a/one:free", "b/two:free", "c/paid"]);
const problem = (models: string[], question = "Is it spicy?") =>
  compareProblem({ models, question, provider: "openrouter", known });

describe("compareProblem", () => {
  it("takes two different, known models and a question", () => {
    expect(problem(["a/one:free", "c/paid"])).toBeNull();
    expect(problem(["a/one:free", ""])).toBe("Choose two models.");
    expect(problem(["a/one:free", "a/one:free"])).toBe(
      "Choose two different models.",
    );
    expect(problem(["a/one:free", "x/nope"])).toMatch(/doesn't list x\/nope/);
    expect(problem(["a/one:free", "openrouter/free"])).toMatch(
      /different model each time/,
    );
  });

  it("needs a question of a sensible length", () => {
    expect(problem(["a/one:free", "b/two:free"], "  ")).toMatch(
      /Type a question/,
    );
    expect(problem(["a/one:free", "b/two:free"], "x".repeat(301))).toMatch(
      /under 300/,
    );
  });

  it("can't compare the waiter when it runs on Anthropic directly", () => {
    expect(
      compareProblem({
        models: ["a/one:free", "b/two:free"],
        question: "Hi",
        provider: "anthropic",
        known,
      }),
    ).toMatch(/Anthropic directly/);
  });
});

const answer = (patch: Partial<CompareAnswer>): CompareAnswer => ({
  model: "a/one:free",
  reply: "Try the Dal Makhani.",
  tools: ["search_menu"],
  declined: false,
  ms: 2000,
  costUsd: 0,
  ...patch,
});

describe("compareNotes", () => {
  it("says who was faster, cheaper, and who skipped the menu", () => {
    expect(
      compareNotes(
        answer({}),
        answer({ model: "c/paid", ms: 4100, costUsd: 0.002, tools: [] }),
      ),
    ).toEqual([
      "a/one:free was 2.1 s faster (2.0 s against 4.1 s).",
      "a/one:free cost less.",
      "c/paid answered without looking at the menu, so it may have guessed.",
    ]);
  });

  it("leaves out differences too small to matter, and unknown costs", () => {
    expect(
      compareNotes(
        answer({}),
        answer({ model: "b/two:free", ms: 2300, costUsd: null }),
      ),
    ).toEqual([]);
  });

  it("says when only one answered, or one declined", () => {
    expect(
      compareNotes(answer({}), answer({ model: "b/two:free", error: "busy" })),
    ).toEqual(["Only a/one:free answered."]);
    expect(
      compareNotes(answer({}), answer({ model: "b/two:free", declined: true })),
    ).toEqual(["b/two:free declined to answer."]);
  });
});
