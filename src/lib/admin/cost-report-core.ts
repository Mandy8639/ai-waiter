/**
 * AI cost per restaurant (docs/admin.md, Phase 4): the weeks it covers,
 * the totals, and the words, for the Spending card's table and the
 * Monday email. Pure, so it is unit-tested; cost-report.ts reads
 * ai_cost_summary().
 *
 * Weeks run Monday 00:00 to Monday 00:00 UTC. A "chat" is one diner
 * message the AI waiter answered.
 */

export interface CostRow {
  /** Null for platform use: Admin page Tests and safety-net checks. */
  restaurantId: string | null;
  name: string;
  waiterChats: number;
  uses: number;
  costUsd: number;
  /** Uses whose cost isn't known (left out of costUsd, never counted as 0). */
  unpriced: number;
}

export interface Week {
  from: Date;
  to: Date;
}

/** This week so far, and the whole of last week, in UTC. */
export function weekBounds(now: Date): { thisWeek: Week; lastWeek: Week } {
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // getUTCDay: Sunday 0 … Saturday 6; days since Monday.
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const lastMonday = new Date(monday);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  return {
    thisWeek: { from: monday, to: now },
    lastWeek: { from: lastMonday, to: monday },
  };
}

/** "2026-10-19": the week's Monday, which names it in the email log. */
export function weekKey(week: Week): string {
  return week.from.toISOString().slice(0, 10);
}

/** "12–18 Oct". */
export function weekLabel(week: Week): string {
  const last = new Date(week.to.getTime() - 1);
  const day = (d: Date, month: boolean) =>
    d.toLocaleDateString("en-GB", {
      day: "numeric",
      ...(month ? { month: "short" } : {}),
      timeZone: "UTC",
    });
  const sameMonth = week.from.getUTCMonth() === last.getUTCMonth();
  return `${day(week.from, !sameMonth)}–${day(last, true)}`;
}

export function parseCostRows(data: unknown): CostRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((raw) => {
    const r = raw as Record<string, unknown>;
    const id = typeof r.restaurant_id === "string" ? r.restaurant_id : null;
    return {
      restaurantId: id,
      name:
        id === null
          ? "Admin Tests and safety checks"
          : typeof r.restaurant_name === "string"
            ? r.restaurant_name
            : "A deleted restaurant",
      waiterChats: Number(r.waiter_chats) || 0,
      uses: Number(r.uses) || 0,
      costUsd: Number(r.cost_usd) || 0,
      unpriced: Number(r.unpriced) || 0,
    };
  });
}

export interface CostTotals {
  costUsd: number;
  waiterChats: number;
  /** Restaurants that used AI at all. */
  restaurants: number;
  /** Total cost per waiter chat, or null with no chats. */
  perChatUsd: number | null;
  unpriced: number;
}

export function costTotals(rows: readonly CostRow[]): CostTotals {
  const costUsd = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const waiterChats = rows.reduce((sum, r) => sum + r.waiterChats, 0);
  return {
    costUsd,
    waiterChats,
    restaurants: rows.filter((r) => r.restaurantId !== null && r.uses > 0)
      .length,
    perChatUsd: waiterChats > 0 ? costUsd / waiterChats : null,
    unpriced: rows.reduce((sum, r) => sum + r.unpriced, 0),
  };
}

/** "$3.40", "0.4¢", "$0.00": small sums in cents so they don't all read $0.00. */
export function formatSpend(usd: number): string {
  if (usd > 0 && usd < 0.1) {
    const cents = usd * 100;
    return `${cents < 0.1 ? cents.toFixed(2) : cents.toFixed(1)}¢`;
  }
  return `$${usd.toFixed(2)}`;
}

/** Per-row cost per chat, or "–" for a row with no chats. */
export function perChat(row: CostRow): string {
  return row.waiterChats > 0 ? formatSpend(row.costUsd / row.waiterChats) : "–";
}

/** The email's subject, carrying the answer. */
export function weeklySubject(totals: CostTotals): string {
  if (totals.waiterChats === 0 && totals.costUsd === 0) {
    return "Tableside AI last week: no AI use";
  }
  const restaurants = `${totals.restaurants} restaurant${totals.restaurants === 1 ? "" : "s"}`;
  const perChatText =
    totals.perChatUsd === null
      ? ""
      : `, ${formatSpend(totals.perChatUsd)} per chat`;
  return `Tableside AI last week: ${formatSpend(totals.costUsd)} across ${restaurants}${perChatText}`;
}
