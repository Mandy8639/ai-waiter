/**
 * What a restaurant's own staff are told about billing (pricing from
 * 2026-10-18: a free first month with no fee on card payments, then Starter
 * at $19/month plus 1%). The rules themselves are in the database
 * (20261018120000_free_month_then_starter.sql); this only words them.
 * No server-only import, so it is unit-tested directly.
 */

export type BillingState =
  "exempt" | "trial" | "subscribed" | "past_due" | "grace" | "lapsed";

export interface RestaurantBilling {
  state: BillingState;
  trialEndsAt: Date | null;
  /** When QR ordering pauses if nothing changes. */
  graceEndsAt: Date | null;
}

export interface BillingNotice {
  tone: "info" | "warning" | "danger";
  title: string;
  body: string;
  /** Where to choose or fix a plan; absent when it can't be offered. */
  action?: { href: string; label: string };
}

export const PLANS_PATH = "/dashboard/payments";

/** Within this many days of the free month ending, the reminder gets louder. */
export const TRIAL_REMINDER_DAYS = 7;

function formatDay(date: Date, timeZone?: string): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone,
  });
}

export function daysUntil(date: Date, now: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000));
}

/**
 * The banner for a dashboard page, or null when there is nothing to say.
 *
 * `canManage`: owners and managers, who can choose a plan. Everyone else
 * hears only what affects their shift (ordering paused).
 *
 * `canSell`: false inside the store apps, where plans can't be offered
 * for purchase (src/lib/app-shell/core.ts, Apple and Google billing
 * rules). There the notice states the facts with no price and no link.
 */
export function billingNotice(
  billing: RestaurantBilling | null,
  {
    canManage,
    canSell,
    timeZone,
  }: { canManage: boolean; canSell: boolean; timeZone?: string },
  now: Date = new Date(),
): BillingNotice | null {
  if (!billing) return null;
  const action =
    canManage && canSell
      ? { href: PLANS_PATH, label: "Choose a plan" }
      : undefined;

  switch (billing.state) {
    case "exempt":
    case "subscribed":
      return null;

    case "trial": {
      if (!canManage || !billing.trialEndsAt) return null;
      const days = daysUntil(billing.trialEndsAt, now);
      const day = formatDay(billing.trialEndsAt, timeZone);
      return {
        tone: days <= TRIAL_REMINDER_DAYS ? "warning" : "info",
        title:
          days <= TRIAL_REMINDER_DAYS
            ? `Your free month ends in ${days} ${days === 1 ? "day" : "days"}`
            : "Your first month is free",
        body: canSell
          ? `No fee on card payments until ${day}. After that, Starter is $19/month plus 1% of card payments.`
          : `Your free month ends on ${day}.`,
        action,
      };
    }

    case "past_due":
      if (!canManage) return null;
      return {
        tone: "warning",
        title: "Your last plan payment didn't go through",
        body: "Stripe will try your card again, and online ordering stays on meanwhile. Updating the card avoids any interruption.",
        action: canSell
          ? { href: PLANS_PATH, label: "See your plan" }
          : undefined,
      };

    case "grace": {
      const day = billing.graceEndsAt
        ? formatDay(billing.graceEndsAt, timeZone)
        : null;
      if (!canManage) {
        return day
          ? {
              tone: "warning",
              title: "Online ordering may pause soon",
              body: `QR ordering pauses on ${day} unless the restaurant's plan is set up. Ask the owner.`,
            }
          : null;
      }
      return {
        tone: "warning",
        title: "Your free month has ended",
        body: canSell
          ? `Choose a plan${day ? ` by ${day}` : ""} to keep QR ordering on. Starter is $19/month plus 1% of card payments.`
          : `QR ordering pauses${day ? ` on ${day}` : " soon"} unless a plan is set up.`,
        action,
      };
    }

    case "lapsed":
      return {
        tone: "danger",
        title: "QR ordering is paused",
        body: canManage
          ? canSell
            ? "Diners can still see your menu, but can't order from the table. Choose a plan to turn ordering back on straight away."
            : "Diners can still see your menu, but can't order from the table until a plan is set up."
          : "Diners can still see the menu, but can't order from the table. Ask the owner to set up the restaurant's plan.",
        action,
      };
  }
}

/**
 * For a subscription started during the free month: Stripe's `trial_end`
 * (seconds), so the first $19 is charged when the free month ends rather
 * than the day they subscribe. Stripe Checkout refuses a trial ending less
 * than 48 hours away, so inside that window billing simply starts now.
 */
export function stripeTrialEnd(
  trialEndsAt: Date | null,
  now: Date = new Date(),
): number | undefined {
  if (!trialEndsAt) return undefined;
  const minimum = now.getTime() + 48 * 60 * 60 * 1000 + 60_000;
  return trialEndsAt.getTime() > minimum
    ? Math.floor(trialEndsAt.getTime() / 1000)
    : undefined;
}
