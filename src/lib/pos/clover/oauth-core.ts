/**
 * Clover OAuth rules, pure: where to send the owner, which hosts to call,
 * and when a token needs refreshing. No `server-only`, no env, no fetch,
 * so it is unit-tested (tests/unit/clover-connection.test.ts); api.ts
 * does the I/O.
 *
 * Clover's v2 flow (docs.clover.com, "High-trust apps: Auth code flow"):
 * the owner signs in on Clover's /oauth/v2/authorize page, Clover sends
 * them back with `code` and `merchant_id`, and /oauth/v2/token trades the
 * code for an access token and a single-use refresh token, each with a
 * Unix-time expiry. Expiring tokens are required in every region.
 */

export type CloverEnvironment = "sandbox" | "production";

/** Where the owner signs in and approves (North America). */
export function cloverWebUrl(environment: CloverEnvironment): string {
  return environment === "production"
    ? "https://www.clover.com"
    : "https://sandbox.dev.clover.com";
}

/** The REST API, token endpoints included. */
export function cloverApiUrl(environment: CloverEnvironment): string {
  return environment === "production"
    ? "https://api.clover.com"
    : "https://apisandbox.dev.clover.com";
}

export function cloverAuthorizeUrl(args: {
  environment: CloverEnvironment;
  appId: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL("/oauth/v2/authorize", cloverWebUrl(args.environment));
  url.searchParams.set("client_id", args.appId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  // Clover doesn't document `state`; it is sent anyway, and the callback
  // trusts the httpOnly cookie, not whether Clover echoes it (parseCloverState).
  url.searchParams.set("state", args.state);
  return url.toString();
}

export interface CloverTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time the access token stops working. */
  expiresAt: string | null;
}

/** /oauth/v2/token and /oauth/v2/refresh both answer this shape. */
export function parseCloverTokenResponse(body: unknown): CloverTokens {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.access_token !== "string" || !b.access_token) {
    throw new Error("Clover did not return a token");
  }
  const expiry = Number(b.access_token_expiration);
  return {
    accessToken: b.access_token,
    refreshToken:
      typeof b.refresh_token === "string" && b.refresh_token
        ? b.refresh_token
        : null,
    expiresAt:
      Number.isFinite(expiry) && expiry > 0
        ? new Date(expiry * 1000).toISOString()
        : null,
  };
}

/**
 * Refresh five minutes before expiry. Clover's access tokens are short
 * lived and their length isn't fixed, so the margin is small and the
 * expiry is always read from Clover's answer, never assumed.
 */
export const CLOVER_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function cloverNeedsRefresh(
  expiresAt: string | null,
  now: Date,
): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry - now.getTime() < CLOVER_REFRESH_MARGIN_MS;
}

/**
 * The flow's state: the restaurant being connected and a random nonce,
 * kept in an httpOnly cookie set when the owner pressed Connect. The
 * cookie is what's trusted. If Clover echoes `state`, it must match too.
 */
export function parseCloverState(
  echoedState: string | null,
  cookieValue: string | undefined,
): { restaurantId: string } | null {
  if (!cookieValue) return null;
  if (echoedState && echoedState !== cookieValue) return null;
  const [restaurantId, nonce] = cookieValue.split(".");
  if (!restaurantId || !nonce) return null;
  return { restaurantId };
}

/** A Clover merchant id: 13 upper-case letters and digits. */
export function isCloverMerchantId(value: string | null): value is string {
  return Boolean(value && /^[A-Z0-9]{8,20}$/.test(value));
}

/**
 * Clover is usable on this deployment: an app id and secret, and a token
 * encryption key that's really 32 bytes. Booleans only.
 */
export function cloverReady(env: Record<string, string | undefined>): boolean {
  if (!env.CLOVER_APP_ID || !env.CLOVER_APP_SECRET) return false;
  const key = env.POS_TOKEN_ENCRYPTION_KEY;
  return Boolean(key) && Buffer.from(key!, "base64").length === 32;
}

/**
 * Which restaurants are offered Clover: CLOVER_RESTAURANTS is a comma list
 * of slugs, or "all". Until Clover approves the app for production, the
 * connection talks to Clover's sandbox, so only test restaurants see it.
 */
export function cloverOfferedTo(
  slug: string,
  allowList: string | undefined,
): boolean {
  const list = (allowList ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes("all") || list.includes(slug);
}
