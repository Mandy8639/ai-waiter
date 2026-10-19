// The Admin page's Change history: how a change reads and what Undo
// would do (src/lib/admin/history-core.ts).
import { describe, expect, it } from "vitest";
import {
  describeEntry,
  formatWhen,
  historyRows,
  undoPlan,
  type HistoryEntry,
} from "@/lib/admin/history-core";

const VIEWER = "00000000-0000-4000-8000-0000000000aa";

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    job: "waiter",
    action: "save",
    oldModels: ["old/a:free"],
    newModels: ["new/paid", "old/a:free"],
    testResult: { ms: 3100, costUsd: 0.008, passed: true },
    changedBy: VIEWER,
    changedAt: "2026-10-19T16:40:00Z",
    ...over,
  };
}

describe("describeEntry", () => {
  it("reads like the plan's example", () => {
    expect(describeEntry(entry())).toEqual({
      what: "Diner's AI waiter",
      change: "old/a:free → new/paid, old/a:free",
      test: "test passed, 3.1 s, 0.8¢",
    });
  });

  it("names a change from or to nothing saved", () => {
    expect(describeEntry(entry({ oldModels: null })).change).toMatch(
      /^nothing saved .* → new\/paid/,
    );
  });

  it("marks an undo, and lists what a reset cleared", () => {
    expect(describeEntry(entry({ action: "undo" })).what).toBe(
      "Diner's AI waiter (undo)",
    );
    const reset = describeEntry(
      entry({
        job: "all",
        action: "reset",
        oldModels: null,
        newModels: null,
        testResult: { cleared: { waiter: ["x"], drafts: ["y:free"] } },
      }),
    );
    expect(reset.what).toBe("Emergency reset");
    expect(reset.change).toMatch(/Diner's AI waiter, AI drafts/);
    expect(reset.test).toBeNull();
  });
});

describe("undoPlan", () => {
  it("re-tests and restores the list a change replaced", () => {
    expect(undoPlan(entry(), ["new/paid", "old/a:free"])).toEqual({
      kind: "restore",
      job: "waiter",
      models: ["old/a:free"],
    });
  });

  it("goes back to nothing saved, without a Test, when nothing was saved before", () => {
    expect(undoPlan(entry({ oldModels: null }), ["new/paid"])).toEqual({
      kind: "clear",
      job: "waiter",
    });
  });

  it("offers nothing when the job is already back there", () => {
    expect(undoPlan(entry(), ["old/a:free"])).toBeNull();
    expect(undoPlan(entry({ oldModels: null }), null)).toBeNull();
  });

  it("doesn't undo a reset from its own row", () => {
    expect(
      undoPlan(entry({ job: "all", action: "reset", oldModels: null }), null),
    ).toBeNull();
  });
});

describe("historyRows", () => {
  it("says who and what Undo would do", () => {
    const [mine, theirs] = historyRows(
      [entry(), entry({ id: "2", changedBy: "someone-else", oldModels: null })],
      new Map([["waiter", ["new/paid", "old/a:free"]]]),
      VIEWER,
    );
    expect(mine.who).toBe("you");
    expect(mine.undo).toMatch(/tests old\/a:free .* again/);
    expect(theirs.who).toBe("another admin");
    expect(theirs.undo).toMatch(/back to its Vercel variable/);
  });

  it("writes times in UTC", () => {
    expect(formatWhen("2026-10-19T16:40:00Z")).toBe("19 Oct, 16:40 UTC");
  });
});
