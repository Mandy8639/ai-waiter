import "server-only";
import {
  OAUTH_TOKEN_URL,
  fcmAssertion,
  fcmConfigFrom,
  fcmRequestBody,
  fcmSendUrl,
  fcmVerdict,
  privateKeyShape,
  type FcmConfig,
  type FcmMessage,
} from "./fcm-core";
import type { SendOutcome } from "./dispatch-core";

/**
 * Sends to the Tableside Android app through FCM HTTP v1. The rules are in
 * fcm-core.ts; this is the network half.
 */

function logFailure(fields: Record<string, unknown>) {
  // One line per failed send, so "failed=1" in push_dispatch_native has a
  // reason next to it. Never the token, the key or the access token.
  console.info(
    JSON.stringify({
      event: "push_fcm_failed",
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
}

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
    // Google's OAuth error code and description name the problem (a
    // malformed key, a wrong email, a clock skew) without any secret in it.
    let reason = "";
    try {
      const body = (await response.json()) as {
        error?: string;
        error_description?: string;
      };
      reason = [body.error, body.error_description].filter(Boolean).join(": ");
    } catch {
      // Not JSON: the status says enough.
    }
    throw new Error(
      `token-exchange ${response.status}${reason ? ` ${reason}` : ""}`,
    );
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
      let errorMessage: string | undefined;
      try {
        const json = (await response.json()) as {
          error?: { status?: string; message?: string };
        };
        errorStatus = json.error?.status;
        errorMessage = json.error?.message;
      } catch {
        // No JSON body: the status code alone decides.
      }
      logFailure({
        status: response.status,
        error_status: errorStatus ?? null,
        // FCM's messages describe the request, not the device's token.
        message: errorMessage?.slice(0, 200) ?? null,
      });
    }
    const verdict = fcmVerdict(response.status, errorStatus);
    return verdict.ok
      ? { ok: true }
      : { ok: false, gone: verdict.gone, statusCode: response.status };
  } catch (error) {
    // The token exchange (fcmAssertion signs with FCM_PRIVATE_KEY, so a
    // mangled key fails here) or the network.
    const reason =
      error instanceof Error ? error.message.slice(0, 200) : "unknown";
    logFailure({
      status: null,
      reason,
      // When the key can't be read, how it's shaped (never its contents).
      ...(/DECODER|PEM|key/i.test(reason)
        ? { key_shape: privateKeyShape(process.env.FCM_PRIVATE_KEY) }
        : {}),
    });
    return { ok: false, gone: false };
  }
}
