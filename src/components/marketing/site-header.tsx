"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { MARKETING_NAV } from "@/lib/marketing/content";
import { cn } from "@/lib/utils";
import { Wordmark } from "./wordmark";
import { GetTheAppMenu, StaffAppDetails } from "./get-the-app";

/**
 * Sticky header for the public pages. A client component for the phone
 * menu's and the "Get the app" panel's open state; everything else in it
 * is a plain link. The staff app lives here (and in the footer and on
 * Features) rather than in the hero, where it competed with signing up.
 */
export function SiteHeader() {
  const pathname = usePathname();
  // The phone menu remembers the page it was opened on, so navigating
  // closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;

  return (
    <header className="bg-background/85 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-4 sm:px-6">
        <Link href="/" aria-label="Tableside home" className="rounded-md">
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {MARKETING_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? "page" : undefined}
              className={cn(
                "text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm transition-colors",
                "aria-[current=page]:text-foreground aria-[current=page]:font-medium",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-1 md:flex lg:gap-2">
          <GetTheAppMenu pathname={pathname} />
          <Link href="/login" className={buttonVariants({ variant: "ghost" })}>
            Sign in
          </Link>
          <Link href="/signup" className={buttonVariants()}>
            Get started free
          </Link>
        </div>

        <button
          type="button"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-lg" }),
            "md:hidden",
          )}
          aria-expanded={open}
          aria-controls="mk-mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpenOn(open ? null : pathname)}
        >
          {open ? <X /> : <Menu />}
        </button>
      </div>

      {open ? (
        <nav
          id="mk-mobile-nav"
          aria-label="Main"
          className="bg-background border-t px-4 pt-2 pb-5 md:hidden"
        >
          <ul className="flex flex-col">
            {MARKETING_NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block border-b py-3 text-base"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Link
              href="/login"
              className={buttonVariants({ variant: "outline", size: "lg" })}
            >
              Sign in
            </Link>
            <Link href="/signup" className={buttonVariants({ size: "lg" })}>
              Get started free
            </Link>
          </div>
          <div className="mt-6 flex flex-col gap-3 border-t pt-5">
            <p className="mk-eyebrow text-muted-foreground">Staff app</p>
            <StaffAppDetails />
          </div>
        </nav>
      ) : null}
    </header>
  );
}
