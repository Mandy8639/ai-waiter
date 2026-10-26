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
 * - DEVICE_CREDENTIAL_MANAGEMENT: pair a Square Terminal (phase 3), which
 *   the Devices API won't do without it.
 * Connections made before phase 3 lack the last one; the settings page
 * asks those owners to reconnect before pairing a Terminal.
 */
export const SQUARE_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ITEMS_READ",
  "ORDERS_READ",
  "ORDERS_WRITE",
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
  "PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS",
  "DEVICE_CREDENTIAL_MANAGEMENT",
] as const;

/** Whether a connection's recorded scopes allow pairing a Terminal. */
export function canPairTerminals(scopes: string | null | undefined): boolean {
  return (scopes ?? "").split(" ").includes("DEVICE_CREDENTIAL_MANAGEMENT");
}

/**
 * Square's sandbox Terminals: fake device ids that complete a checkout
 * without hardware (developer.squareup.com/docs/devtools/sandbox/testing).
 * Offered on the settings page only when SQUARE_ENVIRONMENT is sandbox.
 * Square only completes sandbox Terminal checkouts up to $25.
 */
export const SQUARE_TEST_TERMINALS = [
  {
    deviceId: "9fa747a2-25ff-48ee-b078-04381f7c828f",
    name: "Square test Terminal (card, no tip)",
  },
  {
    deviceId: "22cd266c-6246-4c06-9983-67f0c26346b0",
    name: "Square test Terminal (card + 20% tip)",
  },
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

/**
 * Square can settle payments on this deployment: the webhook's signature
 * key and the exact notification URL registered with Square are set.
 */
export function squareWebhookReady(
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(env.SQUARE_WEBHOOK_SIGNATURE_KEY && env.SQUARE_WEBHOOK_URL);
}
