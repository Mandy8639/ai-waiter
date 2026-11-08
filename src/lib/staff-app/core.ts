/**
 * The staff app (Tableside for Restaurants), inside the product: when the
 * dashboard suggests it, what it says, and which store a phone belongs to
 * (for tableside.menu/get-app). Pure (tests/unit/staff-app-core.test.ts).
 */

export type StaffRole = "owner" | "manager" | "staff" | "kitchen";

/**
 * Whether the dashboard shows the "get the app" nudge (before the
 * per-device "Not now", which the browser remembers). Never inside the app
 * itself, never to someone whose phone already has app alerts set up, and
 * never on top of the two-step reminder: security first, one banner at a
 * time.
 */
export function shouldOfferStaffApp(input: {
  inApp: boolean;
  hasAppOnAPhone: boolean;
  twoFactorReminderShown: boolean;
}): boolean {
  return !input.inApp && !input.hasAppOnAPhone && !input.twoFactorReminderShown;
}

/** The nudge's headline and line, by what the person does. */
export function staffAppPitch(role: StaffRole): {
  title: string;
  body: string;
} {
  if (role === "kitchen" || role === "staff") {
    return {
      title: "Get new orders on your phone.",
      body: "The Tableside app alerts you to every new order and table request, even when the phone is locked. Sign in with this same account.",
    };
  }
  return {
    title: "Get order alerts and the kitchen board on your phone.",
    body: "The Tableside app rings for every new order, even when the phone is locked. Sign in with this same account.",
  };
}

/** Which store a visitor's device uses, from its user agent; null for a computer. */
export function storeForUserAgent(
  userAgent: string | null | undefined,
): "ios" | "android" | null {
  const ua = userAgent ?? "";
  if (/android/i.test(ua)) return "android";
  // A Mac user agent with "Mobile" in it is an iPad in mobile mode. An iPad
  // asking for the desktop site looks like a Mac and gets the page with
  // both badges, which works too.
  if (
    /iphone|ipad|ipod/i.test(ua) ||
    (/macintosh/i.test(ua) && /mobile/i.test(ua))
  ) {
    return "ios";
  }
  return null;
}

/** How long "Not now" hides the nudge on that device. */
export const STAFF_APP_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
