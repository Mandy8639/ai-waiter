/**
 * Guest insights' arithmetic and wording (docs/guest-insights.md). Pure,
 * so it is tested without a database; get_guest_insights() does the
 * counting.
 */

export interface GuestInsights {
  visits: {
    visits: number;
    orderingVisits: number;
    spend: number;
    orders: number;
  };
  ai: {
    chatVisits: number;
    chatOrderingVisits: number;
    chatSpend: number;
    otherOrderingVisits: number;
    otherSpend: number;
    questions: number;
  };
  /** Orders by the restaurant's weekday (1 = Monday) and hour. */
  busy: { dow: number; hour: number; orders: number }[];
  feedback: { count: number; average: number | null; byRating: number[] };
  bookings: {
    bookings: number;
    kept: number;
    covers: number;
    noShows: number;
    cancelled: number;
    guests: number;
    returningGuests: number;
  };
  regulars: { name: string; visits: number; lastVisit: string }[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** The function's jsonb, with every number a number and nothing missing. */
export function parseInsights(data: unknown): GuestInsights {
  const d = obj(data);
  const v = obj(d.visits);
  const ai = obj(d.ai);
  const f = obj(d.feedback);
  const b = obj(d.bookings);
  const byRating = Array.isArray(f.byRating) ? f.byRating.map(num) : [];
  return {
    visits: {
      visits: num(v.visits),
      orderingVisits: num(v.orderingVisits),
      spend: num(v.spend),
      orders: num(v.orders),
    },
    ai: {
      chatVisits: num(ai.chatVisits),
      chatOrderingVisits: num(ai.chatOrderingVisits),
      chatSpend: num(ai.chatSpend),
      otherOrderingVisits: num(ai.otherOrderingVisits),
      otherSpend: num(ai.otherSpend),
      questions: num(ai.questions),
    },
    busy: (Array.isArray(d.busy) ? d.busy : []).map((r) => {
      const o = obj(r);
      return { dow: num(o.dow), hour: num(o.hour), orders: num(o.orders) };
    }),
    feedback: {
      count: num(f.count),
      average:
        f.average === null || f.average === undefined ? null : num(f.average),
      byRating: [0, 1, 2, 3, 4].map((i) => byRating[i] ?? 0),
    },
    bookings: {
      bookings: num(b.bookings),
      kept: num(b.kept),
      covers: num(b.covers),
      noShows: num(b.noShows),
      cancelled: num(b.cancelled),
      guests: num(b.guests),
      returningGuests: num(b.returningGuests),
    },
    regulars: (Array.isArray(d.regulars) ? d.regulars : []).map((r) => {
      const o = obj(r);
      return {
        name: String(o.name ?? ""),
        visits: num(o.visits),
        lastVisit: String(o.lastVisit ?? ""),
      };
    }),
  };
}

/** Average; null rather than 0 when there is nothing to average. */
export function average(total: number, count: number): number | null {
  return count > 0 ? total / count : null;
}

/** A share as a whole percentage; "–" when there is nothing to share. */
export function percent(part: number, whole: number): string {
  if (whole <= 0) return "–";
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * How much more (or less) a guest who asked the AI waiter spent per
 * ordering visit than one who didn't. Null until both sides have at
 * least three visits: one big table shouldn't read as a trend.
 */
export function aiSpendLift(ai: GuestInsights["ai"]): number | null {
  if (ai.chatOrderingVisits < 3 || ai.otherOrderingVisits < 3) return null;
  const withChat = ai.chatSpend / ai.chatOrderingVisits;
  const without = ai.otherSpend / ai.otherOrderingVisits;
  if (without <= 0) return null;
  return withChat / without - 1;
}

export function describeLift(lift: number | null): string | null {
  if (lift === null) return null;
  const pct = Math.round(Math.abs(lift) * 100);
  if (pct === 0) return "about the same as";
  return `${pct}% ${lift > 0 ? "more than" : "less than"}`;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function dayName(dow: number): string {
  return DAYS[dow - 1] ?? "";
}

export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? "am" : "pm"}`;
}

/** The busiest weekday-and-hour slots, most orders first. */
export function busiestSlots(
  busy: GuestInsights["busy"],
  count = 3,
): { label: string; orders: number }[] {
  return [...busy]
    .sort((a, b) => b.orders - a.orders || a.dow - b.dow || a.hour - b.hour)
    .slice(0, count)
    .map((s) => ({
      label: `${dayName(s.dow)} ${hourLabel(s.hour)}–${hourLabel((s.hour + 1) % 24)}`,
      orders: s.orders,
    }));
}

/**
 * The busy-times grid: one row per weekday, one column per hour from the
 * earliest to the latest hour anything was ordered, each cell's share of
 * the busiest cell (0–1) for shading.
 */
export function busyGrid(busy: GuestInsights["busy"]): {
  hours: number[];
  rows: { day: string; cells: { orders: number; level: number }[] }[];
} {
  if (busy.length === 0) return { hours: [], rows: [] };
  const first = Math.min(...busy.map((b) => b.hour));
  const last = Math.max(...busy.map((b) => b.hour));
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const max = Math.max(...busy.map((b) => b.orders));
  const at = new Map(busy.map((b) => [`${b.dow}:${b.hour}`, b.orders]));
  return {
    hours,
    rows: DAYS.map((day, i) => ({
      day,
      cells: hours.map((h) => {
        const orders = at.get(`${i + 1}:${h}`) ?? 0;
        return { orders, level: max > 0 ? orders / max : 0 };
      }),
    })),
  };
}
