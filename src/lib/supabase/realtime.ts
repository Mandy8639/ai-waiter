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
