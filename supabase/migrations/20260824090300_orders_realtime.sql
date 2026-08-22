-- Enables Supabase Realtime (`postgres_changes`) on `orders`, so restaurant
-- staff dashboards and the customer order page update live instead of
-- polling. See docs/security.md#realtime-security for the full model —
-- the short version: Supabase's Realtime server evaluates each row change
-- against the SAME RLS policies a normal query would (`orders_select_own_or_staff`,
-- unchanged since Batch 5), using the subscribing client's own JWT. This
-- migration does not add, weaken, or duplicate any authorization — it
-- only turns on change *delivery* for a table whose read access was
-- already correctly tenant/session-scoped.
--
-- REPLICA IDENTITY FULL: without it, an UPDATE's logical-replication
-- record only carries the primary key for the "old" row, which isn't
-- enough for Realtime to re-evaluate RLS against the pre-change row where
-- needed. This is Supabase's own documented recommendation for any table
-- with RLS that's added to the realtime publication.
alter table public.orders replica identity full;

-- `supabase_realtime` is a publication every real Supabase project creates
-- automatically; this local/test harness (PGlite, see
-- tests/integration/db/setup.ts) has no Realtime layer and therefore no
-- such publication. Guarded so this migration is a no-op there instead of
-- failing outright, and does the real thing against an actual Supabase
-- project.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'orders'
    ) then
      alter publication supabase_realtime add table public.orders;
    end if;
  end if;
end;
$$;
