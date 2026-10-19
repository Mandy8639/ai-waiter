// The waiter's free safety net: which free models are checked, which may
// be used, and when the waiter falls back to them
// (src/lib/ai/safety-net-core.ts).
import { describe, expect, it, vi } from "vitest";
import { AiProviderError } from "@/lib/ai/provider-error";
import {
  callWithSafetyNet,
  formatAgo,
  isEligible,
  lastCheckedAt,
  MAX_CANDIDATES,
  nextCheck,
  rankSafetyNet,
  safetyNetCandidates,
  safetyNetRows,
  type FreeModelCheck,
} from "@/lib/ai/safety-net-core";

const NOW = new Date("2026-10-19T12:00:00Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

function check(
  model: string,
  status: FreeModelCheck["status"],
  passedHoursAgo: number | null,
  passMs: number | null = 5000,
): FreeModelCheck {
  return {
    model,
    status,
    lastPassedAt: passedHoursAgo === null ? null : hoursAgo(passedHoursAgo),
    passMs,
    checkedAt: hoursAgo(1),
  };
}

describe("safetyNetCandidates", () => {
  it("keeps free, tool-calling chat models only", () => {
    expect(
      safetyNetCandidates([
        { id: "a/chat:free", tools: true },
        { id: "b/paid", tools: true },
        { id: "c/notools:free", tools: false },
        { id: "openrouter/free", tools: true },
        { id: "d/llama-guard:free", tools: true },
      ]),
    ).toEqual(["a/chat:free"]);
  });

  it("checks at most a dozen a day", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `m/${String(i).padStart(2, "0")}:free`,
      tools: true,
    }));
    expect(safetyNetCandidates(many)).toHaveLength(MAX_CANDIDATES);
  });
});

describe("isEligible and rankSafetyNet", () => {
  it("uses models that passed within three days, fastest first", () => {
    const checks = [
      check("slow:free", "passed", 1, 9000),
      check("fast:free", "passed", 2, 3000),
      check("old:free", "passed", 80, 1000),
    ];
    expect(rankSafetyNet(checks, NOW)).toEqual(["fast:free", "slow:free"]);
  });

  it("keeps a model that was only busy at its last check", () => {
    expect(isEligible(check("m:free", "busy", 20), NOW)).toBe(true);
  });

  it("drops a model whose last check failed, or that never passed", () => {
    expect(isEligible(check("m:free", "failed", 2), NOW)).toBe(false);
    expect(isEligible(check("m:free", "busy", null), NOW)).toBe(false);
  });

  it("never uses a paid model, whatever the store says", () => {
    expect(isEligible(check("m/paid", "passed", 1), NOW)).toBe(false);
  });
});

describe("nextCheck", () => {
  const prev = check("m:free", "passed", 10, 4000);

  it("records a pass with its time", () => {
    expect(
      nextCheck(prev, "m:free", { status: "passed", ms: 2500 }, NOW),
    ).toMatchObject({
      status: "passed",
      lastPassedAt: NOW.toISOString(),
      passMs: 2500,
    });
  });

  it("keeps the last pass when the model was only busy", () => {
    expect(
      nextCheck(prev, "m:free", { status: "busy", ms: 100 }, NOW),
    ).toMatchObject({
      status: "busy",
      lastPassedAt: prev.lastPassedAt,
      passMs: 4000,
    });
  });

  it("marks a failure, which takes the model out of the net", () => {
    const next = nextCheck(prev, "m:free", { status: "failed", ms: 100 }, NOW);
    expect(isEligible(next, NOW)).toBe(false);
  });
});

describe("callWithSafetyNet", () => {
  const busy = new AiProviderError("429", "rate_limited");

  it("doesn't touch the net when the waiter's own list answers", async () => {
    const safetyNet = vi.fn(async () => ["net:free"]);
    const call = vi.fn(async (models: string[]) => models[0]);
    await expect(
      callWithSafetyNet({ primary: ["main"], call, safetyNet }),
    ).resolves.toBe("main");
    expect(safetyNet).not.toHaveBeenCalled();
  });

  it("tries the net once when the whole list is busy", async () => {
    const onUsed = vi.fn();
    const call = vi.fn(async (models: string[]) => {
      if (models[0] === "main") throw busy;
      return models.join(",");
    });
    await expect(
      callWithSafetyNet({
        primary: ["main", "dup:free"],
        call,
        safetyNet: async () => [
          "dup:free",
          "a:free",
          "b:free",
          "c:free",
          "d:free",
        ],
        onUsed,
      }),
    ).resolves.toBe("a:free,b:free,c:free");
    expect(onUsed).toHaveBeenCalledWith(["a:free", "b:free", "c:free"], busy);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("falls back on a timeout or an HTTP error too", async () => {
    for (const category of ["timeout", "http_error"] as const) {
      const call = vi.fn(async (models: string[]) => {
        if (models[0] === "main") throw new AiProviderError("x", category);
        return "net";
      });
      await expect(
        callWithSafetyNet({
          primary: ["main"],
          call,
          safetyNet: async () => ["n:free"],
        }),
      ).resolves.toBe("net");
    }
  });

  it("rethrows the original error when the net is empty or off", async () => {
    await expect(
      callWithSafetyNet({
        primary: ["main"],
        call: async () => {
          throw busy;
        },
        safetyNet: async () => [],
      }),
    ).rejects.toBe(busy);
  });

  it("doesn't fall back on errors another model can't fix", async () => {
    const safetyNet = vi.fn(async () => ["n:free"]);
    const odd = new Error("bug");
    await expect(
      callWithSafetyNet({
        primary: ["main"],
        call: async () => {
          throw odd;
        },
        safetyNet,
      }),
    ).rejects.toBe(odd);
    expect(safetyNet).not.toHaveBeenCalled();
  });

  it("surfaces the net's own failure without trying again", async () => {
    const call = vi.fn(async () => {
      throw busy;
    });
    await expect(
      callWithSafetyNet({
        primary: ["main"],
        call,
        safetyNet: async () => ["n:free"],
      }),
    ).rejects.toBe(busy);
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe("the Admin page's list", () => {
  it("shows the net in order, then the rest, worded", () => {
    const rows = safetyNetRows(
      [
        check("failed:free", "failed", 30),
        check("slow:free", "passed", 1, 9000),
        check("fast:free", "passed", 1, 3000),
        check("busy:free", "busy", null),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.model, r.rank])).toEqual([
      ["fast:free", 1],
      ["slow:free", 2],
      ["busy:free", null],
      ["failed:free", null],
    ]);
    expect(rows[0].detail).toBe("passed 1 h ago · 3.0 s");
    expect(rows[3].detail).toBe("failed 1 h ago");
  });

  it("words times plainly", () => {
    expect(formatAgo(NOW.toISOString(), NOW)).toBe("just now");
    expect(formatAgo(hoursAgo(0.5), NOW)).toBe("30 min ago");
    expect(formatAgo(hoursAgo(5), NOW)).toBe("5 h ago");
    expect(formatAgo(hoursAgo(72), NOW)).toBe("3 days ago");
  });

  it("reports when the check last ran", () => {
    expect(lastCheckedAt([])).toBeNull();
    expect(
      lastCheckedAt([
        { ...check("a:free", "passed", 1), checkedAt: hoursAgo(5) },
        { ...check("b:free", "passed", 1), checkedAt: hoursAgo(2) },
      ]),
    ).toBe(hoursAgo(2));
  });
});
