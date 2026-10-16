"use client";

import { useEffect, useState, useTransition } from "react";
import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  deleteNativePushToken,
  deletePushSubscription,
  saveNativePushToken,
  savePushSubscription,
  sendTestPushToMyDevices,
} from "@/lib/push/actions";
import {
  forgetToken,
  nativePlatform,
  pushPluginAvailable,
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
  nativeAlerts = { ios: false, android: false },
}: {
  restaurantId: string;
  /** Which store apps the server can send to (APNs / FCM configured). */
  nativeAlerts?: { ios: boolean; android: boolean };
}) {
  const [state, setState] = useState<State>("checking");
  // Inside a Tableside store app: the platform's own push instead of the
  // browser's (./native-push.ts). Decided once, on the client.
  const [native, setNative] = useState<"ios" | "android" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const iosAlerts = nativeAlerts.ios;
  const androidAlerts = nativeAlerts.android;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const platform = nativePlatform();
      if (platform) {
        // Say why instead of hiding the card when the app's native side
        // doesn't answer (codes come from ./native-push.ts).
        let note: string | null = null;
        let permission: "granted" | "denied" | "prompt" = "prompt";
        if (!pushPluginAvailable()) {
          note =
            "This version of the app can't reach its alerts plugin (no-plugin).";
        } else {
          try {
            permission = await nativePermission();
          } catch (error) {
            note = `The app didn't answer the permission check (${error instanceof Error ? error.message : "error"}). Tap to try anyway.`;
          }
        }
        // A phone that already has alerts on (for any restaurant) is
        // registered for THIS one too, so someone in several restaurants
        // hears all of them, and the card only says "on" once the server
        // has this phone for the restaurant on screen.
        const token = rememberedToken();
        let next: State = permission === "denied" ? "blocked" : "off";
        const platformAlerts = platform === "ios" ? iosAlerts : androidAlerts;
        if (permission === "granted" && token && platformAlerts) {
          const saved = await saveNativePushToken(
            restaurantId,
            token,
            platform,
          ).catch(() => ({ ok: false as const, error: undefined }));
          next = saved.ok ? "on" : "off";
        }
        if (!cancelled) {
          if (note) setMessage(note);
          setNative(platform);
          setState(next);
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
        // Same rule as the apps: an existing subscription is registered
        // for the restaurant on screen before the card says "on".
        const subscription = await currentSubscription();
        next = "off";
        if (subscription && VAPID_PUBLIC_KEY) {
          const saved = await savePushSubscription(
            restaurantId,
            subscription.toJSON(),
          ).catch(() => ({ ok: false as const }));
          next = saved.ok ? "on" : "off";
        }
      }
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [restaurantId, iosAlerts, androidAlerts]);

  // No keys configured for this deployment: the feature is off, and a
  // button that can only fail is worse than no button.
  if (state === "checking") return null;
  if (native ? !nativeAlerts[native] : !VAPID_PUBLIC_KEY) return null;

  function turnOn() {
    setMessage(null);
    if (native) {
      startTransition(async () => {
        try {
          // iOS's permission prompt, from a click and nowhere else.
          const token = await registerForNativePush();
          const result = await saveNativePushToken(restaurantId, token, native);
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
              `This device couldn't turn alerts on (${error instanceof Error ? error.message : "error"}). Please try again.`,
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

  // A small button in the kitchen board's toolbar rather than a card of its
  // own: once alerts are on there is nothing to read, and the card pushed
  // the board down on a phone. Off is the one state that wants attention,
  // so it is the filled button. The details and actions open in a dialog.
  const chip =
    state === "on"
      ? { label: "Alerts on", on: true, filled: false }
      : state === "off"
        ? { label: "Turn on alerts", on: false, filled: true }
        : state === "blocked"
          ? { label: "Alerts blocked", on: false, filled: false }
          : { label: "Get alerts", on: false, filled: false };

  const description =
    state === "unsupported"
      ? "This browser can't show alerts. Chrome, Edge or Firefox can."
      : state === "ios-needs-install"
        ? "On iPhone or iPad: tap Share, then “Add to Home Screen”, and open Tableside from there to turn alerts on."
        : state === "blocked"
          ? native === "android"
            ? "Notifications are off for Tableside. Turn them on in Settings → Apps → Tableside → Notifications."
            : native
              ? "Notifications are off for Tableside. Turn them on in Settings → Tableside → Notifications."
              : "Notifications are blocked for this site. Allow them in the browser's site settings, then reload."
          : state === "off"
            ? native
              ? "New orders and table requests, even when the app is closed."
              : "New orders and table requests, even when this tab is closed."
            : native
              ? "New orders and table requests, even when the app is closed. Not seeing them? Check Focus and Do Not Disturb."
              : "New orders and table requests, even when this tab is closed. Not seeing them? Check the device's own notification settings and Do Not Disturb.";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant={chip.filled ? "default" : "outline"}
          >
            {chip.on ? (
              <Bell className="size-4" aria-hidden />
            ) : (
              <BellOff className="size-4" aria-hidden />
            )}
            {chip.label}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state === "on"
              ? "Alerts are on for this device"
              : "Get alerts on this device"}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {message && (
          <p className="text-muted-foreground text-sm" role="status">
            {message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {state === "off" && (
            <Button onClick={turnOn} disabled={isPending} className="min-h-11">
              {isPending ? "Turning on…" : "Turn on alerts"}
            </Button>
          )}
          {state === "on" && (
            <>
              <Button
                variant="outline"
                onClick={sendTest}
                disabled={isPending}
                className="min-h-11"
              >
                Send a test
              </Button>
              <Button
                variant="ghost"
                onClick={turnOff}
                disabled={isPending}
                className="min-h-11"
              >
                Turn off
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
