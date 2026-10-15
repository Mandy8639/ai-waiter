"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { navItemFor } from "@/lib/dashboard/access-core";
import { NAV_ITEMS } from "./nav-items";

/**
 * The kitchen account's whole navigation: the pages its role may open
 * (today Kitchen and Sold out), as big tabs instead of a sidebar, so the
 * board gets the full width of the tablet.
 */
export function KitchenTabs() {
  const pathname = usePathname();
  const activeHref = navItemFor(pathname)?.href;
  const items = NAV_ITEMS.filter(
    (item) => !item.roles || item.roles.includes("kitchen"),
  );

  return (
    <nav aria-label="Kitchen" className="flex gap-1">
      {items.map((item) => {
        const Icon = item.icon;
        const active = activeHref === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
