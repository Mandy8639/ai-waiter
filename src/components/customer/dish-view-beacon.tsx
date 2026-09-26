"use client";

import { useEffect } from "react";
import { recordDishView } from "@/lib/analytics/actions";

/**
 * Counts a dish page as opened (phase H) — from the browser, after the
 * page is actually shown. Recording it while the page renders on the
 * server would also count every link prefetch, which is a diner scrolling
 * past a dish, not opening it.
 */
export function DishViewBeacon({ menuItemId }: { menuItemId: string }) {
  useEffect(() => {
    void recordDishView(menuItemId);
  }, [menuItemId]);
  return null;
}
