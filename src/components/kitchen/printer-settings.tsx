"use client";

import { useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { PAPER_WIDTHS, type PaperWidth } from "@/lib/kitchen/ticket-core";
import type { PrinterSettings } from "./ticket-printer";

/**
 * This device's printer settings, from the kitchen board. Per device on
 * purpose: only the screen next to the printer should auto-print.
 */
export function PrinterSettingsButton({
  settings,
  onChange,
  onTestPrint,
}: {
  settings: PrinterSettings;
  onChange: (next: Partial<PrinterSettings>) => void;
  onTestPrint: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            <Printer className="size-4" aria-hidden="true" />
            {settings.autoPrint ? "Printing on" : "Printer"}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ticket printer</DialogTitle>
          <DialogDescription>
            For this device only. Turn auto-print on just on the screen that has
            the printer connected.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block font-medium">Auto-print new orders</span>
              <span className="text-muted-foreground block text-sm">
                Prints a kitchen ticket for every new order while this board is
                open.
              </span>
            </span>
            <Switch
              checked={settings.autoPrint}
              onCheckedChange={(checked) => onChange({ autoPrint: checked })}
            />
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium">Paper width</legend>
            <div className="grid grid-cols-2 gap-2">
              {PAPER_WIDTHS.map((paper: PaperWidth) => (
                <Button
                  key={paper}
                  type="button"
                  variant={settings.paper === paper ? "default" : "outline"}
                  aria-pressed={settings.paper === paper}
                  className="min-h-11"
                  onClick={() => onChange({ paper })}
                >
                  {paper}
                  {paper === "80mm" ? " (most)" : " (small)"}
                </Button>
              ))}
            </div>
          </fieldset>

          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onTestPrint}
          >
            <Printer className="size-4" aria-hidden="true" />
            Print a test ticket
          </Button>

          <div className="text-muted-foreground bg-muted rounded-md p-3 text-sm">
            <p className="text-foreground font-medium">
              Printing without a pop-up each time
            </p>
            <p className="mt-1">
              Set the receipt printer as this computer&apos;s default printer,
              then open Tableside in Chrome started with kiosk printing. Every
              ticket then prints straight away. Without it, Chrome asks once per
              ticket; choose the receipt printer and press Print.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
