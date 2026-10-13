"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog for the QR sheet. */
export function PrintSheetButton() {
  return (
    <Button type="button" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      Print
    </Button>
  );
}
