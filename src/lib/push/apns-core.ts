import { createPrivateKey, sign } from "node:crypto";
import type { PushPayload } from "./dispatch-core";

/**
 * Apple Push Notification service, the part with no network in it: who we
 * are to Apple (the provider token), what we send, and what Apple's answer
 * means. src/lib/push/apns.ts does the HTTP/2. No `server-only`, per the
 * extract-the-core convention.
 *
 * Token-based auth: one .p8 signing key from the Apple Developer account
 * (Keys → Apple Push Notifications service), identified by its key ID and
 * the team ID, signs a short JWT that APNs accepts for up to an hour. No
 * certificates to renew.
 */

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 file's contents (PEM). */
  privateKey: string;
  /** The app's bundle ID; APNs calls it the topic. */
  bundleId: string;
}

export const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;
export type ApnsEnvironment = keyof typeof APNS_HOSTS;

/**
 * From the environment. Optional, like VAPID: with any piece missing,
 * iOS alerts are off and nothing tries to send. A PEM pasted into a
 * single-line env var arrives with literal "\n"s; those are restored.
 */
export function apnsConfigFrom(
  env: Record<string, string | undefined>,
): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const privateKey = env.APNS_PRIVATE_KEY?.trim().replace(/\\n/g, "\n");
  if (!keyId || !teamId || !privateKey) return null;
  return {
    keyId,
    teamId,
    privateKey,
    bundleId: env.APNS_BUNDLE_ID?.trim() || "menu.tableside.app",
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** The ES256 provider token APNs expects in `authorization: bearer …`. */
export function apnsProviderToken(
  config: Pick<ApnsConfig, "keyId" | "teamId" | "privateKey">,
  nowSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(
    JSON.stringify({ iss: config.teamId, iat: nowSeconds }),
  );
  const signingInput = `${header}.${claims}`;
  // JWS wants the raw r||s signature, not DER.
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * The order ring, bundled in the iOS app (ios/App/App/order-ring.caf):
 * 29 seconds, under Apple's 30-second limit for notification sounds.
 */
export const ORDER_RING_SOUND = "order-ring.caf";

export interface ApnsRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * One alert to one device. The collapse ID plays the web tag's part: a
 * re-sent order replaces its own notification instead of stacking.
 */
export function apnsRequest(
  deviceToken: string,
  payload: PushPayload,
  config: Pick<ApnsConfig, "bundleId">,
  nowSeconds: number,
): ApnsRequest {
  return {
    path: `/3/device/${deviceToken}`,
    headers: {
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-topic": config.bundleId,
      // Ten minutes, like the web push TTL: an order alert an hour late is
      // noise, the board already shows it.
      "apns-expiration": String(nowSeconds + 600),
      "apns-collapse-id": payload.tag.slice(0, 64),
    },
    body: JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: payload.urgent ? ORDER_RING_SOUND : "default",
        // An order rings through Focus and Scheduled Summary
        // (App.entitlements has the time-sensitive capability).
        "interruption-level": payload.urgent ? "time-sensitive" : "active",
        "thread-id": "tableside-kitchen",
      },
      // Read by the app when the notification is tapped (ios/), to open
      // the dashboard page it's about.
      url: payload.url,
    }),
  };
}

export type ApnsVerdict =
  { ok: true } | { ok: false; gone: boolean; otherEnvironment: boolean };

/**
 * What APNs's answer means for the token:
 *   200            delivered.
 *   410            the app is gone from that device: forget the token.
 *   400 BadDeviceToken
 *                  usually a token from the other gateway (a development
 *                  build's token sent to production, or the reverse): try
 *                  the other one before giving up on it.
 *   anything else  a failure that says nothing about the device: count it.
 */
export function apnsVerdict(status: number, reason?: string): ApnsVerdict {
  if (status === 200) return { ok: true };
  if (status === 410 || reason === "Unregistered") {
    return { ok: false, gone: true, otherEnvironment: false };
  }
  if (status === 400 && reason === "BadDeviceToken") {
    return { ok: false, gone: false, otherEnvironment: true };
  }
  return { ok: false, gone: false, otherEnvironment: false };
}

/** The order to try gateways in for a token, known environment first. */
export function apnsEnvironmentsToTry(
  known: ApnsEnvironment | null,
): ApnsEnvironment[] {
  if (known === "sandbox") return ["sandbox", "production"];
  return ["production", "sandbox"];
}
