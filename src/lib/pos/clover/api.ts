import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken, encryptToken, parseTokenKey } from "../token-crypto";
import {
  cloverApiUrl,
  cloverNeedsRefresh,
  cloverReady,
  parseCloverTokenResponse,
  type CloverEnvironment,
  type CloverTokens,
} from "./oauth-core";
import type {
  CloverCategory,
  CloverItem,
  CloverModifierGroup,
} from "./catalog-core";
import type { CloverAtomicOrder } from "./order-core";

/**
 * Clover I/O: configuration, token storage, and the endpoints phase 1
 * needs. The rules are in the *-core.ts files next to this one and are
 * unit-tested there. Like src/lib/pos/square/api.ts, this is the only
 * reader of the service-key token store for Clover (importers pinned by
 * tests/unit/clover-connection.test.ts): callers authorise the user first.
 */

export interface CloverConfig {
  environment: CloverEnvironment;
  appId: string;
  appSecret: string;
}

export function cloverConfig(): CloverConfig | null {
  if (!cloverReady(process.env)) return null;
  return {
    environment:
      process.env.CLOVER_ENVIRONMENT === "production"
        ? "production"
        : "sandbox",
    appId: process.env.CLOVER_APP_ID!,
    appSecret: process.env.CLOVER_APP_SECRET!,
  };
}

function requireConfig(): CloverConfig {
  const config = cloverConfig();
  if (!config)
    throw new CloverError("Clover isn't set up on this deployment yet.");
  return config;
}

/** A failure worth showing an owner, with Clover's own detail kept for logs. */
export class CloverError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function cloverFetch<T>(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const config = requireConfig();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const response = await fetch(`${cloverApiUrl(config.environment)}${path}`, {
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
    // An HTML error page; kept as text below.
  }
  if (!response.ok) {
    const message = (json as { message?: string } | null)?.message;
    const detail = `${response.status} ${message ?? text.slice(0, 300)}`;
    if (response.status === 401) {
      throw new CloverError(
        "Clover no longer accepts Tableside's access. Reconnect Clover.",
        detail,
        401,
      );
    }
    throw new CloverError("Clover returned an error.", detail, response.status);
  }
  return json as T;
}

// ── Tokens ────────────────────────────────────────────────────────────

export async function exchangeCloverCode(code: string): Promise<CloverTokens> {
  const config = requireConfig();
  return parseCloverTokenResponse(
    await cloverFetch<unknown>("/oauth/v2/token", {
      method: "POST",
      body: {
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
      },
    }),
  );
}

/** pos_credentials is newer than database.types.ts. */
function store(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

export async function saveCloverTokens(
  restaurantId: string,
  merchantId: string,
  tokens: CloverTokens,
): Promise<void> {
  const key = parseTokenKey(process.env.POS_TOKEN_ENCRYPTION_KEY);
  const { error } = await store()
    .from("pos_credentials")
    .upsert({
      restaurant_id: restaurantId,
      provider: "clover",
      merchant_id: merchantId,
      access_token_enc: encryptToken(tokens.accessToken, key),
      refresh_token_enc: tokens.refreshToken
        ? encryptToken(tokens.refreshToken, key)
        : null,
      expires_at: tokens.expiresAt,
    });
  if (error)
    throw new CloverError(
      "Couldn't save the Clover connection.",
      error.message,
    );
}

/**
 * The merchant and a working access token for this restaurant, refreshed
 * first if it's about to expire. Clover's refresh token is single use, so
 * the new pair is saved at once. Callers must already have checked the
 * signed-in user may act for the restaurant (or be the outbox worker
 * delivering this restaurant's own orders): this reads with the service key.
 */
export async function cloverAccessFor(
  restaurantId: string,
): Promise<{ merchantId: string; token: string }> {
  const config = requireConfig();
  const key = parseTokenKey(process.env.POS_TOKEN_ENCRYPTION_KEY);
  const { data, error } = await store()
    .from("pos_credentials")
    .select("merchant_id, access_token_enc, refresh_token_enc, expires_at")
    .eq("restaurant_id", restaurantId)
    .eq("provider", "clover")
    .maybeSingle();
  if (error)
    throw new CloverError(
      "Couldn't read the Clover connection.",
      error.message,
    );
  if (!data)
    throw new CloverError("Clover isn't connected for this restaurant.");

  if (!cloverNeedsRefresh(data.expires_at, new Date())) {
    return {
      merchantId: data.merchant_id,
      token: decryptToken(data.access_token_enc, key),
    };
  }
  if (!data.refresh_token_enc) {
    throw new CloverError("Clover's access has expired. Reconnect Clover.");
  }
  const refreshed = parseCloverTokenResponse(
    await cloverFetch<unknown>("/oauth/v2/refresh", {
      method: "POST",
      body: {
        client_id: config.appId,
        refresh_token: decryptToken(data.refresh_token_enc, key),
      },
    }),
  );
  await saveCloverTokens(restaurantId, data.merchant_id, refreshed);
  return { merchantId: data.merchant_id, token: refreshed.accessToken };
}

/** Forget the tokens. The owner removes the app in Clover to revoke it there. */
export async function disconnectClover(restaurantId: string): Promise<void> {
  await store()
    .from("pos_credentials")
    .delete()
    .eq("restaurant_id", restaurantId)
    .eq("provider", "clover");
}

// ── Data ──────────────────────────────────────────────────────────────

export interface CloverMerchant {
  id: string;
  name: string;
}

export async function getCloverMerchant(
  restaurantId: string,
): Promise<CloverMerchant> {
  const { merchantId, token } = await cloverAccessFor(restaurantId);
  const body = await cloverFetch<{ id?: string; name?: string }>(
    `/v3/merchants/${encodeURIComponent(merchantId)}`,
    { token },
  );
  return { id: body.id ?? merchantId, name: body.name ?? "Clover merchant" };
}

/** Every page of a Clover list endpoint (elements, at most 1000 a page). */
async function listAll<T>(
  restaurantId: string,
  path: string,
  query: string,
): Promise<T[]> {
  const { merchantId, token } = await cloverAccessFor(restaurantId);
  const out: T[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const body = await cloverFetch<{ elements?: T[] }>(
      `/v3/merchants/${encodeURIComponent(merchantId)}${path}?limit=1000&offset=${offset}${query}`,
      { token },
    );
    const page = body.elements ?? [];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

export async function listCloverInventory(restaurantId: string): Promise<{
  items: CloverItem[];
  categories: CloverCategory[];
  modifierGroups: CloverModifierGroup[];
}> {
  const [items, categories, modifierGroups] = await Promise.all([
    listAll<CloverItem>(
      restaurantId,
      "/items",
      "&expand=categories,modifierGroups",
    ),
    listAll<CloverCategory>(restaurantId, "/categories", ""),
    listAll<CloverModifierGroup>(
      restaurantId,
      "/modifier_groups",
      "&expand=modifiers",
    ),
  ]);
  return { items, categories, modifierGroups };
}

export async function listCloverOrderTypes(
  restaurantId: string,
): Promise<{ id: string; label?: string; deleted?: boolean }[]> {
  return listAll(restaurantId, "/order_types", "");
}

/** Creates the order in one call; Clover works out its totals and taxes. */
export async function createCloverAtomicOrder(
  restaurantId: string,
  order: CloverAtomicOrder,
): Promise<{ id: string }> {
  const { merchantId, token } = await cloverAccessFor(restaurantId);
  const body = await cloverFetch<{ id?: string }>(
    `/v3/merchants/${encodeURIComponent(merchantId)}/atomic_order/orders`,
    { method: "POST", token, body: order },
  );
  if (!body.id) throw new CloverError("Clover didn't return an order id.");
  return { id: body.id };
}
