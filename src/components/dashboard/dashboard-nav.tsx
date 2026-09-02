"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "./nav-items";
import { PendingRequestsBadge } from "./pending-requests-badge";
import type { RestaurantRole } from "@/lib/restaurants/get-user-restaurants";

export function DashboardNav({
  role,
  onNavigate,
  className,
  restaurantId,
  pendingRequestCount,
}: {
  role: RestaurantRole;
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

  return (
    <nav className={cn("flex flex-col gap-1", className)}>
      {items.map((item) => {
        const isActive =
          item.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            {item.label}
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
    </nav>
  );
}
