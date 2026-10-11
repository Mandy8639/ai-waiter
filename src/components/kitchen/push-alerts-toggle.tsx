"use client";

import { useEffect, useState, useTransition } from "react";
import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  deleteNativePushToken,
  deletePushSubscription,
  saveNativePushToken,
  savePushSubscription,
  sendTestPushToMyDevices,
} from "@/lib/push/actions";
import {
  forgetToken,
  isNativeApp,
  nativePermission,
  registerForNativePush,
  rememberedToken,
} from "./native-push";

/**
 * "Turn on alerts for this device" on the kitchen board (phase F).
 *
 * THE PERMISSION PROMPT IS ONLY EVER SHOWN BECAUSE SOMEONE PRESSED THE
 * BUTTON. A browser remembers a "Block" forever and most people can't find
 * where to undo it, so asking on page load — the moment a cook is looking
 * at orders, not at settings — would lose that device for good. Nothing in
 * this component calls Notification.requestPermission() except the click
 * handler.
 *
 * Every state says what to do next, because a kitchen tablet is set up once
 * by whoever is there and then never looked at again:
 *   unsupported  — this browser can't do push (iPhone/iPad: add to Home
 *                  Screen first).
 *   blocked      — the person pressed Block once; only the browser's own
 *                  site settings can undo it.
 *   off / on     — the normal toggle, plus a test button when on.
 */

type State =
  "checking" | "unsupported" | "ios-needs-install" | "blocked" | "off" | "on";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function isIosNotInstalled(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}

export function PushAlertsToggle({
  restaurantId,
  nativeAlerts = false,
}: {
  restaurantId: string;
  /** True when the server can send to the iOS app (APNs configured). */
  nativeAlerts?: boolean;
}) {
  const [state, setState] = useState<State>("checking");
  // Inside the Tableside iOS app: Apple's own push instead of the
  // browser's (./native-push.ts). Decided once, on the client.
  const [native, setNative] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isNativeApp()) {
        const permission = await nativePermission().catch(() => "prompt");
        if (!cancelled) {
          setNative(true);
          setState(
            permission === "denied"
              ? "blocked"
              : permission === "granted" && rememberedToken()
                ? "on"
                : "off",
          );
        }
        return;
      }
      const supported =
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window;
      let next: State;
      if (!supported) {
        next = isIosNotInstalled() ? "ios-needs-install" : "unsupported";
      } else if (Notification.permission === "denied") {
        next = "blocked";
      } else {
        next = (await currentSubscription()) ? "on" : "off";
      }
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // No keys configured for this deployment: the feature is off, and a
  // button that can only fail is worse than no button.
  if (state === "checking") return null;
  if (native ? !nativeAlerts : !VAPID_PUBLIC_KEY) return null;

  function turnOn() {
    setMessage(null);
    if (native) {
      startTransition(async () => {
        try {
          // iOS's permission prompt, from a click and nowhere else.
          const token = await registerForNativePush();
          const result = await saveNativePushToken(restaurantId, token);
          if (!result.ok) {
            setMessage(result.error ?? "Couldn't turn alerts on.");
            return;
          }
          setState("on");
          setMessage("Alerts are on for this device.");
        } catch (error) {
          if (error instanceof Error && error.message === "denied") {
            setState("blocked");
          } else {
            setMessage(
              "This device couldn't turn alerts on. Please try again.",
            );
          }
        }
      });
      return;
    }
    startTransition(async () => {
      // The permission prompt, from a click and nowhere else.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        await navigator.serviceWorker.ready;
        const subscription =
          (await registration.pushManager.getSubscription()) ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          }));
        const result = await savePushSubscription(
          restaurantId,
          subscription.toJSON(),
        );
        if (!result.ok) {
          setMessage(result.error ?? "Couldn't turn alerts on.");
          return;
        }
        setState("on");
        setMessage("Alerts are on for this device.");
      } catch {
        setMessage(
          "This browser couldn't turn alerts on. Try another browser.",
        );
      }
    });
  }

  function turnOff() {
    setMessage(null);
    if (native) {
      startTransition(async () => {
        const token = rememberedToken();
        if (token) await deleteNativePushToken(token);
        forgetToken();
        setState("off");
        setMessage("Alerts are off for this device.");
      });
      return;
    }
    startTransition(async () => {
      const subscription = await currentSubscription();
      if (subscription) {
        await deletePushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState("off");
      setMessage("Alerts are off for this device.");
    });
  }

  function sendTest() {
    setMessage(null);
    startTransition(async () => {
      const result = await sendTestPushToMyDevices(restaurantId);
      setMessage(
        !result.ok
          ? (result.error ?? "The test didn't go through.")
          : result.total === 1
            ? "Test sent to this device."
            : `Test sent to ${result.delivered} of your ${result.total} devices.`,
      );
    });
  }

  return (
    <div className="bg-card flex flex-col gap-2 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        {state === "on" ? (
          <Bell className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
        ) : (
          <BellOff
            className="text-muted-foreground mt-0.5 size-4 shrink-0"
            aria-hidden
          />
        )}
        <div className="text-sm">
          <p className="font-medium">
            {state === "on"
              ? "Alerts are on for this device"
              : "Get alerts on this device"}
          </p>
          <p className="text-muted-foreground">
            {state === "unsupported" &&
              "This browser can't show alerts. Chrome, Edge or Firefox can."}
            {state === "ios-needs-install" &&
              "On iPhone or iPad: tap Share, then “Add to Home Screen”, and open Tableside from there to turn alerts on."}
            {state === "blocked" &&
              (native
                ? "Notifications are off for Tableside. Turn them on in Settings → Tableside → Notifications."
                : "Notifications are blocked for this site. Allow them in the browser's site settings, then reload.")}
            {state === "off" &&
              (native
                ? "New orders and table requests, even when the app is closed."
                : "New orders and table requests, even when this tab is closed.")}
            {state === "on" &&
              (native
                ? "New orders and table requests, even when the app is closed. Not seeing them? Check Focus and Do Not Disturb."
                : "New orders and table requests, even when this tab is closed. Not seeing them? Check the device's own notification settings and Do Not Disturb.")}
          </p>
          {message && (
            <p className="text-muted-foreground mt-1" role="status">
              {message}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {state === "off" && (
          <Button size="sm" onClick={turnOn} disabled={isPending}>
            {isPending ? "Turning on…" : "Turn on alerts"}
          </Button>
        )}
        {state === "on" && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={sendTest}
              disabled={isPending}
            >
              Send a test
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={turnOff}
              disabled={isPending}
            >
              Turn off
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
