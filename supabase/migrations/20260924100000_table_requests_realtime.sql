-- Enables Supabase Realtime (`postgres_changes`) on `table_requests`, so a
-- staff device learns that a table is waiting without someone happening to
-- reload the dashboard.
--
-- WHY THIS IS A SEPARATE MIGRATION, AND WHY IT WAS MISSED.
-- 20260924090000 shipped the table, the functions and the staff queue
-- component — and the queue subscribes to `postgres_changes` on this
-- table. A table that is not in the publication emits no events, so that
-- subscription would have sat there silently forever.
--
-- It would not have looked broken. The queue also polls every 12 seconds
-- as a safety net (see kds-reconciliation.ts), so the symptom would have
-- been "requests appear about ten seconds late" — slow service that nobody
-- would have traced back to a missing publication entry. Found by running
-- the flow against a real Supabase project rather than against PGlite,
-- which has no Realtime layer and therefore could never have caught it.
--
-- Exactly the shape of 20260824090300_orders_realtime.sql and
-- 20260902200000_reservations_realtime.sql, including the two parts that
-- are easy to skip:
--
-- REPLICA IDENTITY FULL: without it an UPDATE's logical-replication record
-- carries only the primary key for the "old" row, which is not enough for
-- Realtime to re-evaluate RLS against the pre-change row. Supabase's own
-- recommendation for any RLS table in the publication. It matters here
-- specifically: resolving a request is an UPDATE, and that is the event
-- that removes a row from every other device's queue.
--
-- THE GUARD: `supabase_realtime` is a publication every real Supabase
-- project creates automatically, and the PGlite test harness has no
-- Realtime layer and therefore no such publication. Without the guard this
-- migration would fail the entire integration suite.
--
-- This adds no authorization and weakens none. Realtime evaluates each
-- change against the same policies a normal query would, using the
-- subscriber's own JWT — so a diner still sees only their own session's
-- requests (table_requests_select_own_session) and staff only their own
-- restaurant's (table_requests_select_members).
alter table public.table_requests replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'table_requests'
    ) then
      alter publication supabase_realtime add table public.table_requests;
    end if;
  end if;
end;
$$;
