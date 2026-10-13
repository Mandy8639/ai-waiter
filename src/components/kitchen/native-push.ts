"use client";

/**
 * Kitchen alerts inside the Tableside store apps (ios/ and android/,
 * Capacitor). An app's web view has no browser Push API, so the app
 * registers natively: with Apple (APNs, src/lib/push/apns.ts) on iPhone,
 * with Firebase (FCM, src/lib/push/fcm.ts) on Android, where the app's
 * own service makes orders ring until accepted. Used by PushAlertsToggle
 * when it finds itself in an app; in a browser nothing here runs, and the
 * plugin code is only loaded on demand so browsers never download it.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
}

/**
 * Whether the app's native push plugin answers this page at all. False
 * means the page is in the app but the native bridge isn't connected to
 * it, so a permission check would never come back.
 */
export function pushPluginAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal })
    .Capacitor;
  return capacitor?.isPluginAvailable?.("PushNotifications") === true;
}

/**
 * A native call that never answers would leave the alerts card waiting
 * forever (it renders nothing while checking), so every call gets a
 * deadline and fails with a short code the card can show.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, code: string) {
  return Promise.race<T>([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(code)), ms),
    ),
  ]);
}

export function isNativeApp(): boolean {
  return nativePlatform() !== null;
}

/** Which store app this page is running in, if any. */
export function nativePlatform(): "ios" | "android" | null {
  if (typeof window === "undefined") return null;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal })
    .Capacitor;
  if (capacitor?.isNativePlatform?.() !== true) return null;
  const platform = capacitor.getPlatform?.();
  return platform === "ios" || platform === "android" ? platform : null;
}

// The token this phone registered, remembered so "Turn off" can remove
// exactly this phone's row and the toggle knows it's on.
const TOKEN_KEY = "tableside_native_push_token";

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

/**
 * The plugin, WRAPPED. A Capacitor plugin object answers any method name,
 * "then" included, so returning it bare from an async function makes
 * JavaScript treat it as a promise and wait on it forever (the alerts
 * card's "load-timeout"). Wrapped in a plain object, it's just a value.
 */
async function plugin() {
  const { PushNotifications } = await import("@capacitor/push-notifications");
  return { push: PushNotifications };
}

export type NativePermission = "granted" | "denied" | "prompt";

export async function nativePermission(): Promise<NativePermission> {
  const { push: PushNotifications } = await withDeadline(
    plugin(),
    5_000,
    "load-timeout",
  );
  const { receive } = await withDeadline(
    PushNotifications.checkPermissions(),
    5_000,
    "check-timeout",
  );
  return receive === "granted"
    ? "granted"
    : receive === "denied"
      ? "denied"
      : "prompt";
}

/**
 * Asks (from a button press, never on load), then registers with APNs or
 * FCM and resolves with the device token. Rejects with "denied" if the person said
 * no.
 */
export async function registerForNativePush(): Promise<string> {
  const { push: PushNotifications } = await withDeadline(
    plugin(),
    5_000,
    "load-timeout",
  );
  // Long enough for someone to read and answer Android's permission dialog.
  const { receive } = await withDeadline(
    PushNotifications.requestPermissions(),
    60_000,
    "ask-timeout",
  );
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
    setTimeout(() => done(() => reject(new Error("register-timeout"))), 15_000);
  });

  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // See forgetToken.
  }
  return token;
}
