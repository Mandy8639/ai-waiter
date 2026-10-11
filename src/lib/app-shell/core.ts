/**
 * "App mode": the site running inside the Tableside store apps (the
 * Android Trusted Web Activity in android/, and the iOS Capacitor app in
 * ios/) rather than in a browser.
 *
 * Why it matters: Apple's App Store Review Guideline 3.1.1 and Google
 * Play's Payments policy don't allow an app to sell a digital
 * subscription through anything but their own billing. Tableside's own
 * plans are sold through Stripe on the Payments page, so inside the store
 * apps there are no plan purchase controls, no links out to them, and no
 * pricing page. Owners change plans on the website, as before. Diners
 * paying a restaurant for food is unaffected: physical goods may use any
 * payment method.
 *
 * How the apps say so:
 *   - both open their start URL with `?app=android` / `?app=ios`, which the
 *     proxy remembers in a cookie (src/proxy.ts), so later pages know too;
 *   - the iOS app also adds "TablesideApp/ios" to its user agent
 *     (capacitor.config.ts), which no browser sends.
 *
 * Not a security boundary: anyone can set the cookie. It only hides
 * controls, and setting it yourself only hides them from yourself.
 *
 * No `server-only` import: unit-tested directly, per the extract-the-core
 * convention.
 */

export type AppShell = "android" | "ios";

export const APP_SHELL_COOKIE = "tableside_app";
export const APP_SHELL_QUERY = "app";
export const IOS_USER_AGENT_MARK = "TablesideApp/ios";

export function parseAppShell(
  value: string | null | undefined,
): AppShell | null {
  return value === "android" || value === "ios" ? value : null;
}

/**
 * Which store app, if any, a request comes from. The query parameter wins
 * (it's the app announcing itself on launch), then the remembered cookie,
 * then the iOS user agent mark.
 */
export function appShellFrom({
  query,
  cookie,
  userAgent,
}: {
  query?: string | null;
  cookie?: string | null;
  userAgent?: string | null;
}): AppShell | null {
  return (
    parseAppShell(query) ??
    parseAppShell(cookie) ??
    (userAgent?.includes(IOS_USER_AGENT_MARK) ? "ios" : null)
  );
}

/** Whether Tableside's own plans may be offered for purchase here. */
export function canSellPlans(shell: AppShell | null): boolean {
  return shell === null;
}

/**
 * Pages the store apps shouldn't show. The landing page carries plan
 * prices and a sign-up pitch, so in an app it goes to the dashboard
 * instead (which itself sends a signed-out visitor to sign in).
 */
export function appShellRedirect(
  pathname: string,
  shell: AppShell | null,
): string | null {
  if (shell && pathname === "/") return "/dashboard";
  return null;
}
