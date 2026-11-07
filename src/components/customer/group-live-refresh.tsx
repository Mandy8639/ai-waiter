"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { listenToTopic } from "@/lib/supabase/realtime";
import { shouldPollNow } from "@/components/kitchen/kds-reconciliation";

/** Re-read the shared cart this often even when live updates are flowing. */
const POLL_MS = 10_000;

/**
 * Keeps the shared cart current: when anyone in the group changes their
 * dishes, joins, leaves or sends, the group's private topic
 * (cart:group:<id>, 20261129090000) says so and the page re-renders from
 * the server. A poll and a re-read on wake cover a missed message.
 */
export function GroupLiveRefresh({ groupId }: { groupId: string }) {
  const router = useRouter();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Several phones changing at once arrive as a burst; one refresh does.
    const refresh = () => {
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        router.refresh();
      }, 300);
    };

    const close = listenToTopic(createClient(), `cart:group:${groupId}`, {
      onMessage: refresh,
      onStatus: () => undefined,
    });
    const timer = setInterval(() => {
      if (shouldPollNow(document.visibilityState)) refresh();
    }, POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);

    return () => {
      close();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
      if (pending.current) clearTimeout(pending.current);
    };
  }, [groupId, router]);

  return null;
}
