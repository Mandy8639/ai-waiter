-- Enables Supabase Realtime (`postgres_changes`) on `reservations`, so the
-- dashboard learns about a customer booking request without someone
-- happening to open the reservations page.
--
-- Exactly the shape of 20260824090300_orders_realtime.sql, and for the
-- same reasons — including the two that are easy to skip:
--
-- REPLICA IDENTITY FULL: without it an UPDATE's logical-replication record
-- carries only the primary key for the "old" row, which is not enough for
-- Realtime to re-evaluate RLS against the pre-change row. Supabase's own
-- recommendation for any RLS table in the publication.
--
-- THE GUARD: `supabase_realtime` is a publication every real Supabase
-- project creates automatically, and the PGlite test harness has no
-- Realtime layer and therefore no such publication. Without the guard this
-- migration would fail the entire integration suite.
--
-- This adds no authorization and weakens none. Realtime evaluates each
-- change against the same policies a normal query would, using the
-- subscriber's own JWT — so a diner still sees only the request they
-- created (reservations_select_own_request) and staff only their own
-- restaurant's (reservations_select_front_of_house).
alter table public.reservations replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'reservations'
    ) then
      alter publication supabase_realtime add table public.reservations;
    end if;
  end if;
end;
$$;
