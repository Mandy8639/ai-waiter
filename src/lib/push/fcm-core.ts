import { createSign } from "node:crypto";
import type { PushPayload } from "./dispatch-core";

/**
 * Kitchen alerts to the Tableside Android app through Firebase Cloud
 * Messaging (HTTP v1), the part with no network in it. src/lib/push/fcm.ts
 * is the network half. No `server-only`, per the extract-the-core
 * convention.
 *
 * Every message is DATA-ONLY. The app's own messaging service
 * (android/app/src/main/java/menu/tableside/app/OrderAlertService.java)
 * builds the notification, because only the app can make an order ring
 * like a delivery tablet: a looping alarm (Android's "insistent" flag) on
 * its own "New orders" channel until someone touches it, and a "stop"
 * message that silences every phone the moment the order is accepted. A
 * notification message would be shown by the system instead, once, like
 * any other.
 */

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** The service account's PEM private key. */
  privateKey: string;
}

/**
 * Read from the environment (a Firebase service account: Project settings
 * → Service accounts → Generate new private key). Null, and Android
 * alerts off, unless all three are set.
 */
export function fcmConfigFrom(
  env: Record<string, string | undefined>,
): FcmConfig | null {
  const projectId = env.FCM_PROJECT_ID?.trim();
  const clientEmail = env.FCM_CLIENT_EMAIL?.trim();
  // Vercel and .env files hold the key on one line, with "\n" for the
  // line breaks; the PEM needs real ones back.
  const privateKey = env.FCM_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

const OAUTH_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * The signed assertion exchanged at Google's token endpoint for an access
 * token (the service-account JWT flow, RS256, valid an hour).
 */
export function fcmAssertion(config: FcmConfig, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: OAUTH_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(config.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

export function fcmSendUrl(config: Pick<FcmConfig, "projectId">): string {
  return `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`;
}

/** What the app does with a message: show (or replace) an alert, or silence one. */
export type FcmMessage =
  { kind: "alert"; payload: PushPayload } | { kind: "stop"; group: string };

/**
 * The request body for one device. Data values must all be strings.
 * High priority, so a phone asleep in a pocket wakes for it; ten minutes
 * to live, like the web push TTL.
 */
export function fcmRequestBody(token: string, message: FcmMessage): string {
  const data: Record<string, string> =
    message.kind === "alert"
      ? {
          kind: "alert",
          title: message.payload.title,
          body: message.payload.body,
          url: message.payload.url,
          tag: message.payload.tag,
          group: message.payload.group ?? message.payload.tag,
          urgent: message.payload.urgent ? "1" : "0",
        }
      : { kind: "stop", group: message.group };
  return JSON.stringify({
    message: {
      token,
      data,
      android: { priority: "HIGH", ttl: "600s" },
    },
  });
}

export type FcmVerdict = { ok: true } | { ok: false; gone: boolean };

/**
 * What FCM's answer means for the token:
 *   200             delivered.
 *   404 UNREGISTERED
 *                   the app is gone from that phone (or the token was
 *                   replaced): forget it.
 *   anything else   a failure that says nothing certain about the phone,
 *                   including 400 INVALID_ARGUMENT, which could just as
 *                   well be our own message's fault: count it.
 */
export function fcmVerdict(status: number, errorStatus?: string): FcmVerdict {
  if (status === 200) return { ok: true };
  return { ok: false, gone: status === 404 || errorStatus === "UNREGISTERED" };
}
