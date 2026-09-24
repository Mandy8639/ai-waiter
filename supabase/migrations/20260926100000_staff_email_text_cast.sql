-- get_restaurant_staff() returns nothing on a real project. Cast the email.
--
-- WHAT IS WRONG. The function is declared `returns table (... email text
-- ...)` and its body selects `u.email` from auth.users, which GoTrue
-- declares as `character varying(255)`. Postgres refuses the mismatch when
-- the query actually runs:
--
--   42804  structure of query does not match function result type
--          Returned type character varying(255) does not match expected
--          type text in column 3.
--
-- So every call fails. Through PostgREST that arrives as an error with a
-- null payload, and src/app/dashboard/staff/page.tsx renders
-- `(staff ?? []).map(...)` — an empty staff list, no error message, no
-- clue. A restaurant would see "nobody works here" and have no way to
-- know the query failed rather than returned nothing.
--
-- WHY NOTHING CAUGHT IT. The PGlite harness that runs every migration in
-- tests stubs auth.users, and the stub declared `email text` — so the
-- mismatch did not exist there and 24 staff-management tests passed
-- against a shape real Supabase does not have. The stub now declares
-- varchar(255) (src/lib/backup/supabase-stub.ts), which is what makes this
-- migration's absence a test failure rather than a surprise in production.
--
-- Found 2026-09-24, verifying phase C's own auth.users-crossing function
-- against a live project. That one shipped with the cast; this one had
-- been wrong since 20260829090000.
--
-- WHETHER PRODUCTION IS AFFECTED. Unknown at the time of writing, and the
-- reason is itself worth recording: get_restaurant_staff() was dropped and
-- recreated by hand in the SQL editor on 2026-09-19 while chasing the
-- PGRST202 cache bug, so what is live may not be what
-- 20260829090000_staff_management.sql says. This migration makes the
-- answer the same either way — the cast is a no-op if the live definition
-- already has one.
--
-- CREATE OR REPLACE, not DROP + CREATE: replacing a function keeps its
-- ACL, where dropping it resets EXECUTE to the Postgres default (PUBLIC),
-- which is precisely the 2026-09-19 incident that
-- 20260919090000_revoke_anon_from_server_functions.sql had to clean up.
-- The grants are re-issued below anyway, so the intent is stated in SQL
-- rather than assumed.
--
-- Body otherwise identical to 20260829090000, including `language plpgsql`
-- for the reason documented at length there (a `language sql` function
-- crossing into auth.users returns PGRST202 from PostgREST forever).

create or replace function public.get_restaurant_staff(target_restaurant_id uuid)
returns table (
  id uuid,
  user_id uuid,
  email text,
  role text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_restaurant_member(target_restaurant_id) then
    return;
  end if;

  return query
    select ru.id, ru.user_id, u.email::text, ru.role, ru.created_at
    from public.restaurant_users ru
    join auth.users u on u.id = ru.user_id
    where ru.restaurant_id = target_restaurant_id
    order by ru.created_at asc;
end;
$$;

comment on function public.get_restaurant_staff(uuid) is
  'The full staff list for a restaurant, resolved to real emails via auth.users (cast to text — the column is varchar(255) and the mismatch made every call fail). SECURITY DEFINER to cross into auth.users; gated by the caller''s own membership in target_restaurant_id, checked internally — never exposes another restaurant''s staff.';

-- Restated rather than relied upon: CREATE OR REPLACE preserves the ACL,
-- but if the live function was ever dropped and recreated by hand its
-- grants are whatever that left behind.
revoke execute on function public.get_restaurant_staff(uuid) from public, anon;
grant execute on function public.get_restaurant_staff(uuid) to authenticated;
