"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Smartphone } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StoreLinks } from "./store-links";

/**
 * What the staff app is for, who it's for, and where to get it. Shared by
 * the header's "Get the app" panel and the phone menu.
 *
 * The app works once a restaurant has an account, so it says to sign up
 * first; and guests never need it, so it says that too.
 */
export function StaffAppDetails({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-1">
        <p className="font-semibold">Tableside for Restaurants</p>
        <p className="text-muted-foreground text-sm">
          The staff app for your kitchen and floor: order alerts and the kitchen
          board on your phone.
        </p>
      </div>
      <StoreLinks />
      <p className="text-muted-foreground text-xs">
        New here?{" "}
        <Link
          href="/signup"
          className="text-primary font-medium underline-offset-4 hover:underline"
        >
          Create your free account
        </Link>{" "}
        first, then sign in on the app. Guests don&apos;t need an app; they just
        scan the table code.
      </p>
    </div>
  );
}

/**
 * The header's quiet "Get the app" item: plain text like Sign in, so
 * "Get started free" stays the one filled button. Opens a small panel;
 * closes on a click outside, on Escape (returning focus to the button),
 * and on navigation.
 */
export function GetTheAppMenu({ pathname }: { pathname: string }) {
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenOn(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenOn(null);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpenOn(open ? null : pathname)}
        className={cn(buttonVariants({ variant: "ghost" }), "gap-1.5")}
      >
        <Smartphone className="size-4" aria-hidden="true" />
        <span className="sr-only lg:not-sr-only">Get the app</span>
        <span className="sr-only">: staff app</span>
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Get the staff app"
          className="bg-popover text-popover-foreground absolute top-full right-0 z-50 mt-2 w-80 rounded-2xl border p-5 shadow-[var(--shadow-float)]"
        >
          <StaffAppDetails />
        </div>
      )}
    </div>
  );
}
