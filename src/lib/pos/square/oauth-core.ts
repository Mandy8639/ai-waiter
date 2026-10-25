/**
 * Square OAuth rules, pure: where to send the owner, what to ask for, and
 * when a token needs refreshing. No `server-only`, no env, no fetch, so
 * it is unit-tested (tests/unit/square-connection.test.ts); api.ts does
 * the I/O.
 */

export type SquareEnvironment = "sandbox" | "production";

/** Square's API version this code was written against. */
export const SQUARE_API_VERSION = "2026-09-16";

export function squareBaseUrl(environment: SquareEnvironment): string {
  return environment === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

/**
 * What Tableside asks a restaurant's Square account for, and why:
 * - MERCHANT_PROFILE_READ: list locations, so the owner can pick one.
 * - ITEMS_READ: import the menu.
 * - ORDERS_READ / ORDERS_WRITE: put Tableside orders into Square.
 * - PAYMENTS_READ / PAYMENTS_WRITE: take diners' payments through Square.
 * - PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS: collect Tableside's fee on those
 *   payments (app_fee_money), which Square requires its own permission for.
 * Asked for up front so phases 2 and 3 don't send every owner back
 * through Square's consent screen.
 */
export const SQUARE_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ITEMS_READ",
  "ORDERS_READ",
  "ORDERS_WRITE",
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
  "PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS",
] as const;

export function squareAuthorizeUrl(args: {
  environment: SquareEnvironment;
  applicationId: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL("/oauth2/authorize", squareBaseUrl(args.environment));
  url.searchParams.set("client_id", args.applicationId);
  url.searchParams.set("scope", SQUARE_SCOPES.join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("redirect_uri", args.redirectUri);
  // Production only: ask Square to show the consent screen every time,
  // never silently reuse an earlier grant for a different restaurant
  // signed in on the same browser. (Square ignores it in the sandbox.)
  if (args.environment === "production") {
    url.searchParams.set("session", "false");
  }
  return url.toString();
}

export interface SquareTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  merchantId: string;
}

/** Square's ObtainToken response, reduced to what Tableside keeps. */
export function parseTokenResponse(body: unknown): SquareTokens {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.access_token !== "string" || typeof b.merchant_id !== "string") {
    throw new Error("Square did not return a token");
  }
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" ? b.refresh_token : null,
    expiresAt: typeof b.expires_at === "string" ? b.expires_at : null,
    merchantId: b.merchant_id,
  };
}

/**
 * Refresh a week before expiry. Square access tokens last 30 days, and
 * the margin means a restaurant that doesn't sync for a while still finds
 * a working token on a Friday night rather than an expired one.
 */
export const REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

export function needsRefresh(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry - now.getTime() < REFRESH_MARGIN_MS;
}

/**
 * The state value is compared against an httpOnly cookie on the way back,
 * and carries the restaurant so the callback knows which one to connect.
 * The callback still re-checks that the signed-in user manages it.
 */
export function buildState(restaurantId: string, nonce: string): string {
  return `${restaurantId}.${nonce}`;
}

export function parseState(
  state: string | null,
  cookieValue: string | undefined,
): { restaurantId: string } | null {
  if (!state || !cookieValue || state !== cookieValue) return null;
  const [restaurantId, nonce] = state.split(".");
  if (!restaurantId || !nonce) return null;
  return { restaurantId };
}

/**
 * Square is usable on this deployment: an application id and secret, and
 * a token encryption key that's really 32 bytes. Booleans only, so the
 * health check can report it without revealing anything.
 */
export function squareReady(env: Record<string, string | undefined>): boolean {
  if (!env.SQUARE_APPLICATION_ID || !env.SQUARE_APPLICATION_SECRET)
    return false;
  const key = env.POS_TOKEN_ENCRYPTION_KEY;
  return Boolean(key) && Buffer.from(key!, "base64").length === 32;
}
