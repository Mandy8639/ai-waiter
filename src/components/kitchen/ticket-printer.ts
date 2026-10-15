"use client";

import { useCallback, useEffect, useState } from "react";
import { PAPER_WIDTHS, type PaperWidth } from "@/lib/kitchen/ticket-core";

/**
 * Prints a ticket (src/lib/kitchen/ticket-core.ts) through the device's
 * own print system: the ticket is loaded into an invisible frame and that
 * frame alone is printed, so the board itself never ends up on paper.
 *
 * One at a time: a rush of orders queues up rather than opening several
 * print dialogs over each other. A browser started for kiosk printing
 * (Chrome's --kiosk-printing) sends each one straight to the default
 * printer with no dialog — the setup for a till.
 */

const queue: string[] = [];
let busy = false;

function printNext() {
  const html = queue.shift();
  if (html === undefined) {
    busy = false;
    return;
  }
  busy = true;

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    // Removed a moment later: some browsers still read the frame just
    // after the dialog closes.
    setTimeout(() => frame.remove(), 1_000);
    printNext();
  };

  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return finish();
    win.addEventListener("afterprint", finish);
    // A dialog nobody answers mustn't hold up every later ticket for good.
    setTimeout(finish, 60_000);
    win.focus();
    win.print();
  };
  frame.srcdoc = html;
  document.body.appendChild(frame);
}

export function printTicket(html: string) {
  queue.push(html);
  if (!busy) printNext();
}

/**
 * The store apps' built-in browser has no print system to hand a page to,
 * so the controls are only offered in a real browser.
 */
export function canPrintHere(): boolean {
  if (typeof navigator === "undefined") return false;
  return !/TablesideApp\//.test(navigator.userAgent);
}

export interface PrinterSettings {
  /** Print each new order as it arrives, on this device only. */
  autoPrint: boolean;
  paper: PaperWidth;
}

const DEFAULTS: PrinterSettings = { autoPrint: false, paper: "80mm" };

function storageKey(restaurantId: string) {
  return `tableside:printer:${restaurantId}`;
}

/**
 * Remembered per device and per restaurant, like the board's station
 * choice: the till with the printer auto-prints, the tablet on the pass
 * doesn't, and both are signed in to the same restaurant.
 */
export function usePrinterSettings(restaurantId: string) {
  const [settings, setSettings] = useState<PrinterSettings>(DEFAULTS);
  const [available, setAvailable] = useState(false);

  // Read after mount to match the server render; storage can throw.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvailable(canPrintHere());
    try {
      const raw = window.localStorage.getItem(storageKey(restaurantId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PrinterSettings>;
      setSettings({
        autoPrint: parsed.autoPrint === true,
        paper: PAPER_WIDTHS.includes(parsed.paper as PaperWidth)
          ? (parsed.paper as PaperWidth)
          : DEFAULTS.paper,
      });
    } catch {
      // Private mode or blocked storage: defaults for this visit.
    }
  }, [restaurantId]);

  const update = useCallback(
    (next: Partial<PrinterSettings>) => {
      setSettings((prev) => {
        const merged = { ...prev, ...next };
        try {
          window.localStorage.setItem(
            storageKey(restaurantId),
            JSON.stringify(merged),
          );
        } catch {
          // Not remembered; still applied for this visit.
        }
        return merged;
      });
    },
    [restaurantId],
  );

  return { settings, update, available };
}
