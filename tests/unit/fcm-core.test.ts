import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OAUTH_TOKEN_URL,
  fcmAssertion,
  fcmConfigFrom,
  fcmRequestBody,
  fcmSendUrl,
  fcmVerdict,
  normalizePrivateKey,
  privateKeyShape,
} from "@/lib/push/fcm-core";
import { orderPayload, orderRingPayload } from "@/lib/push/dispatch-core";

/**
 * Kitchen alerts to the Tableside Android app through Firebase Cloud
 * Messaging: the service-account assertion Google checks, the data-only
 * messages the app's own service turns into a ringing alert (or silences),
 * and what FCM's answers mean for a token.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const config = {
  projectId: "tableside-app",
  clientEmail: "sender@tableside-app.iam.gserviceaccount.com",
  privateKey: pem,
};
const order = {
  id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  orderNumber: 42,
  itemCount: 3,
  table: { number: "5", displayName: null },
};

describe("fcmConfigFrom", () => {
  it("needs all three values, and restores the key's line breaks", () => {
    expect(fcmConfigFrom({})).toBeNull();
    expect(
      fcmConfigFrom({ FCM_PROJECT_ID: "p", FCM_CLIENT_EMAIL: "e" }),
    ).toBeNull();
    const parsed = fcmConfigFrom({
      FCM_PROJECT_ID: " tableside-app ",
      FCM_CLIENT_EMAIL: config.clientEmail,
      FCM_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
    });
    expect(parsed).toEqual({ ...config, privateKey: pem.trim() });
  });
});

describe("normalizePrivateKey: the ways a pasted key arrives", () => {
  const oneLine = pem.trim().replace(/\n/g, "\\n");
  const variants: Array<[string, string]> = [
    ["one line with \\n, as in the JSON file", oneLine],
    ["wrapped in the JSON file's quotes", `"${oneLine}"`],
    ["double-escaped \\\\n", pem.trim().replace(/\n/g, "\\\\n")],
    ["real line breaks", pem],
    ["Windows line endings", pem.replace(/\n/g, "\r\n")],
    ["with spaces around it", `  ${oneLine}  `],
    // A one-line input box can turn the line breaks into spaces.
    ["line breaks turned into spaces", pem.trim().replace(/\n/g, " ")],
    ["no line breaks at all", pem.trim().replace(/\n/g, "")],
    [
      "quoted, with escaped quotes and a trailing comma from the JSON",
      `\\"${oneLine}\\",`,
    ],
    [
      "the whole service-account JSON",
      JSON.stringify({ type: "service_account", private_key: pem }),
    ],
    // Production, 2026-10-16: the whole key except its BEGIN/END lines.
    [
      "only the body, BEGIN and END lines left out",
      pem.trim().split("\n").slice(1, -1).join("\\n"),
    ],
  ];

  it.each(variants)("%s → a key that signs", (_label, raw) => {
    const key = normalizePrivateKey(raw);
    expect(key).toBe(pem.trim());
    const jwt = fcmAssertion({ ...config, privateKey: key! }, 1_000);
    const [header, claims, signature] = jwt.split(".");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("describes a key's shape without revealing it", () => {
    const shape = privateKeyShape(oneLine);
    expect(shape).toMatchObject({
      has_begin: true,
      has_end: true,
      real_newlines: 0,
      starts_json: false,
    });
    expect(shape.escaped_newlines).toBeGreaterThan(20);
    expect(JSON.stringify(shape)).not.toMatch(/MII|BEGIN PRIVATE/);
  });

  it("leaves something that isn't a key body alone, to fail on its own", () => {
    expect(normalizePrivateKey("not-a-key")).toBe("not-a-key");
  });

  it("treats empty as missing", () => {
    expect(normalizePrivateKey(undefined)).toBeNull();
    expect(normalizePrivateKey("   ")).toBeNull();
    expect(normalizePrivateKey('""')).toBeNull();
  });
});

describe("fcmAssertion", () => {
  it("is an RS256 JWT for the messaging scope, signed by the service account, valid an hour", () => {
    const jwt = fcmAssertion(config, 1_000);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: OAUTH_TOKEN_URL,
      iat: 1_000,
      exp: 4_600,
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });
});

describe("fcmRequestBody", () => {
  const token = "f".repeat(150);

  it("sends a ringing order as data only, high priority, for ten minutes", () => {
    const { message } = JSON.parse(
      fcmRequestBody(token, { kind: "alert", payload: orderPayload(order) }),
    );
    expect(message.token).toBe(token);
    // No "notification" block: the app builds the alert itself, so it can
    // ring until touched instead of the system showing it once.
    expect(message.notification).toBeUndefined();
    expect(message.android).toEqual({ priority: "HIGH", ttl: "600s" });
    expect(message.data).toEqual({
      kind: "alert",
      title: "New order #42",
      body: "Table 5 · 3 items",
      url: "/dashboard/kitchen",
      tag: `order-${order.id}`,
      group: `order-${order.id}`,
      urgent: "1",
    });
    for (const value of Object.values(message.data)) {
      expect(typeof value).toBe("string");
    }
  });

  it("keeps a repeat in the order's group, so it replaces the alert on the phone", () => {
    const { message } = JSON.parse(
      fcmRequestBody(token, {
        kind: "alert",
        payload: orderRingPayload(order, 2),
      }),
    );
    expect(message.data.group).toBe(`order-${order.id}`);
    expect(message.data.title).toBe("Order #42 is waiting");
  });

  it("silences an order's alert with a stop for its group", () => {
    const { message } = JSON.parse(
      fcmRequestBody(token, { kind: "stop", group: `order-${order.id}` }),
    );
    expect(message.data).toEqual({ kind: "stop", group: `order-${order.id}` });
    expect(message.android.priority).toBe("HIGH");
  });

  it("posts to the project's v1 endpoint", () => {
    expect(fcmSendUrl(config)).toBe(
      "https://fcm.googleapis.com/v1/projects/tableside-app/messages:send",
    );
  });
});

describe("fcmVerdict", () => {
  it("forgets only a token FCM says is gone", () => {
    expect(fcmVerdict(200)).toEqual({ ok: true });
    expect(fcmVerdict(404, "NOT_FOUND")).toEqual({ ok: false, gone: true });
    expect(fcmVerdict(400, "UNREGISTERED")).toEqual({ ok: false, gone: true });
    // Could be our own message's fault: count it, don't delete the phone.
    expect(fcmVerdict(400, "INVALID_ARGUMENT")).toEqual({
      ok: false,
      gone: false,
    });
    expect(fcmVerdict(500)).toEqual({ ok: false, gone: false });
    expect(fcmVerdict(401)).toEqual({ ok: false, gone: false });
  });
});
