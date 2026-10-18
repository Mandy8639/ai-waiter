import type { StaffIntent } from "./intent";

/**
 * The built-in phrases: how a kitchen actually says it, read without a
 * model. Most commands mid-service are one of a handful of shapes ("86 the
 * salmon", "out of oat milk", "pause orders for an hour"), and reading
 * those here makes them instant, free and the same every time. Anything
 * else comes back `unknown` and goes to the model (interpret-core.ts),
 * whose reading is always confirmed before it changes anything.
 *
 * No `server-only`, per the extract-the-core convention.
 */

/** Lowercase, straight quotes, single spaces, no trailing punctuation. */
export function normalizeCommand(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’′]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  "forty-five": 45,
  fortyfive: 45,
  sixty: 60,
  ninety: 90,
};

function amount(word: string): number | null {
  if (/^\d+(\.\d+)?$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

/**
 * Minutes in "for an hour", "30 min", "half an hour", "1.5 hours",
 * "2 hrs". Null when the text names no duration.
 */
export function parseDuration(text: string): number | null {
  if (/\bhalf (an|a) ?hour\b/.test(text)) return 30;
  if (/\b(an|one) hour and a half\b/.test(text)) return 90;
  const m = text.match(
    /\b(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty|forty-five|sixty|ninety)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/,
  );
  if (!m) return null;
  const n = amount(m[1]);
  if (n === null) return null;
  return Math.round(m[2].startsWith("h") ? n * 60 : n);
}

/** "the salmon please" → "salmon". */
export function cleanTarget(raw: string): string {
  let t = raw.trim();
  const trailing =
    /\s*(,|please|pls|for (today|tonight|now|good|the (day|night|rest of (the )?(day|night|service)))|until (tomorrow|further notice|i say( so)?|we (open|reopen)|next (service|opening))|today|tonight|right now|now|again|indefinitely|permanently)\s*$/;
  const leading = /^(the|our|all (of )?the|all|any|some|a|an)\s+/;
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(trailing, "").replace(leading, "").trim();
    if (t === before) break;
  }
  return t.replace(/^["']|["']$/g, "").trim();
}

const MANUAL_UNTIL =
  /\b(for good|until further notice|indefinitely|permanently|until i say|until i turn it back|until we say|off the menu)\b/;

function soldOut(target: string, text: string): StaffIntent | null {
  const t = cleanTarget(target);
  if (!t) return null;
  return {
    kind: "sold_out",
    target: t,
    until: MANUAL_UNTIL.test(text) ? "manual" : "next_opening",
  };
}

function back(target: string): StaffIntent | null {
  const t = cleanTarget(target);
  return t ? { kind: "back", target: t } : null;
}

const ORDERS = String.raw`(?:new |qr |online |table )?(?:orders?|ordering)`;

/** Reads one command, or `unknown`. */
export function parseStaffCommand(input: string): StaffIntent {
  const text = normalizeCommand(input);
  if (!text) return { kind: "unknown" };

  if (/^(help|\?|what can you do|commands|how does this work)$/.test(text)) {
    return { kind: "help" };
  }

  if (
    /^(status|what'?s (sold out|86'?d|off|out|paused|unavailable)|what is (sold out|86'?d|off|out|paused|unavailable)|what are we out of|anything (sold out|86'?d))\b/.test(
      text,
    )
  ) {
    return { kind: "status" };
  }

  // Ordering on and off. "Resume" before "pause" so "unpause" isn't read
  // as a pause.
  if (
    new RegExp(
      String.raw`^(?:resume|unpause|restart|reopen|re-?open|turn on|start(?: taking)?|open(?: up)?|take)(?: taking)? ${ORDERS}\b|^(?:resume|unpause)$|^${ORDERS} (?:back on|on again|can resume)$`,
    ).test(text)
  ) {
    return { kind: "resume" };
  }
  if (
    new RegExp(
      String.raw`\b(?:pause|stop|hold|halt|turn off|freeze|block)\b(?: taking)? (?:all )?${ORDERS}\b|^(?:pause|stop orders)\b`,
    ).test(text)
  ) {
    return { kind: "pause", minutes: parseDuration(text) };
  }

  // The kitchen running behind.
  if (
    /\b(back to normal|caught up|not busy anymore|no longer busy|clear (the )?(busy|delay|extra wait|wait)|(remove|no) (the )?(extra )?(wait|delay))\b/.test(
      text,
    )
  ) {
    return { kind: "busy_off" };
  }
  {
    const minutes = text.match(
      /\b(\d{1,3})\s*(?:more |extra )?(?:minutes?|mins?|m)\b/,
    );
    const withMinutes =
      /\b(add|adding|extra|longer|more|slammed|swamped|busy|running|behind|backed up|weeds|delay(ed)?|wait)\b/;
    const onItsOwn =
      /\b(slammed|swamped|running (late|behind|slow)|backed up|in the weeds|kitchen is busy|we'?re (really )?busy|running behind)\b/;
    if (minutes && withMinutes.test(text)) {
      return { kind: "busy", extraMinutes: Number(minutes[1]) };
    }
    if (!minutes && onItsOwn.test(text)) {
      return { kind: "busy", extraMinutes: 15 };
    }
  }

  // Prices: needs a "$" or the word price/cost, so "pause for 30" can
  // never become a price.
  {
    const money = String.raw`\$?\s?(\d{1,5}(?:\.\d{1,2})?)`;
    const patterns = [
      // set the price of X to $5.50 / change X's price to 5.50
      new RegExp(
        String.raw`^(?:set|change|update|make)? ?(?:the )?price (?:of|for) (.+?) (?:to|at|=) ${money}$`,
      ),
      new RegExp(
        String.raw`^(?:set|change|update|make) (.+?)(?:'s)? price (?:to|at|=) ${money}$`,
      ),
      // make the mango lassi $5.50 / change mango lassi to $5.50
      new RegExp(
        String.raw`^(?:set|change|update|make|put|charge) (.+?) (?:to |at |for )?\$\s?(\d{1,5}(?:\.\d{1,2})?)$`,
      ),
      // mango lassi is now $5.50 / mango lassi costs 5.50 now
      new RegExp(
        String.raw`^(.+?) (?:is now|now costs|costs|should cost|price is now|price is) ${money}(?: now)?$`,
      ),
      // price mango lassi 5.50
      new RegExp(String.raw`^price (.+?) ${money}$`),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (!m) continue;
      const target = cleanTarget(m[1]);
      const price = Number(m[2]);
      if (target && Number.isFinite(price)) {
        return {
          kind: "set_price",
          target,
          price: Math.round(price * 100) / 100,
        };
      }
    }
  }

  // Back in stock.
  {
    const patterns = [
      /^(?:un-?86|bring back|put back|restock|unblock|turn on|reactivate)(?: on)? (.+)$/,
      /^(?:bring|put) (.+?) back(?: on)?(?: the menu)?$/,
      /^(?:mark|set|make) (.+?) (?:as )?(?:available|back|in stock)(?: again)?$/,
      /^(.+?)(?: is| are|'s|'re) (?:back|available|back on|back in stock|in stock)(?: again| now)?$/,
      /^(.+?) back on(?: the menu)?$/,
      // "Noodles available", "naan back in stock": said without the verb.
      /^(.+?) (?:available|back in stock|in stock|restocked)(?: again| now)?$/,
      /^(.+?) (?:back)(?: again| now)?$/,
      /^we (?:have|got) (.+?) (?:again|back)$/,
      /^(?:got|have) (.+?) back$/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const intent = back(m[1]);
        if (intent) return intent;
      }
    }
  }

  // Sold out.
  {
    const patterns = [
      /^(?:86|86'd|eighty-?six|eighty six) (.+)$/,
      /^(?:mark|set|make) (.+?) (?:as )?(?:sold out|86'?d|unavailable|out)\b.*$/,
      /^(?:we'?re|we are|we have run|we've run|we ran|ran|run|i'?m|kitchen is|all) ?out of (.+)$/,
      /^out of (.+)$/,
      /^no more (.+)$/,
      /^sold out (?:of |on )?(.+)$/,
      /^(.+?)(?: is| are|'s|'re| has| have) (?:sold out|86'?d|out|run out|finished|all gone|gone|unavailable)\b.*$/,
      /^(.+?) (?:sold out|86'?d|out)\b.*$/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const intent = soldOut(m[1], text);
        if (intent) return intent;
      }
    }
  }

  return { kind: "unknown" };
}
