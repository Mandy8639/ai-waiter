"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, NAV_ITEMS } from "./nav-items";
import { navItemFor } from "@/lib/dashboard/access-core";
import { PendingRequestsBadge } from "./pending-requests-badge";
import type { RestaurantRole } from "@/lib/restaurants/get-user-restaurants";

export function DashboardNav({
  role,
  onNavigate,
  className,
  restaurantId,
  pendingRequestCount,
  showAdmin = false,
}: {
  role: RestaurantRole;
  /** The platform owner's /admin link. Presentation only: the page checks for itself. */
  showAdmin?: boolean;
  onNavigate?: () => void;
  className?: string;
  /** Present only when this viewer can see reservations at all — see the layout. */
  restaurantId?: string;
  pendingRequestCount?: number;
}) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter(
    (item) => !item.roles || item.roles.includes(role),
  );
  const activeHref = navItemFor(pathname)?.href;

  return (
    <nav
      aria-label="Dashboard"
      className={cn("flex flex-col gap-5", className)}
    >
      {NAV_GROUPS.map((group) => {
        const groupItems = items.filter((item) => item.group === group);
        if (groupItems.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-0.5">
            <p className="type-overline text-muted-foreground px-3 pb-1.5">
              {group}
            </p>
            {groupItems.map((item) => {
              // The deepest matching item, so Sold out
              // (/dashboard/kitchen/sold-out) doesn't also light up Kitchen.
              const isActive = activeHref === item.href;
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "type-label flex h-9 items-center gap-2.5 rounded-lg px-3 text-[0.875rem] transition-colors duration-150",
                    "focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      isActive ? "text-primary" : "text-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex-1">{item.label}</span>
                  {/* Only Reservations carries a count today. Kept as an explicit
                      match rather than a generic slot on NavItem, because one
                      badge does not yet justify a mechanism. */}
                  {item.href === "/dashboard/reservations" &&
                    restaurantId !== undefined &&
                    pendingRequestCount !== undefined && (
                      <PendingRequestsBadge
                        restaurantId={restaurantId}
                        initialCount={pendingRequestCount}
                      />
                    )}
                </Link>
              );
            })}
          </div>
        );
      })}
      {showAdmin && (
        <div className="flex flex-col gap-0.5">
          <p className="type-overline text-muted-foreground px-3 pb-1.5">
            Platform
          </p>
          <Link
            href="/admin"
            onClick={onNavigate}
            className="type-label text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-ring/50 flex h-9 items-center gap-2.5 rounded-lg px-3 text-[0.875rem] transition-colors duration-150 focus-visible:ring-3 focus-visible:outline-none"
          >
            <ShieldCheck
              className="text-muted-foreground size-4 shrink-0"
              aria-hidden="true"
            />
            <span className="flex-1">Admin</span>
          </Link>
        </div>
      )}
    </nav>
  );
}
