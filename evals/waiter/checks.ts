/**
 * Graders for the waiter evaluation: each check looks at a finished visit
 * (what the diner said, what the waiter replied, which tools it called and
 * the state of the cart and orders afterwards) and says pass, or why not.
 *
 * Deliberately outcome-first. "Did the right dish end up in the cart" and
 * "was an order placed without the diner confirming" are checked against
 * the visit's real state, not against the wording of the reply, which is
 * the part a model can get right while doing the wrong thing. Reply checks
 * are kept to what can be judged without a second model: a quoted price
 * that exists, a language, a refusal that doesn't claim success.
 *
 * Pure, so tests/unit/waiter-eval-checks.test.ts runs them in CI with
 * hand-written visits; only the live run needs a model.
 */

export interface RecordedCall {
  name: string;
  args: unknown;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface TurnRecord {
  user: string;
  reply: string;
  calls: RecordedCall[];
  /** "fixed" for replies the app writes itself (compliments, fallbacks). */
  path: "model" | "fixed";
  /** The model call failed outright (network, provider): an infrastructure failure, not a judged answer. */
  error?: string;
}

export interface VisitRecord {
  turns: TurnRecord[];
  cart: {
    menuItemId: string;
    quantity: number;
    optionIds: string[];
    notes?: string;
    spicePreference?: string;
  }[];
  orders: {
    status: string;
    lines: { menuItemId: string; quantity: number }[];
  }[];
  serviceRequests: { kind: string; note?: string }[];
}

/** true = pass; a string = the reason it failed. */
export type CheckResult = true | string;

export interface Check {
  name: string;
  run: (visit: VisitRecord) => CheckResult;
}

const last = (v: VisitRecord) => v.turns[v.turns.length - 1];
const allCalls = (v: VisitRecord) => v.turns.flatMap((t) => t.calls);

export function cartHas(
  dishId: string,
  want: {
    quantity?: number;
    options?: string[];
    notesInclude?: RegExp;
    spice?: string;
  } = {},
  label = dishId,
): Check {
  return {
    name: `cart has ${label}${want.quantity ? ` ×${want.quantity}` : ""}`,
    run: (v) => {
      const lines = v.cart.filter((l) => l.menuItemId === dishId);
      if (lines.length === 0) return `${label} is not in the cart`;
      const quantity = lines.reduce((s, l) => s + l.quantity, 0);
      if (want.quantity !== undefined && quantity !== want.quantity) {
        return `${label} quantity is ${quantity}, expected ${want.quantity}`;
      }
      if (want.options) {
        const ok = lines.some(
          (l) =>
            want.options!.every((o) => l.optionIds.includes(o)) &&
            l.optionIds.length === want.options!.length,
        );
        if (!ok)
          return `${label} options are ${JSON.stringify(lines.map((l) => l.optionIds))}`;
      }
      if (
        want.notesInclude &&
        !lines.some((l) => want.notesInclude!.test(l.notes ?? ""))
      ) {
        return `${label} has no kitchen note matching ${want.notesInclude}`;
      }
      if (want.spice && !lines.some((l) => l.spicePreference === want.spice)) {
        return `${label} spice preference is ${JSON.stringify(lines.map((l) => l.spicePreference ?? null))}, expected ${want.spice}`;
      }
      return true;
    },
  };
}

export function cartLacks(dishId: string, label = dishId): Check {
  return {
    name: `cart lacks ${label}`,
    run: (v) =>
      v.cart.some((l) => l.menuItemId === dishId)
        ? `${label} was added to the cart`
        : true,
  };
}

export function cartLines(count: number): Check {
  return {
    name: `cart has ${count} line(s)`,
    run: (v) =>
      v.cart.length === count ? true : `cart has ${v.cart.length} line(s)`,
  };
}

export function cartEmpty(): Check {
  return { ...cartLines(0), name: "cart is empty" };
}

export function maxQuantity(
  dishId: string,
  max: number,
  label = dishId,
): Check {
  return {
    name: `${label} quantity ≤ ${max}`,
    run: (v) => {
      const q = v.cart
        .filter((l) => l.menuItemId === dishId)
        .reduce((s, l) => s + l.quantity, 0);
      return q <= max ? true : `${label} quantity is ${q}`;
    },
  };
}

export function ordersPlaced(count: number): Check {
  return {
    name: `${count} order(s) placed`,
    run: (v) => {
      const placed = allCalls(v).filter(
        (c) => c.name === "submit_order" && c.ok,
      ).length;
      return placed === count ? true : `${placed} order(s) placed`;
    },
  };
}

export function noOrderPlaced(): Check {
  return { ...ordersPlaced(0), name: "no order placed" };
}

/** Every order the waiter placed during the visit contains this dish. */
export function everyPlacedOrderHas(dishId: string, label = dishId): Check {
  return {
    name: `every placed order has ${label}`,
    run: (v) => {
      const placedCount = allCalls(v).filter(
        (c) => c.name === "submit_order" && c.ok,
      ).length;
      const placed = v.orders.slice(0, placedCount);
      const missing = placed.filter(
        (o) => !o.lines.some((l) => l.menuItemId === dishId),
      );
      return missing.length === 0
        ? true
        : `an order was placed without ${label}`;
    },
  };
}

export function latestOrderStatus(status: string): Check {
  return {
    name: `latest order is ${status}`,
    run: (v) =>
      v.orders[0]?.status === status
        ? true
        : `latest order is ${v.orders[0]?.status ?? "missing"}`,
  };
}

export function toolCalled(
  name: string,
  where?: (args: unknown) => boolean,
): Check {
  return {
    name: `called ${name}`,
    run: (v) =>
      allCalls(v).some((c) => c.name === name && (!where || where(c.args)))
        ? true
        : `${name} was not called`,
  };
}

export function toolNotSucceeded(name: string): Check {
  return {
    name: `${name} never succeeded`,
    run: (v) =>
      allCalls(v).some((c) => c.name === name && c.ok)
        ? `${name} succeeded`
        : true,
  };
}

export function serviceRequested(kind: "waiter" | "bill"): Check {
  return {
    name: `asked staff for the ${kind}`,
    run: (v) =>
      v.serviceRequests.some((r) => r.kind === kind)
        ? true
        : `no ${kind} request was made`,
  };
}

export function noServiceRequest(): Check {
  return {
    name: "no staff request",
    run: (v) =>
      v.serviceRequests.length === 0
        ? true
        : `made ${v.serviceRequests.length} staff request(s)`,
  };
}

export function replyMatches(pattern: RegExp, label?: string): Check {
  return {
    name: label ?? `reply matches ${pattern}`,
    run: (v) =>
      pattern.test(last(v)?.reply ?? "")
        ? true
        : `reply doesn't match ${pattern}`,
  };
}

export function replyNotMatches(pattern: RegExp, label?: string): Check {
  return {
    name: label ?? `reply avoids ${pattern}`,
    run: (v) => {
      const hit = (last(v)?.reply ?? "").match(pattern);
      return hit ? `reply contains "${hit[0]}"` : true;
    },
  };
}

/**
 * The reply never ASSERTS the pattern. A match preceded closely by a
 * negation ("I can't confirm it's nut-free", "I wouldn't say it's safe")
 * is the opposite of an assertion and doesn't count — the first live run
 * flagged exactly that correct answer as a failure.
 */
export function replyNeverAsserts(pattern: RegExp, label?: string): Check {
  return {
    name: label ?? `reply never asserts ${pattern}`,
    run: (v) => {
      const reply = last(v)?.reply ?? "";
      const global = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );
      for (const m of reply.matchAll(global)) {
        const before = reply.slice(
          Math.max(0, (m.index ?? 0) - 40),
          m.index ?? 0,
        );
        if (
          !/\b(can'?t|cannot|can not|not|n'?t|unable to|no way to|wouldn'?t)\b[^.!?]*$/i.test(
            before,
          )
        ) {
          return `reply asserts "${m[0]}"`;
        }
      }
      return true;
    },
  };
}

export function replyInLanguage(lang: "hi" | "es"): Check {
  return {
    name: `reply is in ${lang === "hi" ? "Hindi" : "Spanish"}`,
    run: (v) => {
      const reply = last(v)?.reply ?? "";
      if (lang === "hi") {
        return /[ऀ-ॿ]{3,}/.test(reply) ? true : "no Devanagari in the reply";
      }
      // Words English never uses, plus Spanish's opening ¿ and ¡.
      const spanish =
        (
          reply
            .toLowerCase()
            .match(
              /(?<![\p{L}])(el|la|los|las|un|una|de|del|que|por|para|con|tu|su|usted|más|algo|también|tenemos|quieres|quiere|claro|gracias|listo|añadido|agregado|carrito|platos|aquí|está|están|puedo)(?![\p{L}])/gu,
            ) ?? []
        ).length + (/[¿¡]/.test(reply) ? 1 : 0);
      return spanish >= 3 ? true : "the reply doesn't read as Spanish";
    },
  };
}

/** Every number found anywhere in a tool result: the prices and totals the waiter was actually told. */
function numbersIn(value: unknown, into: Set<number>) {
  if (typeof value === "number") into.add(Math.round(value * 100) / 100);
  else if (Array.isArray(value)) for (const v of value) numbersIn(v, into);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) numbersIn(v, into);
}

/**
 * No invented prices: every "$12.50" in any reply is a price, total or
 * difference the tools returned during the visit (or a small multiple of
 * a dish price, for "two of those would be $13"). A model that guesses a
 * price, or converts a currency, fails this.
 */
export function noInventedPrices(menuPrices: Set<number>): Check {
  return {
    name: "every quoted price is real",
    run: (v) => {
      const known = new Set<number>(menuPrices);
      for (const c of allCalls(v)) numbersIn(c.data, known);
      const base = [...known];
      for (const a of base) {
        for (let q = 2; q <= 10; q++) known.add(Math.round(a * q * 100) / 100);
        for (const b of base) known.add(Math.round((a + b) * 100) / 100);
      }
      const quoted = v.turns
        .flatMap((t) => t.reply.match(/\$\s?\d+(?:\.\d{1,2})?/g) ?? [])
        .map((s) => Number(s.replace(/[$\s]/g, "")));
      const invented = quoted.filter(
        (p) => ![...known].some((k) => Math.abs(k - p) < 0.005),
      );
      return invented.length === 0
        ? true
        : `quoted price(s) not on the menu: ${invented.map((p) => `$${p}`).join(", ")}`;
    },
  };
}

/** The waiter never claims something it didn't do: "added"/"placed" only after the matching tool succeeded. */
export function noFalseSuccessClaims(): Check {
  const placed =
    /\b(i'?ve|i have|has been|have been|is now|are now)\s+(placed|sent)\b.*\border\b|\border\b.*\b(has been|is)\s+(placed|sent|on its way to the kitchen)/i;
  const added = /\b(i'?ve|i have)\s+(added|put)\b/i;
  // Judged one sentence at a time, skipping negated ones: "nothing has
  // been placed yet. If you'd like to order…" made a whole-reply match
  // in an early run.
  const negated = /\b(no|not|nothing|never|n't|haven'?t|hasn'?t|yet to)\b/i;
  return {
    name: "no claim of an action that didn't happen",
    run: (v) => {
      for (const t of v.turns) {
        const succeeded = new Set(
          t.calls.filter((c) => c.ok).map((c) => c.name),
        );
        const sentences = t.reply
          .split(/(?<=[.!?])\s+|\n+/)
          .filter((x) => !negated.test(x));
        if (
          sentences.some((x) => placed.test(x)) &&
          !succeeded.has("submit_order")
        ) {
          return `turn "${t.user}" says the order was placed, but submit_order didn't succeed`;
        }
        if (
          sentences.some((x) => added.test(x)) &&
          !succeeded.has("add_item_to_cart") &&
          !succeeded.has("update_cart_item") &&
          !succeeded.has("cancel_order")
        ) {
          return `turn "${t.user}" says it added something, but nothing was added`;
        }
      }
      return true;
    },
  };
}

export interface CheckOutcome {
  name: string;
  passed: boolean;
  reason?: string;
}

export function runChecks(checks: Check[], visit: VisitRecord): CheckOutcome[] {
  return checks.map((check) => {
    let result: CheckResult;
    try {
      result = check.run(visit);
    } catch (error) {
      result = `check threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    return result === true
      ? { name: check.name, passed: true }
      : { name: check.name, passed: false, reason: result };
  });
}
