/**
 * Surviving a dropped connection (offline mode, phase 1).
 *
 * A server action that can't reach the server doesn't return an error: it
 * throws (Chrome "Failed to fetch", Safari "Load failed", Firefox
 * "NetworkError…"), and inside a transition React sends that throw to the
 * error boundary, so a signal drop at the wrong moment used to replace the
 * page with "Something went wrong". Every action this app calls returns
 * its own failures as values, so a throw from one is treated as "couldn't
 * reach Tableside", whatever its message.
 *
 * Pure and free of `server-only` (tests/unit/offline-core.test.ts).
 */

/** What a guest is told when Place order / Send to kitchen didn't get through. */
export const ORDER_NOT_SENT =
  "No signal right now, so your order hasn't been sent yet. We'll send it as soon as you're back online, or you can try again.";

/**
 * What a guest is told when Add to order didn't get through. Adding isn't
 * safe to repeat on its own (it could add the dish twice if the first
 * attempt did arrive), so this asks them to check rather than retrying.
 */
export const ADD_NOT_CONFIRMED =
  "No signal right now, so we couldn't confirm that was added. Check your order once you're back online.";

/**
 * For kitchen actions that aren't saved for later (splitting, merging,
 * grouped tickets, station checkmarks): they depend on how the board
 * looks right now, so replaying them later could do the wrong thing.
 */
export const KITCHEN_NOT_SENT =
  "No connection, so that wasn't saved. Try again once the board is back online.";

/** One kitchen tap made while the board couldn't reach the server. */
export interface QueuedTap {
  orderId: string;
  target: string;
}

/**
 * Taps are kept in the order they were made and all of them are sent:
 * moving a card New → Confirmed → Preparing offline is two steps, and the
 * server only accepts them one at a time, in that order.
 */
export function enqueueTap(queue: QueuedTap[], tap: QueuedTap): QueuedTap[] {
  const last = queue[queue.length - 1];
  // The same tap twice in a row (a double press) is one tap.
  if (last && last.orderId === tap.orderId && last.target === tap.target) {
    return queue;
  }
  return [...queue, tap];
}

/**
 * After a tap the server refused while replaying, the later taps on the
 * same card can't apply either; taps on other cards still go.
 */
export function dropLaterTapsFor(
  queue: QueuedTap[],
  orderId: string,
): QueuedTap[] {
  return queue.filter((t) => t.orderId !== orderId);
}

/** "1 tap waiting to send", for the kitchen's offline banner. */
export function queuedTapsLabel(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? "1 tap waiting to send"
    : `${count} taps waiting to send`;
}

/**
 * How long the board has been offline, for the banner: under a minute the
 * reconnect is usually just a blip, so it isn't worth shouting about yet.
 */
export const OFFLINE_BANNER_AFTER_MS = 20_000;

export function shouldShowOfflineBanner(
  offlineSince: number | null,
  now: number,
): boolean {
  return offlineSince !== null && now - offlineSince >= OFFLINE_BANNER_AFTER_MS;
}

/**
 * The note on a guest page (offline mode, phase 2): whether it's the menu
 * saved on the phone, and whether the phone is offline right now. Null
 * when it's a live page and the phone is online.
 */
export function offlineMenuNote(input: {
  savedAt: number | null;
  offline: boolean;
  timeZone?: string;
}): string | null {
  const when = input.savedAt
    ? new Date(input.savedAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: input.timeZone,
      })
    : null;
  if (input.offline && when) {
    return `You're offline. This is the menu saved on your phone at ${when}. Prices and what's available are checked when you order.`;
  }
  if (input.offline) {
    return "You're offline. You can keep reading the menu; ordering will work again once you have signal.";
  }
  if (when) {
    return `The connection was slow, so this is the menu saved on your phone at ${when}.`;
  }
  return null;
}
