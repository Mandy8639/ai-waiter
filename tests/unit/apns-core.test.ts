import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APNS_HOSTS,
  apnsConfigFrom,
  apnsEnvironmentsToTry,
  apnsProviderToken,
  apnsRequest,
  apnsVerdict,
} from "@/lib/push/apns-core";
import { orderPayload } from "@/lib/push/dispatch-core";

/**
 * Kitchen alerts to the Tableside iOS app through APNs: the provider token
 * Apple checks, what's sent, and what Apple's answers mean for a token.
 * The HTTP/2 half (src/lib/push/apns.ts) only moves these bytes.
 */

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("apnsConfigFrom", () => {
  it("is off unless the key ID, team ID and key are all set", () => {
    expect(apnsConfigFrom({})).toBeNull();
    expect(apnsConfigFrom({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T" })).toBeNull();
    expect(
      apnsConfigFrom({ APNS_KEY_ID: "K", APNS_PRIVATE_KEY: pem }),
    ).toBeNull();
  });

  it("restores a PEM pasted into a one-line env var, and defaults the bundle ID", () => {
    const oneLine = pem.trim().replace(/\n/g, "\\n");
    const config = apnsConfigFrom({
      APNS_KEY_ID: " ABC123DEFG ",
      APNS_TEAM_ID: "TEAM123456",
      APNS_PRIVATE_KEY: oneLine,
    });
    expect(config).toEqual({
      keyId: "ABC123DEFG",
      teamId: "TEAM123456",
      privateKey: pem.trim(),
      bundleId: "menu.tableside.app",
    });
  });
});

describe("apnsProviderToken", () => {
  it("is an ES256 JWT naming the key and team, signed so the public key verifies it", () => {
    const token = apnsProviderToken(
      { keyId: "ABC123DEFG", teamId: "TEAM123456", privateKey: pem },
      1_791_700_000,
    );
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "ABC123DEFG",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: 1_791_700_000,
    });
    const raw = Buffer.from(signature, "base64url");
    // JWS wants the raw 64-byte r||s form, not DER.
    expect(raw).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        raw,
      ),
    ).toBe(true);
  });
});

describe("apnsRequest", () => {
  const payload = orderPayload({
    id: "0f0e0d0c-0b0a-4908-8706-050403020100",
    orderNumber: 42,
    itemCount: 3,
    table: { number: "5", displayName: null },
  });
  const token = "a".repeat(64);

  it("sends an alert to that device for this app, expiring with the order's relevance", () => {
    const request = apnsRequest(
      token,
      payload,
      { bundleId: "menu.tableside.app" },
      1000,
    );
    expect(request.path).toBe(`/3/device/${token}`);
    expect(request.headers).toMatchObject({
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-topic": "menu.tableside.app",
      "apns-expiration": "1600",
      "apns-collapse-id": payload.tag,
    });
    const body = JSON.parse(request.body);
    expect(body.aps.alert).toEqual({
      title: payload.title,
      body: payload.body,
    });
    expect(body.aps.sound).toBe("default");
    // The tap target, a dashboard path, for NativeAppBridge.
    expect(body.url).toBe(payload.url);
    expect(body.url.startsWith("/dashboard")).toBe(true);
  });

  it("keeps the collapse ID inside APNs's 64-byte limit", () => {
    const request = apnsRequest(
      token,
      { ...payload, tag: "x".repeat(100) },
      { bundleId: "menu.tableside.app" },
      1000,
    );
    expect(request.headers["apns-collapse-id"]).toHaveLength(64);
  });
});

describe("apnsVerdict", () => {
  it("reads Apple's answers", () => {
    expect(apnsVerdict(200)).toEqual({ ok: true });
    // The app was removed from the phone: forget the token.
    expect(apnsVerdict(410, "Unregistered")).toEqual({
      ok: false,
      gone: true,
      otherEnvironment: false,
    });
    // Usually a development-build token sent to production, or the reverse.
    expect(apnsVerdict(400, "BadDeviceToken")).toEqual({
      ok: false,
      gone: false,
      otherEnvironment: true,
    });
    // Says nothing about the device: counted, not deleted.
    for (const [status, reason] of [
      [403, "InvalidProviderToken"],
      [429, "TooManyRequests"],
      [500, "InternalServerError"],
      [400, "BadCollapseId"],
    ] as const) {
      expect(apnsVerdict(status, reason)).toEqual({
        ok: false,
        gone: false,
        otherEnvironment: false,
      });
    }
  });

  it("tries the gateway a token is known to use first, production when unknown", () => {
    expect(apnsEnvironmentsToTry(null)).toEqual(["production", "sandbox"]);
    expect(apnsEnvironmentsToTry("production")).toEqual([
      "production",
      "sandbox",
    ]);
    expect(apnsEnvironmentsToTry("sandbox")).toEqual(["sandbox", "production"]);
    expect(APNS_HOSTS.production).toBe("https://api.push.apple.com");
    expect(APNS_HOSTS.sandbox).toBe("https://api.sandbox.push.apple.com");
  });
});
