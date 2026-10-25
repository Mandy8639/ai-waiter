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
