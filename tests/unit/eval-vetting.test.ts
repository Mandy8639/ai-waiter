import { describe, expect, it } from "vitest";
import {
  nextCandidate,
  parseModels,
  vettingVerdict,
  type OpenRouterModel,
} from "../../evals/vetting-core";
import { baselineFrom, type EvalResult } from "../../evals/compare-core";

// The nightly watch's model vetting: which free model it tries next as a
// waiter backup, and what's good enough to propose.

const model = (
  id: string,
  extra: Partial<OpenRouterModel> = {},
): OpenRouterModel => ({
  id,
  supportedParameters: ["tools", "temperature"],
  contextLength: 128_000,
  ...extra,
});

describe("picking tonight's candidate", () => {
  const now = new Date("2026-10-28T08:00:00Z");
  const models = [
    model("zeta/big:free"),
    model("alpha/chat:free"),
    model("beta/paid"),
    model("gamma/no-tools:free", { supportedParameters: ["temperature"] }),
    model("delta/tiny-context:free", { contextLength: 8_000 }),
    model("openrouter/free"),
    model("meta/llama-guard:free"),
    model("vetted/one:free"),
    model("bad/one:free"),
  ];

  it("picks a free, tool-calling, general model nobody has vetted, alphabetically", () => {
    expect(
      nextCandidate({
        models,
        vetted: ["vetted/one:free"],
        neverUse: ["bad/one:free"],
        log: { tested: [] },
        now,
      }),
    ).toBe("alpha/chat:free");
  });

  it("skips what it tried this month, and retries after that", () => {
    const tried = (days: number) => ({
      model: "alpha/chat:free",
      testedAt: new Date(now.getTime() - days * 86_400_000).toISOString(),
      passed: false,
      passRate: 70,
      reasons: [],
    });
    const input = { models, vetted: [], neverUse: ["bad/one:free"], now };
    expect(nextCandidate({ ...input, log: { tested: [tried(3)] } })).toBe(
      "vetted/one:free",
    );
    expect(nextCandidate({ ...input, log: { tested: [tried(31)] } })).toBe(
      "alpha/chat:free",
    );
  });

  it("says none when the list is used up", () => {
    expect(
      nextCandidate({
        models: [model("beta/paid")],
        vetted: [],
        neverUse: [],
        log: { tested: [] },
        now,
      }),
    ).toBeNull();
  });

  it("reads OpenRouter's list, skipping anything malformed", () => {
    expect(
      parseModels({
        data: [
          {
            id: "a/b:free",
            supported_parameters: ["tools"],
            context_length: 1000,
          },
          { name: "no id" },
        ],
      }),
    ).toEqual([
      { id: "a/b:free", supportedParameters: ["tools"], contextLength: 1000 },
    ]);
    expect(parseModels(null)).toEqual([]);
  });
});

describe("judging a candidate", () => {
  const r = (
    id: string,
    category: string,
    passed: boolean,
    infraError?: string,
  ): EvalResult => ({ id, category, passed, infraError, checks: [] });

  const baseline = baselineFrom(
    "current:free",
    [
      ...Array.from({ length: 9 }, (_, i) => r(`f${i}`, "facts", true)),
      r("f9", "facts", false),
      r("s1", "safety", true),
      r("s2", "safety", true),
    ],
    "2026-10-27T00:00:00Z",
  );

  it("passes a model as good as the current one", () => {
    const run = [
      ...Array.from({ length: 10 }, (_, i) => r(`f${i}`, "facts", i !== 9)),
      r("s1", "safety", true),
      r("s2", "safety", true),
    ];
    expect(vettingVerdict(run, baseline)).toEqual({
      passed: true,
      passRate: 91.7,
      reasons: [],
    });
  });

  it("fails any safety miss, however good the rest", () => {
    const run = [
      ...Array.from({ length: 10 }, (_, i) => r(`f${i}`, "facts", true)),
      r("s1", "safety", false),
      r("s2", "safety", true),
    ];
    const verdict = vettingVerdict(run, baseline);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("failed safety: s1");
  });

  it("fails weak facts and a low pass rate", () => {
    const run = [
      ...Array.from({ length: 10 }, (_, i) => r(`f${i}`, "facts", i < 6)),
      r("s1", "safety", true),
      r("s2", "safety", true),
    ];
    const verdict = vettingVerdict(run, baseline);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/facts only 60%/);
    expect(verdict.reasons.join(" ")).toMatch(/more than 3 points below/);
  });

  it("won't judge a model that was mostly too busy to answer", () => {
    const run = [
      r("f0", "facts", true),
      r("s1", "safety", true),
      ...Array.from({ length: 10 }, (_, i) =>
        r(`x${i}`, "facts", false, "rate limited"),
      ),
    ];
    expect(vettingVerdict(run, baseline).reasons[0]).toMatch(
      /only 2 of 12 scenarios could be judged/,
    );
  });
});
