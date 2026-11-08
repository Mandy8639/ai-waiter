"use client";

import { useState } from "react";
import { Check, Copy, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * The restaurant's guest Wi-Fi for a seated guest: the network name and a
 * password to copy. Phones can't be told to join a network from a web
 * page, so this is for typing it in (or pasting); the camera code on the
 * table card does the joining for people who use that.
 */
export function GuestWifiButton({
  ssid,
  password,
}: {
  ssid: string;
  password: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an old browser or a denied permission): the
      // password is on screen to type instead.
    }
  }

  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label="Wi-Fi details"
            className="type-label text-muted-foreground hover:text-foreground hover:bg-muted flex h-9 items-center gap-1.5 rounded-lg px-2.5 transition-colors"
          >
            <Wifi className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Wi-Fi</span>
          </button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Free Wi-Fi</DialogTitle>
          <DialogDescription>
            Join it in your phone&apos;s Wi-Fi settings.
          </DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <dt className="type-caption text-muted-foreground">Network</dt>
            <dd className="font-medium break-all">{ssid}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="type-caption text-muted-foreground">Password</dt>
            {password ? (
              <dd className="flex items-center justify-between gap-3">
                <span className="font-mono break-all">{password}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copy()}
                >
                  {copied ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </dd>
            ) : (
              <dd>None needed</dd>
            )}
          </div>
        </dl>
      </DialogContent>
    </Dialog>
  );
}
