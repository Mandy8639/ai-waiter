import "server-only";
import http2 from "node:http2";
import {
  APNS_HOSTS,
  apnsConfigFrom,
  apnsEnvironmentsToTry,
  apnsProviderToken,
  apnsRequest,
  apnsVerdict,
  type ApnsConfig,
  type ApnsEnvironment,
} from "./apns-core";
import type { PushPayload, SendOutcome } from "./dispatch-core";

/**
 * Sends to the Tableside iOS app through APNs over HTTP/2. The rules are
 * in apns-core.ts; this is the network half.
 */

export interface NativeTarget {
  id: string;
  token: string;
  environment: ApnsEnvironment | null;
  /** 'ios' (APNs) or 'android' (FCM, src/lib/push/fcm.ts). */
  platform?: "ios" | "android";
}

export function apnsConfig(): ApnsConfig | null {
  return apnsConfigFrom(process.env);
}

// APNs accepts a provider token for an hour and asks that it not be
// regenerated more than every 20 minutes; reuse one for 50.
let cachedToken: { value: string; issuedAt: number; keyId: string } | null =
  null;

function providerToken(config: ApnsConfig, now: number): string {
  if (
    !cachedToken ||
    cachedToken.keyId !== config.keyId ||
    now - cachedToken.issuedAt > 50 * 60
  ) {
    cachedToken = {
      value: apnsProviderToken(config, now),
      issuedAt: now,
      keyId: config.keyId,
    };
  }
  return cachedToken.value;
}

function post(
  host: string,
  request: ReturnType<typeof apnsRequest>,
  bearer: string,
): Promise<{ status: number; reason?: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(host);
    client.on("error", reject);
    const stream = client.request({
      ":method": "POST",
      ":path": request.path,
      authorization: `bearer ${bearer}`,
      "content-type": "application/json",
      ...request.headers,
    });
    let status = 0;
    let body = "";
    stream.setTimeout(8_000, () => {
      stream.close();
      client.close();
      reject(new Error("APNs request timed out"));
    });
    stream.on("response", (headers) => {
      status = Number(headers[":status"]);
    });
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("end", () => {
      client.close();
      let reason: string | undefined;
      try {
        reason = body
          ? (JSON.parse(body) as { reason?: string }).reason
          : undefined;
      } catch {
        reason = undefined;
      }
      resolve({ status, reason });
    });
    stream.on("error", (error) => {
      client.close();
      reject(error);
    });
    stream.end(request.body);
  });
}

/**
 * One alert to one phone. Returns the outcome in dispatch-core's terms,
 * plus the gateway that accepted the token so the caller can remember it.
 */
export async function sendApns(
  target: NativeTarget,
  payload: PushPayload,
  config: ApnsConfig,
): Promise<{
  outcome: SendOutcome;
  environment?: ApnsEnvironment;
  /** Apple's reason when it refused, e.g. "BadDeviceToken". Not secret. */
  reason?: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const bearer = providerToken(config, now);
  const request = apnsRequest(target.token, payload, config, now);
  for (const environment of apnsEnvironmentsToTry(target.environment)) {
    const { status, reason } = await post(
      APNS_HOSTS[environment],
      request,
      bearer,
    );
    const verdict = apnsVerdict(status, reason);
    if (verdict.ok) return { outcome: { ok: true }, environment };
    if (!verdict.otherEnvironment) {
      return {
        outcome: { ok: false, gone: verdict.gone, statusCode: status },
        reason,
      };
    }
  }
  // Refused as a bad token by both gateways: no build of this app owns it.
  return {
    outcome: { ok: false, gone: true, statusCode: 400 },
    reason: "BadDeviceToken",
  };
}
