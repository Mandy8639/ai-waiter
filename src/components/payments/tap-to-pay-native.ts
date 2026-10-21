"use client";

import {
  cancelTapToPay,
  finishTapToPay,
  getTapToPayConnection,
  startTapToPay,
} from "@/lib/payments/tap-to-pay";

/**
 * Tap to Pay on the staff app's own phone (Stripe Terminal, through the
 * Capacitor plugin). In a browser none of this runs: the plugin is only
 * loaded on demand inside the store apps, like native push
 * (src/components/kitchen/native-push.ts).
 *
 * NEVER return the plugin object from an async function: a Capacitor
 * plugin answers any method, `then` included, so awaiting it hangs forever
 * (the 2026-10-13 push bug). It travels wrapped as `{ terminal }`.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
}

/** Whether this page runs in a store app that has the Tap to Pay plugin. */
export function tapToPayAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const c = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return (
    c?.isNativePlatform?.() === true &&
    c.isPluginAvailable?.("StripeTerminal") === true
  );
}

type Plugin = typeof import("@capacitor-community/stripe-terminal");

async function loadPlugin(): Promise<{ mod: Plugin }> {
  return { mod: await import("@capacitor-community/stripe-terminal") };
}

/** The SDK is set up once per app session and per restaurant. */
let readyFor: string | null = null;

async function connectReader(restaurantId: string, mod: Plugin) {
  const { StripeTerminal, TerminalConnectTypes, TerminalEventsEnum } = mod;
  if (readyFor === restaurantId) {
    const { reader } = await StripeTerminal.getConnectedReader();
    if (reader) return;
  }

  const first = await getTapToPayConnection(restaurantId);
  if (!first.ok) throw new Error(first.error);

  if (readyFor === null) {
    // The SDK asks for a fresh token whenever it needs one; the first ask
    // gets the token already fetched with the location.
    let spare: string | null = first.secret;
    await StripeTerminal.addListener(
      TerminalEventsEnum.RequestedConnectionToken,
      async () => {
        let token = spare;
        spare = null;
        if (token === null) {
          const fresh = await getTapToPayConnection(restaurantId);
          token = fresh.ok ? fresh.secret : "";
        }
        await StripeTerminal.setConnectionToken({ token });
      },
    );
    await StripeTerminal.initialize({ isTest: first.simulated });
  }
  readyFor = restaurantId;

  const { readers } = await StripeTerminal.discoverReaders({
    type: TerminalConnectTypes.TapToPay,
    locationId: first.locationId,
  });
  const reader = readers[0];
  if (!reader) {
    throw new Error(
      "This phone can't take Tap to Pay. It needs NFC switched on (Android 11 or newer, or iPhone XS or newer).",
    );
  }
  await StripeTerminal.connectReader({ reader });
}

export type TapStep = "preparing" | "tap" | "checking";

/**
 * Takes payment for a table: prepares the phone, shows the system's tap
 * screen, then has the server confirm with Stripe. Resolves once the table
 * is marked paid; throws with a sentence a server can read out otherwise.
 */
export async function collectTapPayment(input: {
  restaurantId: string;
  orderIds: string[];
  tip: string;
  onStep: (step: TapStep) => void;
}): Promise<void> {
  const { mod } = await loadPlugin();
  const { StripeTerminal } = mod;

  input.onStep("preparing");
  await connectReader(input.restaurantId, mod);

  const started = await startTapToPay(
    input.restaurantId,
    input.orderIds,
    input.tip,
  );
  if (!started.ok) throw new Error(started.error);

  try {
    input.onStep("tap");
    await StripeTerminal.collectPaymentMethod({
      paymentIntent: started.clientSecret,
    });
    input.onStep("checking");
    await StripeTerminal.confirmPaymentIntent();
  } catch (error) {
    await cancelTapToPay(input.restaurantId, started.paymentId);
    throw new Error(friendlyTerminalError(error));
  }

  const finished = await finishTapToPay(input.restaurantId, started.paymentId);
  if (!finished.ok) throw new Error(finished.error);
  if (finished.outcome !== "paid") {
    await cancelTapToPay(input.restaurantId, started.paymentId);
    throw new Error("The card was declined. Try another card.");
  }
}

/** Stops a tap that's waiting for a card. */
export async function cancelTapCollection(): Promise<void> {
  const { mod } = await loadPlugin();
  await mod.StripeTerminal.cancelCollectPaymentMethod().catch(() => {});
}

function friendlyTerminalError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/cancel/i.test(text)) return "Payment cancelled. Nothing was charged.";
  if (/declin/i.test(text)) return "The card was declined. Try another card.";
  if (/timeout|timed out/i.test(text)) {
    return "No card was tapped in time. Nothing was charged.";
  }
  return "The tap didn't go through. Nothing was charged; please try again.";
}
