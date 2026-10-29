import type { RealtimeChannel, RealtimeClient } from "@supabase/supabase-js";

/** The part of a Supabase client a live screen needs. */
type RealtimeCapable = {
  realtime: Pick<RealtimeClient, "setAuth">;
  removeChannel: (channel: RealtimeChannel) => Promise<unknown>;
};

/**
 * Opens a Realtime channel once the client holds the signed-in person's
 * token (a diner's anonymous session included), and returns what closes it.
 *
 * Subscribing straight after createClient() races the session: the token
 * arrives while the join is in flight, realtime-js only updates the join
 * it already sent, and the channel stays joined as a logged-out visitor.
 * RLS then hides every row, so no change was ever delivered and every live
 * screen ran on its fallback poll — the "postgres_changes is unreliable"
 * symptom blamed on Supabase ticket SU-452145, found in the 2026-10-26
 * busy-Saturday run. setAuth() without a token reads it through the
 * client's own callback, so refreshed tokens keep reaching the channel.
 */
export function openAuthorizedChannel(
  supabase: RealtimeCapable,
  open: () => RealtimeChannel,
): () => void {
  let channel: RealtimeChannel | null = null;
  let closed = false;

  void supabase.realtime
    .setAuth()
    // Subscribe anyway: the screen's fallback poll still covers it.
    .catch(() => undefined)
    .then(() => {
      if (!closed) channel = open();
    });

  return () => {
    closed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}

/** What a screen hears on a topic. */
export interface TopicListener {
  /** A row changed; the payload is the small summary the trigger sent. */
  onMessage: (payload: Record<string, unknown>) => void;
  /** SUBSCRIBED, CLOSED, CHANNEL_ERROR or TIMED_OUT. */
  onStatus?: (status: string) => void;
}

interface TopicEntry {
  listeners: Set<TopicListener>;
  status: string | null;
  close: () => void;
}

const topics = new Map<string, TopicEntry>();

/**
 * Listens to a private Broadcast topic the database sends to
 * (20261127090000_realtime_broadcast.sql: `orders:restaurant:<id>`,
 * `orders:order:<id>`, `requests:restaurant:<id>`,
 * `reservations:restaurant:<id>`), and returns what stops listening.
 *
 * Broadcast replaced `postgres_changes`, which made the database check
 * every change against every open screen's permissions: the biggest
 * database cost in the 2026-10-28 busy-night simulation. Who may join a
 * topic is checked once, when the channel joins.
 *
 * One channel per topic, shared: realtime-js hands back the existing
 * channel for a topic it already has, so two screens opening their own
 * (the bookings badge sits in both navs) would share one and the first to
 * close would cut the other off. The channel closes with its last
 * listener.
 */
export function listenToTopic(
  supabase: RealtimeCapable & {
    channel: (
      topic: string,
      options: { config: { private: boolean } },
    ) => RealtimeChannel;
  },
  topic: string,
  listener: TopicListener,
): () => void {
  let entry = topics.get(topic);
  if (!entry) {
    const created: TopicEntry = {
      listeners: new Set(),
      status: null,
      close: () => undefined,
    };
    created.close = openAuthorizedChannel(supabase, () =>
      supabase
        .channel(topic, { config: { private: true } })
        .on("broadcast", { event: "change" }, (message) => {
          const payload = ((message as { payload?: unknown }).payload ??
            {}) as Record<string, unknown>;
          for (const l of created.listeners) l.onMessage(payload);
        })
        .subscribe((status) => {
          created.status = status;
          for (const l of created.listeners) l.onStatus?.(status);
        }),
    );
    topics.set(topic, created);
    entry = created;
  } else if (entry.status) {
    // Joining a channel that's already live: say so straight away.
    listener.onStatus?.(entry.status);
  }
  entry.listeners.add(listener);

  const current = entry;
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0 && topics.get(topic) === current) {
      topics.delete(topic);
      current.close();
    }
  };
}
