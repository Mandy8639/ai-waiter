import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken, encryptToken, parseTokenKey } from "../token-crypto";
import {
  SQUARE_API_VERSION,
  needsRefresh,
  parseTokenResponse,
  squareReady,
  squareBaseUrl,
  type SquareEnvironment,
  type SquareTokens,
} from "./oauth-core";
import type { SquareCatalogObject } from "./catalog-core";

/**
 * Square I/O: configuration, token storage, and the handful of endpoints
 * phase 1 needs. The rules (scopes, refresh timing, catalog mapping) are
 * in the *-core.ts files next to this one and are unit-tested there.
 *
 * Configuration is read lazily, like SUPABASE_SECRET_KEY in admin.ts, so a
 * deployment without Square set up only fails on the Square pages.
 */

export interface SquareConfig {
  environment: SquareEnvironment;
  applicationId: string;
  applicationSecret: string;
}

export function squareConfig(): SquareConfig | null {
  if (!squareReady(process.env)) return null;
  return {
    environment:
      process.env.SQUARE_ENVIRONMENT === "production"
        ? "production"
        : "sandbox",
    applicationId: process.env.SQUARE_APPLICATION_ID!,
    applicationSecret: process.env.SQUARE_APPLICATION_SECRET!,
  };
}

function requireConfig(): SquareConfig {
  const config = squareConfig();
  if (!config)
    throw new SquareError("Square isn't set up on this deployment yet.");
  return config;
}

/** A failure worth showing an owner, with Square's own detail kept for logs. */
export class SquareError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

async function squareFetch<T>(
  path: string,
  init: {
    method?: string;
    token?: string;
    body?: unknown;
    clientSecret?: string;
  },
): Promise<T> {
  const config = requireConfig();
  const headers: Record<string, string> = {
    "Square-Version": SQUARE_API_VERSION,
    "Content-Type": "application/json",
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.clientSecret) headers.Authorization = `Client ${init.clientSecret}`;
  const response = await fetch(`${squareBaseUrl(config.environment)}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error page; handled below.
  }
  if (!response.ok) {
    const errors = (
      json as { errors?: { code?: string; detail?: string }[] } | null
    )?.errors;
    const detail =
      errors?.map((e) => `${e.code}: ${e.detail}`).join("; ") ??
      text.slice(0, 300);
    if (response.status === 401) {
      throw new SquareError(
        "Square no longer accepts Tableside's access. Reconnect Square.",
        detail,
      );
    }
    throw new SquareError("Square returned an error.", detail);
  }
  return json as T;
}

// ── Tokens ────────────────────────────────────────────────────────────

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<SquareTokens> {
  const config = requireConfig();
  const body = await squareFetch<unknown>("/oauth2/token", {
    method: "POST",
    body: {
      client_id: config.applicationId,
      client_secret: config.applicationSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    },
  });
  return parseTokenResponse(body);
}

/**
 * database.types.ts predates 20261109090000, so the new table and columns
 * go through this loosely typed handle. Delete once types are regenerated
 * (see src/lib/menu-images/actions.ts for why that is its own task).
 */
function untilTypesRegenerated(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

export async function saveTokens(
  restaurantId: string,
  tokens: SquareTokens,
  /** The scopes just granted. Given on a new connection; omitted on a refresh, which keeps them. */
  scopes?: readonly string[],
): Promise<void> {
  const key = parseTokenKey(process.env.POS_TOKEN_ENCRYPTION_KEY);
  const { error } = await untilTypesRegenerated()
    .from("pos_credentials")
    .upsert({
      restaurant_id: restaurantId,
      provider: "square",
      merchant_id: tokens.merchantId,
      access_token_enc: encryptToken(tokens.accessToken, key),
      refresh_token_enc: tokens.refreshToken
        ? encryptToken(tokens.refreshToken, key)
        : null,
      expires_at: tokens.expiresAt,
      ...(scopes ? { scopes: scopes.join(" ") } : {}),
    });
  if (error)
    throw new SquareError(
      "Couldn't save the Square connection.",
      error.message,
    );
}

/**
 * A working access token for this restaurant, refreshed first if it's
 * within a week of expiring. Callers must already have checked the
 * signed-in user may act for the restaurant: this reads with the service key.
 */
export async function accessTokenFor(restaurantId: string): Promise<string> {
  const config = requireConfig();
  const key = parseTokenKey(process.env.POS_TOKEN_ENCRYPTION_KEY);
  const { data, error } = await untilTypesRegenerated()
    .from("pos_credentials")
    .select("merchant_id, access_token_enc, refresh_token_enc, expires_at")
    .eq("restaurant_id", restaurantId)
    .eq("provider", "square")
    .maybeSingle();
  if (error)
    throw new SquareError(
      "Couldn't read the Square connection.",
      error.message,
    );
  if (!data)
    throw new SquareError("Square isn't connected for this restaurant.");

  if (!needsRefresh(data.expires_at, new Date())) {
    return decryptToken(data.access_token_enc, key);
  }
  if (!data.refresh_token_enc) {
    throw new SquareError("Square's access has expired. Reconnect Square.");
  }
  const refreshed = parseTokenResponse(
    await squareFetch<unknown>("/oauth2/token", {
      method: "POST",
      body: {
        client_id: config.applicationId,
        client_secret: config.applicationSecret,
        grant_type: "refresh_token",
        refresh_token: decryptToken(data.refresh_token_enc, key),
      },
    }),
  );
  // Square may or may not rotate the refresh token; keep the old one if not.
  await saveTokens(restaurantId, {
    ...refreshed,
    refreshToken:
      refreshed.refreshToken ?? decryptToken(data.refresh_token_enc, key),
  });
  return refreshed.accessToken;
}

/** Revoke Tableside's access at Square, then forget the tokens. */
export async function disconnect(restaurantId: string): Promise<void> {
  const config = requireConfig();
  const admin = untilTypesRegenerated();
  const { data } = await admin
    .from("pos_credentials")
    .select("merchant_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (data?.merchant_id) {
    try {
      await squareFetch("/oauth2/revoke", {
        method: "POST",
        clientSecret: config.applicationSecret,
        body: {
          client_id: config.applicationId,
          merchant_id: data.merchant_id,
        },
      });
    } catch (e) {
      // Already revoked from Square's side, or Square is down: the local
      // tokens are deleted either way, so Tableside can't use them.
      console.warn(
        JSON.stringify({
          event: "square.revoke_failed",
          restaurantId,
          detail: String(e),
        }),
      );
    }
  }
  await admin
    .from("pos_credentials")
    .delete()
    .eq("restaurant_id", restaurantId);
}

// ── Data ──────────────────────────────────────────────────────────────

export interface SquareLocation {
  id: string;
  name: string;
  status: string;
  currency: string | null;
}

export async function listLocations(
  restaurantId: string,
): Promise<SquareLocation[]> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ locations?: Record<string, unknown>[] }>(
    "/v2/locations",
    {
      token,
    },
  );
  return (body.locations ?? []).map((l) => ({
    id: String(l.id),
    name: String(l.name ?? l.id),
    status: String(l.status ?? "ACTIVE"),
    currency: typeof l.currency === "string" ? l.currency : null,
  }));
}

/** Every item, category and modifier list, following Square's pagination. */
export async function listCatalog(
  restaurantId: string,
): Promise<SquareCatalogObject[]> {
  const token = await accessTokenFor(restaurantId);
  const objects: SquareCatalogObject[] = [];
  let cursor: string | undefined;
  // A hard page cap: a runaway cursor loop must not hang a request.
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({
      types: "ITEM,CATEGORY,MODIFIER_LIST",
    });
    if (cursor) params.set("cursor", cursor);
    const body = await squareFetch<{
      objects?: SquareCatalogObject[];
      cursor?: string;
    }>(`/v2/catalog/list?${params}`, { token });
    objects.push(...(body.objects ?? []));
    cursor = body.cursor;
    if (!cursor) return objects;
  }
  throw new SquareError(
    "Square's menu is larger than Tableside can import in one go.",
  );
}

// ── Diner payments (phase 2) ──────────────────────────────────────────
//
// Called from a diner's request (an anonymous user), right after
// start_order_payment()/start_tab_payment() created or reused the payment
// for that diner's own orders. That function call is the authorisation:
// these helpers only look up the restaurant behind that payment id.

export interface SquarePaymentContext {
  restaurantId: string;
  locationId: string;
  /** A checkout already opened for this pending payment, to send the diner back to. */
  existingCheckoutUrl: string | null;
  restaurantName: string;
}

export async function squarePaymentContext(
  paymentId: string,
): Promise<SquarePaymentContext> {
  const admin = untilTypesRegenerated();
  const { data: payment } = await admin
    .from("order_payments")
    .select("restaurant_id, status, square_checkout_url")
    .eq("id", paymentId)
    .maybeSingle();
  if (!payment || payment.status !== "pending") {
    throw new SquareError("This payment can't be started.");
  }
  const [{ data: integration }, { data: restaurant }] = await Promise.all([
    admin
      .from("restaurant_pos_integrations")
      .select("provider, external_location_id, is_enabled, payments_enabled")
      .eq("restaurant_id", payment.restaurant_id)
      .maybeSingle(),
    admin
      .from("restaurants")
      .select("name")
      .eq("id", payment.restaurant_id)
      .maybeSingle(),
  ]);
  if (
    integration?.provider !== "square" ||
    !integration.is_enabled ||
    !integration.payments_enabled ||
    !integration.external_location_id
  ) {
    throw new SquareError(
      "Card payments through Square aren't switched on here.",
    );
  }
  return {
    restaurantId: payment.restaurant_id,
    locationId: integration.external_location_id,
    existingCheckoutUrl: payment.square_checkout_url ?? null,
    restaurantName: restaurant?.name ?? "the restaurant",
  };
}

export async function createPaymentLink(
  restaurantId: string,
  request: unknown,
): Promise<{ url: string; orderId: string }> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{
    payment_link?: { url?: string; long_url?: string; order_id?: string };
  }>("/v2/online-checkout/payment-links", {
    method: "POST",
    token,
    body: request,
  });
  const link = body.payment_link;
  const url = link?.url ?? link?.long_url;
  if (!url || !link?.order_id) {
    throw new SquareError("Square didn't return a checkout page.");
  }
  return { url, orderId: link.order_id };
}

// ── In person (phase 3) ───────────────────────────────────────────────
//
// Called from staff actions (src/lib/pos/square/in-person.ts) after the
// member's own call to start_square_terminal_payment() /
// record_in_person_payment() succeeded for that restaurant, and from the
// Point of sale settings actions after authorizeSquare().

export async function squareLocationFor(restaurantId: string): Promise<string> {
  const { data } = await untilTypesRegenerated()
    .from("restaurant_pos_integrations")
    .select("provider, external_location_id, is_enabled")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (
    data?.provider !== "square" ||
    !data.is_enabled ||
    !data.external_location_id
  ) {
    throw new SquareError("Square isn't connected with a location here.");
  }
  return data.external_location_id;
}

export async function grantedScopes(
  restaurantId: string,
): Promise<string | null> {
  const { data } = await untilTypesRegenerated()
    .from("pos_credentials")
    .select("scopes")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  return data?.scopes ?? null;
}

export async function createOrder(
  restaurantId: string,
  request: unknown,
): Promise<string> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ order?: { id?: string } }>("/v2/orders", {
    method: "POST",
    token,
    body: request,
  });
  if (!body.order?.id) throw new SquareError("Square didn't create the order.");
  return body.order.id;
}

export interface TerminalCheckoutState {
  id: string;
  status: string;
  paymentIds: string[];
}

const toCheckout = (
  c: Record<string, unknown> | undefined,
): TerminalCheckoutState => {
  if (!c || typeof c.id !== "string")
    throw new SquareError("Square didn't return the checkout.");
  return {
    id: c.id,
    status: String(c.status ?? "PENDING"),
    paymentIds: Array.isArray(c.payment_ids) ? c.payment_ids.map(String) : [],
  };
};

export async function createTerminalCheckout(
  restaurantId: string,
  request: unknown,
): Promise<TerminalCheckoutState> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ checkout?: Record<string, unknown> }>(
    "/v2/terminals/checkouts",
    { method: "POST", token, body: request },
  );
  return toCheckout(body.checkout);
}

export async function getTerminalCheckout(
  restaurantId: string,
  checkoutId: string,
): Promise<TerminalCheckoutState> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ checkout?: Record<string, unknown> }>(
    `/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}`,
    { token },
  );
  return toCheckout(body.checkout);
}

export async function cancelTerminalCheckout(
  restaurantId: string,
  checkoutId: string,
): Promise<TerminalCheckoutState> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ checkout?: Record<string, unknown> }>(
    `/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}/cancel`,
    { method: "POST", token },
  );
  return toCheckout(body.checkout);
}

export interface SquarePaymentState {
  id: string;
  status: string;
  orderId: string | null;
  totalMinorUnits: number;
  tipMinorUnits: number;
  /** Tableside's fee on the payment (app_fee_money), 0 if none. */
  appFeeMinorUnits: number;
  currency: string;
}

export async function getPayment(
  restaurantId: string,
  paymentId: string,
): Promise<SquarePaymentState> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ payment?: Record<string, unknown> }>(
    `/v2/payments/${encodeURIComponent(paymentId)}`,
    { token },
  );
  const p = body.payment;
  const total = p?.total_money as
    { amount?: number; currency?: string } | undefined;
  const tip = p?.tip_money as { amount?: number } | undefined;
  const fee = p?.app_fee_money as { amount?: number } | undefined;
  if (!p || typeof p.id !== "string" || typeof total?.amount !== "number") {
    throw new SquareError("Square didn't return the payment.");
  }
  return {
    id: p.id,
    status: String(p.status ?? ""),
    orderId: typeof p.order_id === "string" ? p.order_id : null,
    totalMinorUnits: total.amount,
    tipMinorUnits: typeof tip?.amount === "number" ? tip.amount : 0,
    appFeeMinorUnits: typeof fee?.amount === "number" ? fee.amount : 0,
    currency: String(total.currency ?? ""),
  };
}

export interface SquareRefundState {
  id: string;
  /** PENDING, COMPLETED, REJECTED or FAILED. */
  status: string;
}

const toRefund = (
  r: Record<string, unknown> | undefined,
): SquareRefundState => {
  if (!r || typeof r.id !== "string")
    throw new SquareError("Square didn't return the refund.");
  return { id: r.id, status: String(r.status ?? "PENDING") };
};

/** Refunds part or all of a Square payment, back to the card it came from. */
export async function refundSquarePayment(
  restaurantId: string,
  request: unknown,
): Promise<SquareRefundState> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ refund?: Record<string, unknown> }>(
    "/v2/refunds",
    { method: "POST", token, body: request },
  );
  return toRefund(body.refund);
}

export async function getSquareRefund(
  restaurantId: string,
  refundId: string,
): Promise<SquareRefundState> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ refund?: Record<string, unknown> }>(
    `/v2/refunds/${encodeURIComponent(refundId)}`,
    { token },
  );
  return toRefund(body.refund);
}

export async function createCashPayment(
  restaurantId: string,
  request: unknown,
): Promise<string> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ payment?: { id?: string } }>(
    "/v2/payments",
    {
      method: "POST",
      token,
      body: request,
    },
  );
  if (!body.payment?.id)
    throw new SquareError("Square didn't record the cash sale.");
  return body.payment.id;
}

export interface DeviceCodeState {
  id: string;
  code: string;
  status: string;
  deviceId: string | null;
  pairBy: string | null;
}

const toDeviceCode = (
  d: Record<string, unknown> | undefined,
): DeviceCodeState => {
  if (!d || typeof d.id !== "string")
    throw new SquareError("Square didn't return a device code.");
  return {
    id: d.id,
    code: String(d.code ?? ""),
    status: String(d.status ?? "UNKNOWN"),
    deviceId: typeof d.device_id === "string" ? d.device_id : null,
    pairBy: typeof d.pair_by === "string" ? d.pair_by : null,
  };
};

/** A code the seller types on a Square Terminal to pair it (Devices API, TERMINAL_API). */
export async function createDeviceCode(
  restaurantId: string,
  name: string,
  idempotencyKey: string,
): Promise<DeviceCodeState> {
  const token = await accessTokenFor(restaurantId);
  const locationId = await squareLocationFor(restaurantId);
  const body = await squareFetch<{ device_code?: Record<string, unknown> }>(
    "/v2/devices/codes",
    {
      method: "POST",
      token,
      body: {
        idempotency_key: idempotencyKey,
        device_code: {
          name,
          product_type: "TERMINAL_API",
          location_id: locationId,
        },
      },
    },
  );
  return toDeviceCode(body.device_code);
}

export async function getDeviceCode(
  restaurantId: string,
  deviceCodeId: string,
): Promise<DeviceCodeState> {
  const token = await accessTokenFor(restaurantId);
  const body = await squareFetch<{ device_code?: Record<string, unknown> }>(
    `/v2/devices/codes/${encodeURIComponent(deviceCodeId)}`,
    { token },
  );
  return toDeviceCode(body.device_code);
}

/**
 * Settle a Square payment after the server has just read it from Square
 * (a Terminal checkout the staff member is waiting on). The webhook does
 * the same as a backstop. settle_square_payment() is service_role only and
 * refuses any amount that doesn't match the bill.
 */
export async function settleFromSquare(
  payment: SquarePaymentState,
): Promise<string> {
  if (!payment.orderId) return "unknown";
  const { data, error } = await untilTypesRegenerated().rpc(
    "settle_square_payment",
    {
      p_square_order_id: payment.orderId,
      p_square_payment_id: payment.id,
      p_total_minor_units: payment.totalMinorUnits,
      p_tip_minor_units: payment.tipMinorUnits,
      p_currency: payment.currency,
    },
  );
  if (error)
    throw new SquareError("Couldn't record the payment.", error.message);
  return String(data);
}
