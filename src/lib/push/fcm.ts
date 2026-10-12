import "server-only";
import {
  OAUTH_TOKEN_URL,
  fcmAssertion,
  fcmConfigFrom,
  fcmRequestBody,
  fcmSendUrl,
  fcmVerdict,
  type FcmConfig,
  type FcmMessage,
} from "./fcm-core";
import type { SendOutcome } from "./dispatch-core";

/**
 * Sends to the Tableside Android app through FCM HTTP v1. The rules are in
 * fcm-core.ts; this is the network half.
 */

export function fcmConfig(): FcmConfig | null {
  return fcmConfigFrom(process.env);
}

// Google's access tokens last an hour; reuse one for 50 minutes.
let cached: { value: string; expiresAt: number; email: string } | null = null;

async function accessToken(config: FcmConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === config.clientEmail && now < cached.expiresAt) {
    return cached.value;
  }
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: fcmAssertion(config, now),
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`FCM token exchange failed (${response.status})`);
  }
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("FCM token exchange: no token");
  cached = {
    value: json.access_token,
    expiresAt: now + 50 * 60,
    email: config.clientEmail,
  };
  return cached.value;
}

export async function sendFcm(
  token: string,
  message: FcmMessage,
  config: FcmConfig,
): Promise<SendOutcome> {
  try {
    const response = await fetch(fcmSendUrl(config), {
      method: "POST",
      headers: {
        authorization: `Bearer ${await accessToken(config)}`,
        "content-type": "application/json",
      },
      body: fcmRequestBody(token, message),
      signal: AbortSignal.timeout(8_000),
    });
    let errorStatus: string | undefined;
    if (!response.ok) {
      try {
        const json = (await response.json()) as {
          error?: { status?: string };
        };
        errorStatus = json.error?.status;
      } catch {
        // No JSON body: the status code alone decides.
      }
    }
    const verdict = fcmVerdict(response.status, errorStatus);
    return verdict.ok
      ? { ok: true }
      : { ok: false, gone: verdict.gone, statusCode: response.status };
  } catch {
    return { ok: false, gone: false };
  }
}
