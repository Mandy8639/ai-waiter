import "server-only";
import {
  combineSpending,
  NOTHING_REPORTED,
  parseCredits,
  parseKeyInfo,
  type Spending,
} from "./spending-core";

/**
 * Reads the Spending card's figures from OpenRouter with the app's own
 * key (spending-core.ts has the parsing): this key's usage and limit,
 * and the account's remaining credit. Read on every view of /admin, not
 * cached, so it is live; each request has its own short timeout, and a
 * failed one leaves its figures "not reported".
 */

const KEY_URL = "https://openrouter.ai/api/v1/key";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

async function getJson(url: string, apiKey: string): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "openrouter_spend_read_failed",
        url,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

export async function getSpending(): Promise<Spending> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NOTHING_REPORTED;
  const [key, credits] = await Promise.all([
    getJson(KEY_URL, apiKey),
    getJson(CREDITS_URL, apiKey),
  ]);
  return combineSpending(parseKeyInfo(key), parseCredits(credits));
}
