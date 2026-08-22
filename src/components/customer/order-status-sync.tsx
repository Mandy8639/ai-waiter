"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Renders nothing — keeps the customer order confirmation page's status
 * live as staff move it through the kitchen workflow (Batch 6), by
 * triggering a server refetch (`router.refresh()`, which re-runs
 * getOrderById()) whenever this order's row changes, rather than
 * duplicating status-display logic into client-side state.
 *
 * RLS (`orders_select_own_or_staff`, unchanged since Batch 5) is what
 * actually scopes which row changes this subscription can ever receive —
 * the `filter` below narrows bandwidth, it isn't the security boundary,
 * the same as the kitchen board's subscription (see
 * docs/security.md#realtime-security). Also resyncs on tab-visible and
 * network-online, so a phone that was asleep or offline catches up rather
 * than assuming it didn't miss anything.
 */
export function OrderStatusSync({ orderId }: { orderId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`orders:order:${orderId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "orders",
          filter: `id=eq.${orderId}`,
        },
        () => router.refresh(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") router.refresh();
      });

    function handleWake() {
      if (document.visibilityState === "visible") router.refresh();
    }
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("online", handleWake);

    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("online", handleWake);
      void supabase.removeChannel(channel);
    };
  }, [orderId, router]);

  return null;
}
