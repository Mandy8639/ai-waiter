"use client";

/**
 * Kitchen alerts inside the Tableside iOS app (ios/, Capacitor). The
 * browser Push API doesn't exist in an iOS app's web view, so the app
 * registers with Apple (APNs) natively and the server sends there
 * (src/lib/push/apns.ts). Used by PushAlertsToggle when it finds itself in
 * the app; in a browser nothing here runs, and the plugin code is only
 * loaded on demand so browsers never download it.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal })
    .Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

// The token this phone registered, remembered so "Turn off" can remove
// exactly this phone's row and the toggle knows it's on.
const TOKEN_KEY = "tableside_apns_token";

export function rememberedToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function forgetToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be unavailable; the server row is what matters.
  }
}

async function plugin() {
  const { PushNotifications } = await import("@capacitor/push-notifications");
  return PushNotifications;
}

export type NativePermission = "granted" | "denied" | "prompt";

export async function nativePermission(): Promise<NativePermission> {
  const PushNotifications = await plugin();
  const { receive } = await PushNotifications.checkPermissions();
  return receive === "granted"
    ? "granted"
    : receive === "denied"
      ? "denied"
      : "prompt";
}

/**
 * Asks (from a button press, never on load), then registers with APNs and
 * resolves with the device token. Rejects with "denied" if the person said
 * no.
 */
export async function registerForNativePush(): Promise<string> {
  const PushNotifications = await plugin();
  const { receive } = await PushNotifications.requestPermissions();
  if (receive !== "granted") throw new Error("denied");

  const token = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      void registration.then((h) => h.remove());
      void failure.then((h) => h.remove());
      fn();
    };
    const registration = PushNotifications.addListener("registration", (t) =>
      done(() => resolve(t.value)),
    );
    const failure = PushNotifications.addListener("registrationError", (e) =>
      done(() => reject(new Error(e.error))),
    );
    void PushNotifications.register();
    setTimeout(() => done(() => reject(new Error("timeout"))), 15_000);
  });

  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // See forgetToken.
  }
  return token;
}
