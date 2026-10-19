/**
 * The Admin page's Change history card (docs/admin.md, Phase 3): how a
 * history row reads, and what its Undo would do. Pure, so it is
 * unit-tested; history.ts reads the rows and actions.ts runs Undo.
 */

import { jobInfo, type AiJob } from "@/lib/ai/model-settings-core";
import { formatCost, formatSeconds } from "./model-test-core";

export type HistoryAction = "save" | "undo" | "reset";

export interface HistoryEntry {
  id: string;
  job: AiJob | "all";
  action: HistoryAction;
  oldModels: string[] | null;
  newModels: string[] | null;
  /** What the Test that allowed it showed; for a reset, what was cleared. */
  testResult: Record<string, unknown> | null;
  changedBy: string | null;
  changedAt: string;
}

export const HISTORY_LIMIT = 50;

function listText(models: string[] | null): string {
  return models && models.length > 0
    ? models.join(", ")
    : "nothing saved (Vercel variable or built-in default)";
}

/** "19 Oct, 16:40 UTC". */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${day}, ${time} UTC`;
}

export function describeEntry(entry: HistoryEntry): {
  what: string;
  change: string;
  test: string | null;
} {
  if (entry.job === "all") {
    const cleared = (entry.testResult?.cleared ?? {}) as Record<
      string,
      unknown
    >;
    const jobs = Object.keys(cleared)
      .map((j) => jobInfo(j as AiJob)?.label ?? j)
      .join(", ");
    return {
      what: "Emergency reset",
      change: jobs
        ? `Cleared saved lists for ${jobs}. Every job is back on its Vercel variable or built-in default.`
        : "Nothing was saved, so nothing changed.",
      test: null,
    };
  }
  const label = jobInfo(entry.job).label;
  const r = entry.testResult;
  const test =
    r && typeof r.ms === "number"
      ? `test passed, ${formatSeconds(r.ms)}, ${formatCost(
          typeof r.costUsd === "number" ? r.costUsd : null,
        )}`
      : null;
  return {
    what: entry.action === "undo" ? `${label} (undo)` : label,
    change: `${listText(entry.oldModels)} → ${listText(entry.newModels)}`,
    test,
  };
}

/**
 * What Undo on this row would do, or null when it can't be undone. A
 * reset isn't undone from here: each job's own row can be.
 *   - restore: test `models` again, then save them (needs a pass);
 *   - clear: go back to nothing saved, which needs no Test, because the
 *     Vercel variables and defaults are what ran before anything was saved.
 */
export function undoPlan(
  entry: HistoryEntry,
  current: string[] | null,
):
  | { kind: "restore"; job: AiJob; models: string[] }
  | { kind: "clear"; job: AiJob }
  | null {
  if (entry.job === "all") return null;
  const target = entry.oldModels;
  // Already back where this change started.
  const same =
    (target === null && current === null) ||
    (target !== null &&
      current !== null &&
      target.length === current.length &&
      target.every((m, i) => m === current[i]));
  if (same) return null;
  return target === null || target.length === 0
    ? { kind: "clear", job: entry.job }
    : { kind: "restore", job: entry.job, models: target };
}

/** The history card's rows, worded, with what each Undo would do. */
export function historyRows(
  entries: readonly HistoryEntry[],
  saved: ReadonlyMap<string, string[]>,
  viewerId: string,
) {
  return entries.map((entry) => {
    const { what, change, test } = describeEntry(entry);
    const plan = undoPlan(
      entry,
      entry.job === "all" ? null : (saved.get(entry.job) ?? null),
    );
    const label = plan ? jobInfo(plan.job).label : "";
    return {
      id: entry.id,
      when: formatWhen(entry.changedAt),
      who: entry.changedBy === viewerId ? "you" : "another admin",
      what,
      change,
      test,
      undo: !plan
        ? null
        : plan.kind === "clear"
          ? `${label} goes back to its Vercel variable or built-in default. No Test is needed for that.`
          : `This tests ${plan.models.join(", ")} for ${label} again (a paid model spends a little credit) and puts it back only if it passes today.`,
    };
  });
}
