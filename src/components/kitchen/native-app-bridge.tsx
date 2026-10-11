"use client";

import { useEffect } from "react";
import { isSafeNotificationUrl } from "@/lib/push/dispatch-core";
import { isNativeApp } from "./native-push";

/**
 * Inside the Tableside iOS app only: tapping a kitchen alert opens the
 * dashboard page it's about, the job public/sw.js's notificationclick does
 * for web push. The URL comes from the APNs payload
 * (src/lib/push/apns-core.ts) and is checked against the same rule the
 * sender and the service worker use, so a notification can only ever lead
 * to a dashboard path. Renders nothing; in a browser it does nothing.
 */
export function NativeAppBridge() {
  useEffect(() => {
    if (!isNativeApp()) return;
    let handle: { remove: () => Promise<void> } | undefined;
    let cancelled = false;
    (async () => {
      const { PushNotifications } =
        await import("@capacitor/push-notifications");
      const listener = await PushNotifications.addListener(
        "pushNotificationActionPerformed",
        (action) => {
          const url = (
            action.notification.data as { url?: unknown } | undefined
          )?.url;
          if (typeof url === "string" && isSafeNotificationUrl(url)) {
            window.location.assign(url);
          }
        },
      );
      if (cancelled) await listener.remove();
      else handle = listener;
    })();
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, []);
  return null;
}
