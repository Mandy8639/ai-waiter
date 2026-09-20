"use client";

import { useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Menu, XIcon } from "lucide-react";
import { DashboardNav } from "./dashboard-nav";
import type { RestaurantRole } from "@/lib/restaurants/get-user-restaurants";

/**
 * The dashboard navigation on small screens, as a drawer from the left.
 *
 * Replaces a `<details>` popover that trapped nothing, restored focus to
 * nothing and stayed open after you tapped a link. This is a real Base UI
 * dialog: focus moves in, Escape and the close button work, focus returns
 * to the menu button, and choosing a page closes it.
 */
export function MobileNav({
  role,
  restaurantId,
  pendingRequestCount,
  restaurantName,
}: {
  role: RestaurantRole;
  restaurantId?: string;
  pendingRequestCount?: number;
  restaurantName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger
        aria-label="Open navigation"
        className="hover:bg-muted focus-visible:ring-ring/50 flex size-9 items-center justify-center rounded-lg border transition-colors focus-visible:ring-3 focus-visible:outline-none lg:hidden"
      >
        <Menu className="size-4" aria-hidden="true" />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/25 duration-150" />
        <DialogPrimitive.Popup className="bg-sidebar text-sidebar-foreground shadow-float data-open:animate-in data-open:slide-in-from-left-4 data-open:fade-in-0 data-closed:animate-out data-closed:slide-out-to-left-4 data-closed:fade-out-0 fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col gap-6 overflow-y-auto border-r px-3 py-4 duration-200 outline-none">
          <div className="flex items-center justify-between px-3">
            <DialogPrimitive.Title className="type-dish truncate">
              {restaurantName}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close navigation"
              className="hover:bg-sidebar-accent focus-visible:ring-ring/50 flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:ring-3 focus-visible:outline-none"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <DashboardNav
            role={role}
            restaurantId={restaurantId}
            pendingRequestCount={pendingRequestCount}
            onNavigate={() => setOpen(false)}
          />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
