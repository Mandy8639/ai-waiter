/**
 * The Admin page's Spending card (docs/admin.md, Phase 3): what
 * OpenRouter says about the app's key and account, read live. Pure, so
 * the parsing and the wording are unit-tested; openrouter-spend.ts makes
 * the two requests.
 *
 * Every figure is optional. A field OpenRouter didn't send, or a request
 * that failed, shows as "not reported" rather than as $0: a zero would
 * read as "nothing spent", which is the one wrong answer that matters.
 */

export interface Spending {
  /** Credit left on the account: total bought minus total used. */
  balanceUsd: number | null;
  /** Spent on this key since the start of the month (UTC). */
  monthUsd: number | null;
  /** Spent on this key today (UTC). */
  todayUsd: number | null;
  /** The key's spending limit, set on OpenRouter. Null: no limit set, or not reported. */
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  /** "monthly", "weekly", "daily", or null when the limit never resets. */
  limitReset: string | null;
}

export const NOTHING_REPORTED: Spending = {
  balanceUsd: null,
  monthUsd: null,
  todayUsd: null,
  limitUsd: null,
  limitRemainingUsd: null,
  limitReset: null,
};

function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** GET /api/v1/key's body: this key's usage and limit. */
export function parseKeyInfo(
  body: unknown,
): Omit<Spending, "balanceUsd"> | null {
  const d = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d !== "object") return null;
  return {
    monthUsd: money(d.usage_monthly),
    todayUsd: money(d.usage_daily),
    limitUsd: money(d.limit),
    limitRemainingUsd: money(d.limit_remaining),
    limitReset: typeof d.limit_reset === "string" ? d.limit_reset : null,
  };
}

/** GET /api/v1/credits's body: what the account has bought and used. */
export function parseCredits(body: unknown): number | null {
  const d = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d !== "object") return null;
  const bought = money(d.total_credits);
  const used = money(d.total_usage);
  if (bought === null || used === null) return null;
  return Math.max(0, bought - used);
}

export function combineSpending(
  key: Omit<Spending, "balanceUsd"> | null,
  balanceUsd: number | null,
): Spending {
  return { ...NOTHING_REPORTED, ...(key ?? {}), balanceUsd };
}

export function nothingReported(s: Spending): boolean {
  return Object.values(s).every((v) => v === null);
}

/** "$12.40", "3.2¢", "$0.00"; "not reported" when unknown. */
export function formatUsd(usd: number | null): string {
  if (usd === null) return "not reported";
  if (usd > 0 && usd < 0.1) return `${(usd * 100).toFixed(1)}¢`;
  return `$${usd.toFixed(2)}`;
}

/** How much of the limit is used, 0–100, or null when there is no limit to measure against. */
export function limitUsedPercent(s: Spending): number | null {
  if (s.limitUsd === null || s.limitUsd === 0) return null;
  const used =
    s.limitRemainingUsd !== null
      ? s.limitUsd - s.limitRemainingUsd
      : s.limitReset === "monthly"
        ? s.monthUsd
        : null;
  if (used === null) return null;
  return Math.min(100, Math.max(0, Math.round((used / s.limitUsd) * 100)));
}

/** "per month", "per day"… for the limit's reset period. */
export function resetLabel(reset: string | null): string {
  switch (reset) {
    case "daily":
      return "per day";
    case "weekly":
      return "per week";
    case "monthly":
      return "per month";
    default:
      return "in total";
  }
}
