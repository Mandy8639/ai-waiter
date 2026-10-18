import { formatBackAt } from "@/lib/menu/sold-out-core";
import type { StaffAction, StaffIntent } from "./intent";
import {
  matchLabel,
  normalizeName,
  resolveTarget,
  type Catalog,
  type Match,
} from "./resolve-core";

/**
 * From a reading of the command to what happens: run it, ask first, ask
 * which one, answer, or refuse — and, after it runs, what to say and how
 * to undo it. Every sentence here describes a change the server has made
 * or is asking about; the model never writes the reply. No `server-only`,
 * per the extract-the-core convention.
 */

export type StaffRole = "owner" | "manager" | "kitchen" | "staff";

/** Who may do what: the same lines the database draws. */
const KITCHEN_SIDE: readonly StaffRole[] = ["owner", "manager", "kitchen"];
const MANAGERS: readonly StaffRole[] = ["owner", "manager"];

/** The kitchen's current pause and running-behind state. */
export interface KitchenState {
  /** ISO, "infinity" for until resumed, or null when not paused. */
  pausedUntil: string | null;
  busyExtraMinutes: number;
}

export interface PlanContext {
  catalog: Catalog;
  role: StaffRole;
  state: KitchenState;
  /** "ai": read by the model, so always confirmed before it runs. */
  source: "rules" | "ai" | "button";
  timeZone: string;
  now?: Date;
  /**
   * Whether any published menu has opening hours. Without them "the next
   * opening" is 4 AM, which is worth saying out loud.
   */
  hasMenuHours?: boolean;
}

export interface ReplyButton {
  label: string;
  action: StaffAction;
  /** Sent back as already confirmed: a Yes, or an Undo the person pressed. */
  confirmed: boolean;
  variant: "primary" | "secondary";
}

export type Plan =
  | { type: "run"; action: StaffAction }
  | { type: "confirm"; text: string; action: StaffAction }
  | { type: "choose"; text: string; buttons: ReplyButton[] }
  | { type: "answered"; text: string }
  | { type: "refused"; text: string }
  | { type: "not_found"; text: string }
  | { type: "not_understood"; text: string };

/** The busy-mode limits, as pause_new_orders() and set_kitchen_busy() enforce them. */
export const PAUSE_MINUTES = { min: 5, max: 720 } as const;
export const BUSY_MINUTES = { min: 5, max: 120 } as const;

export const HELP_TEXT = [
  "Try one of these:",
  "• 86 the salmon — sold out until you next open",
  "• The oat milk is out",
  "• The salmon is back",
  "• Pause ordering for an hour / Resume ordering",
  "• We're slammed, add 15 minutes / Back to normal",
  "• Make the mango lassi $5.50 (owners and managers; asks first)",
  "• What's sold out?",
].join("\n");

const NOT_UNDERSTOOD = `Sorry, I didn't catch that, and I haven't changed anything.\n\n${HELP_TEXT}`;

export function money(price: number): string {
  return `$${price.toFixed(2)}`;
}

function clock(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

function dishById(catalog: Catalog, id: string) {
  return catalog.dishes.find((d) => d.id === id);
}

function optionsByIds(catalog: Catalog, ids: string[]) {
  const set = new Set(ids);
  return catalog.options.filter((o) => set.has(o.id));
}

function optionsLabel(catalog: Catalog, ids: string[]): string {
  const options = optionsByIds(catalog, ids);
  if (options.length === 0) return "those add-ons";
  return matchLabel({ type: "options", name: options[0].name, options });
}

/** "mark Grilled salmon sold out until you next open". */
export function describeAction(action: StaffAction, catalog: Catalog): string {
  switch (action.kind) {
    case "dish_sold_out": {
      const name = dishById(catalog, action.dishId)?.name ?? "that dish";
      return action.until === "next_opening"
        ? `mark ${name} sold out until you next open`
        : `mark ${name} sold out until someone brings it back`;
    }
    case "dish_back":
      return `bring ${dishById(catalog, action.dishId)?.name ?? "that dish"} back on the menu`;
    case "options_sold_out":
      return `mark ${optionsLabel(catalog, action.optionIds)} sold out`;
    case "options_back":
      return `bring ${optionsLabel(catalog, action.optionIds)} back`;
    case "pause":
      return action.minutes === null
        ? "pause new orders until someone resumes them"
        : `pause new orders for ${duration(action.minutes)}`;
    case "resume":
      return "resume new orders";
    case "busy":
      return action.extraMinutes === 0
        ? "clear the extra wait time"
        : `tell diners food is taking ${action.extraMinutes} minutes longer`;
    case "set_price": {
      const dish = dishById(catalog, action.dishId);
      return dish
        ? `change ${dish.name} from ${money(dish.price)} to ${money(action.price)}`
        : `change that dish's price to ${money(action.price)}`;
    }
  }
}

function duration(minutes: number): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "an hour" : `${h} hours`;
  }
  if (minutes > 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${minutes} minutes`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function needsManager(action: StaffAction): boolean {
  return action.kind === "set_price";
}

/** Checks that apply however the action arrived: role, limits, and that every id is this restaurant's. */
function check(action: StaffAction, ctx: PlanContext): Plan | null {
  const allowed = needsManager(action) ? MANAGERS : KITCHEN_SIDE;
  if (!allowed.includes(ctx.role)) {
    return {
      type: "refused",
      text: needsManager(action)
        ? "Only an owner or manager can change prices. Nothing was changed."
        : "Only the kitchen or a manager can change this. Nothing was changed.",
    };
  }
  const missing = {
    type: "not_found" as const,
    text: "That's no longer on your menu. Nothing was changed.",
  };
  switch (action.kind) {
    case "dish_sold_out":
    case "dish_back":
    case "set_price":
      if (!dishById(ctx.catalog, action.dishId)) return missing;
      break;
    case "options_sold_out":
    case "options_back":
      if (
        optionsByIds(ctx.catalog, action.optionIds).length !==
        new Set(action.optionIds).size
      ) {
        return missing;
      }
      break;
    case "pause":
      if (
        action.minutes !== null &&
        (action.minutes < PAUSE_MINUTES.min ||
          action.minutes > PAUSE_MINUTES.max)
      ) {
        return {
          type: "refused",
          text: "Ordering can be paused for 5 minutes up to 12 hours, or until you resume it. Nothing was changed.",
        };
      }
      break;
    case "busy":
      if (
        action.extraMinutes !== 0 &&
        (action.extraMinutes < BUSY_MINUTES.min ||
          action.extraMinutes > BUSY_MINUTES.max)
      ) {
        return {
          type: "refused",
          text: "The extra wait can be 5 to 120 minutes. Nothing was changed.",
        };
      }
      break;
  }
  return null;
}

/**
 * A resolved action: run it, or ask first. Prices always ask; anything the
 * model read asks; a button that already said yes doesn't ask again.
 */
export function planAction(
  action: StaffAction,
  ctx: PlanContext,
  { confirmed }: { confirmed: boolean },
): Plan {
  const problem = check(action, ctx);
  if (problem) return problem;

  if (action.kind === "set_price") {
    const dish = dishById(ctx.catalog, action.dishId)!;
    if (Math.abs(dish.price - action.price) < 0.005) {
      return {
        type: "answered",
        text: `${dish.name} is already ${money(dish.price)}. Nothing was changed.`,
      };
    }
  }

  const askFirst =
    !confirmed && (action.kind === "set_price" || ctx.source === "ai");
  if (askFirst) {
    const what = describeAction(action, ctx.catalog);
    return {
      type: "confirm",
      text:
        ctx.source === "ai"
          ? `I think you want me to ${what}. Should I?`
          : `${capitalize(what)}?`,
      action,
    };
  }
  return { type: "run", action };
}

function actionForMatch(
  intent: Extract<StaffIntent, { kind: "sold_out" | "back" | "set_price" }>,
  match: Match,
): StaffAction {
  if (intent.kind === "set_price") {
    // resolveTarget(dishesOnly) only ever returns dishes here.
    return {
      kind: "set_price",
      dishId: match.type === "dish" ? match.dish.id : "",
      price: intent.price,
    };
  }
  if (match.type === "dish") {
    return intent.kind === "sold_out"
      ? { kind: "dish_sold_out", dishId: match.dish.id, until: intent.until }
      : { kind: "dish_back", dishId: match.dish.id };
  }
  const optionIds = match.options.map((o) => o.id);
  return intent.kind === "sold_out"
    ? { kind: "options_sold_out", optionIds }
    : { kind: "options_back", optionIds };
}

/** From a reading of what was typed to a plan. */
export function planIntent(intent: StaffIntent, ctx: PlanContext): Plan {
  switch (intent.kind) {
    case "unknown":
      return { type: "not_understood", text: NOT_UNDERSTOOD };
    case "help":
      return { type: "answered", text: HELP_TEXT };
    case "status":
      return { type: "answered", text: statusText(ctx) };
    case "pause":
      return planAction({ kind: "pause", minutes: intent.minutes }, ctx, {
        confirmed: false,
      });
    case "resume":
      if (!isPaused(ctx.state, ctx.now)) {
        return {
          type: "answered",
          text: "New orders aren't paused. Nothing was changed.",
        };
      }
      return planAction({ kind: "resume" }, ctx, { confirmed: false });
    case "busy":
      return planAction(
        { kind: "busy", extraMinutes: intent.extraMinutes },
        ctx,
        { confirmed: false },
      );
    case "busy_off":
      if (ctx.state.busyExtraMinutes === 0) {
        return {
          type: "answered",
          text: "There's no extra wait time on. Nothing was changed.",
        };
      }
      return planAction({ kind: "busy", extraMinutes: 0 }, ctx, {
        confirmed: false,
      });
    case "sold_out":
    case "back":
    case "set_price": {
      const resolution = resolveTarget(ctx.catalog, intent.target, {
        dishesOnly: intent.kind === "set_price",
        prefer: (m) => {
          const available =
            m.type === "dish"
              ? m.dish.available
              : m.options.some((o) => o.available);
          const off =
            m.type === "dish"
              ? !m.dish.available
              : m.options.some((o) => !o.available);
          return intent.kind === "sold_out"
            ? available
            : intent.kind === "back"
              ? off
              : false;
        },
      });
      if (resolution.type === "none" && resolution.closest.length > 0) {
        return {
          type: "choose",
          text: `I couldn't find "${intent.target}". Did you mean one of these? Nothing has been changed yet.`,
          buttons: resolution.closest.map((m) => ({
            label: matchLabel(m),
            action: actionForMatch(intent, m),
            confirmed: false,
            variant: "secondary",
          })),
        };
      }
      if (resolution.type === "none") {
        return {
          type: "not_found",
          text: `I couldn't find "${intent.target}" on your menu${intent.kind === "set_price" ? "" : " or its add-ons"}. Nothing was changed.`,
        };
      }
      if (resolution.type === "several") {
        const shown = resolution.matches.slice(0, 6);
        return {
          type: "choose",
          text: `Which one? Several things match "${intent.target}". Nothing has been changed yet.`,
          buttons: shown.map((m) => ({
            label: matchLabel(m),
            action: actionForMatch(intent, m),
            confirmed: false,
            variant: "secondary",
          })),
        };
      }
      return planAction(actionForMatch(intent, resolution.match), ctx, {
        confirmed: false,
      });
    }
  }
}

export function isPaused(state: KitchenState, now: Date = new Date()): boolean {
  if (!state.pausedUntil) return false;
  if (state.pausedUntil === "infinity") return true;
  return new Date(state.pausedUntil).getTime() > now.getTime();
}

/** What's sold out, and whether ordering is paused or running behind. */
export function statusText(ctx: PlanContext): string {
  const now = ctx.now ?? new Date();
  const lines: string[] = [];
  if (isPaused(ctx.state, now)) {
    lines.push(
      ctx.state.pausedUntil === "infinity"
        ? "New orders are paused until someone resumes them."
        : `New orders are paused until ${clock(ctx.state.pausedUntil!, ctx.timeZone)}.`,
    );
  }
  if (ctx.state.busyExtraMinutes > 0) {
    lines.push(
      `Diners are told food is taking ${ctx.state.busyExtraMinutes} minutes longer.`,
    );
  }
  const dishes = ctx.catalog.dishes.filter((d) => !d.available);
  const options = ctx.catalog.options.filter((o) => !o.available);
  if (dishes.length === 0 && options.length === 0) {
    lines.push("Nothing is sold out.");
  } else {
    lines.push("Sold out:");
    for (const d of dishes) {
      lines.push(
        `• ${d.name}${d.backAt ? ` — ${formatBackAt(d.backAt, ctx.timeZone, now).toLowerCase()}` : ""}`,
      );
    }
    const groups = new Map<string, typeof options>();
    // Grouped the way names are matched, so "Oat milk" and "Oat Milk" are one line.
    for (const o of options) {
      const key = normalizeName(o.name);
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    for (const list of groups.values()) {
      lines.push(
        `• ${matchLabel({ type: "options", name: list[0].name, options: list })}`,
      );
    }
  }
  return lines.join("\n");
}

/** What the server reports back after running an action. */
export interface RunResult {
  /** For dish_sold_out until next opening: when it comes back (ISO). */
  backAt?: string;
  /** For pause: when ordering resumes (ISO or "infinity"). */
  pausedUntil?: string;
}

/** The sentence after a change that succeeded. Only ever called with a real result. */
export function doneText(
  action: StaffAction,
  catalog: Catalog,
  result: RunResult,
  timeZone: string,
  now: Date = new Date(),
  { hasMenuHours = true }: { hasMenuHours?: boolean } = {},
): string {
  switch (action.kind) {
    case "dish_sold_out": {
      const name = dishById(catalog, action.dishId)?.name ?? "That dish";
      if (!result.backAt) {
        return `Done: ${name} is sold out until someone brings it back.`;
      }
      const done = `Done: ${name} is sold out. ${formatBackAt(result.backAt, timeZone, now)}, by itself.`;
      return hasMenuHours
        ? done
        : `${done}\n\nYour menu has no opening hours, so "tomorrow" starts at 4 AM. An owner or manager can set hours in Menu → Menus, and it will come back when you open instead.`;
    }
    case "dish_back":
      return `Done: ${dishById(catalog, action.dishId)?.name ?? "That dish"} is back on the menu.`;
    case "options_sold_out":
      return `Done: ${optionsLabel(catalog, action.optionIds)} sold out until someone brings it back.`;
    case "options_back":
      return `Done: ${optionsLabel(catalog, action.optionIds)} back on.`;
    case "pause":
      return !result.pausedUntil || result.pausedUntil === "infinity"
        ? "Done: new orders are paused until you resume them."
        : `Done: new orders are paused until ${clock(result.pausedUntil, timeZone)}. They start again by themselves.`;
    case "resume":
      return "Done: new orders are back on.";
    case "busy":
      return action.extraMinutes === 0
        ? "Done: the extra wait time is cleared."
        : `Done: diners are told food is taking ${action.extraMinutes} minutes longer, for the next hour.`;
    case "set_price": {
      const dish = dishById(catalog, action.dishId);
      return dish
        ? `Done: ${dish.name} is now ${money(action.price)} (was ${money(dish.price)}).`
        : `Done: the price is now ${money(action.price)}.`;
    }
  }
}

/**
 * The button that puts things back as they were before this change, from
 * the menu and kitchen state read just before it ran. Null when there's
 * nothing to put back.
 */
export function undoFor(
  action: StaffAction,
  before: { catalog: Catalog; state: KitchenState },
  now: Date = new Date(),
): ReplyButton | null {
  const button = (a: StaffAction): ReplyButton => ({
    label: "Undo",
    action: a,
    confirmed: true,
    variant: "secondary",
  });
  switch (action.kind) {
    case "dish_sold_out": {
      const dish = dishById(before.catalog, action.dishId);
      return dish?.available
        ? button({ kind: "dish_back", dishId: action.dishId })
        : null;
    }
    case "dish_back": {
      const dish = dishById(before.catalog, action.dishId);
      if (!dish || dish.available) return null;
      return button({
        kind: "dish_sold_out",
        dishId: action.dishId,
        until: dish.backAt ? "next_opening" : "manual",
      });
    }
    case "options_sold_out": {
      const ids = optionsByIds(before.catalog, action.optionIds)
        .filter((o) => o.available)
        .map((o) => o.id);
      return ids.length > 0
        ? button({ kind: "options_back", optionIds: ids })
        : null;
    }
    case "options_back": {
      const ids = optionsByIds(before.catalog, action.optionIds)
        .filter((o) => !o.available)
        .map((o) => o.id);
      return ids.length > 0
        ? button({ kind: "options_sold_out", optionIds: ids })
        : null;
    }
    case "pause":
    case "resume": {
      if (!isPaused(before.state, now)) {
        return action.kind === "pause" ? button({ kind: "resume" }) : null;
      }
      if (before.state.pausedUntil === "infinity") {
        return button({ kind: "pause", minutes: null });
      }
      const left = Math.ceil(
        (new Date(before.state.pausedUntil!).getTime() - now.getTime()) /
          60_000,
      );
      return left >= PAUSE_MINUTES.min
        ? button({ kind: "pause", minutes: Math.min(left, PAUSE_MINUTES.max) })
        : button({ kind: "resume" });
    }
    case "busy":
      return before.state.busyExtraMinutes === action.extraMinutes
        ? null
        : button({ kind: "busy", extraMinutes: before.state.busyExtraMinutes });
    case "set_price": {
      const dish = dishById(before.catalog, action.dishId);
      return dish
        ? {
            label: `Undo (back to ${money(dish.price)})`,
            action: { kind: "set_price", dishId: dish.id, price: dish.price },
            confirmed: true,
            variant: "secondary",
          }
        : null;
    }
  }
}

/** What the chat shows for one reply. */
export interface AssistantReply {
  text: string;
  tone: "done" | "info" | "question" | "error";
  buttons: ReplyButton[];
  /** A Yes/No question: "No" (and typing "no") cancels without a server call. */
  cancellable: boolean;
}

/** staff_assistant_commands.outcome for a plan that didn't run anything. */
export type PlanOutcome =
  | "confirm"
  | "choose"
  | "answered"
  | "refused"
  | "not_found"
  | "not_understood";

/** The reply for every plan except "run", which the server runs first. */
export function replyForPlan(
  plan: Exclude<Plan, { type: "run" }>,
): AssistantReply {
  switch (plan.type) {
    case "confirm":
      return {
        text: plan.text,
        tone: "question",
        buttons: [
          {
            label:
              plan.action.kind === "set_price"
                ? "Yes, change it"
                : "Yes, do it",
            action: plan.action,
            confirmed: true,
            variant: "primary",
          },
        ],
        cancellable: true,
      };
    case "choose":
      return {
        text: plan.text,
        tone: "question",
        buttons: plan.buttons,
        cancellable: true,
      };
    case "answered":
      return { text: plan.text, tone: "info", buttons: [], cancellable: false };
    case "refused":
    case "not_found":
      return {
        text: plan.text,
        tone: "error",
        buttons: [],
        cancellable: false,
      };
    case "not_understood":
      return { text: plan.text, tone: "info", buttons: [], cancellable: false };
  }
}
