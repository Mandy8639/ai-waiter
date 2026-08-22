-- One row per anonymous customer visit, tied to exactly one restaurant and
-- one table. See docs/database.md and docs/security.md for the full design
-- rationale — in short: customers authenticate via Supabase Anonymous Auth
-- (a real `auth.users` row, `is_anonymous = true`, no email/password), so
-- `user_id = auth.uid()` works as a genuine RLS boundary here exactly the
-- same way it does for restaurant staff. This is deliberate: it's what
-- lets ordinary cart operations run through the normal RLS-respecting
-- client instead of the admin client.
create table public.customer_sessions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  table_id uuid not null,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  session_token uuid not null default gen_random_uuid() unique,
  status text not null default 'active',
  started_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  expires_at timestamptz not null,

  constraint customer_sessions_status_valid check (status in ('active', 'expired', 'closed')),
  -- Tenant-scoped FK: the session's table must actually belong to the
  -- session's own restaurant_id — the same protection every other
  -- tenant-scoped relationship in this schema gets (docs/database.md).
  constraint customer_sessions_table_same_restaurant
    foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id)
    on delete cascade
);

comment on table public.customer_sessions is
  'One row per anonymous customer visit (one Supabase Anonymous Auth user, one restaurant, one table). Not a restaurant_users row — customers are never staff. See docs/security.md#customer-sessions.';
comment on column public.customer_sessions.session_token is
  'A secondary, human-shareable-free opaque identifier. auth.uid() (via user_id) is the actual RLS boundary; this token exists for internal cross-checks and is never required to be secret on its own.';
comment on column public.customer_sessions.expires_at is
  'Fixed at creation (started_at + a few hours — see docs/security.md#session-lifetime for the exact default and rationale). Not extended on activity in this version — a deliberate V1 simplification.';

create index customer_sessions_restaurant_id_idx on public.customer_sessions (restaurant_id);
create index customer_sessions_table_id_idx on public.customer_sessions (table_id);
create index customer_sessions_expires_at_idx on public.customer_sessions (expires_at);

-- No updated_at column/trigger here (unlike most tables in this schema) —
-- last_active_at already serves that purpose and is updated explicitly by
-- application code on each customer action, not on every column change.

alter table public.customer_sessions enable row level security;

-- A customer can only ever see/touch their own session — never another
-- customer's, and never a restaurant staff member's (staff have no
-- customer_sessions row of their own, and this policy doesn't grant them
-- access to anyone else's).
create policy "customer_sessions_select_own"
  on public.customer_sessions
  for select
  to authenticated
  using (user_id = auth.uid());

-- Insert happens right after the anonymous sign-in that creates the
-- caller's own auth.uid() — restaurant_id/table_id come from the server
-- action's validated get_table_by_token() lookup, never trusted as raw
-- client input (see docs/security.md). The WITH CHECK below is what stops
-- a customer from creating a session claiming to be someone else.
create policy "customer_sessions_insert_own"
  on public.customer_sessions
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "customer_sessions_update_own"
  on public.customer_sessions
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- "A session for Table 1 must not silently become a session for Table 2"
-- (docs/security.md) — the UPDATE policy above only checks ownership, not
-- which columns changed, so on its own a customer could UPDATE their own
-- session's restaurant_id/table_id to relocate it without ever
-- re-validating a QR code. This trigger makes that structurally
-- impossible, independent of RLS or which client (even the admin client)
-- issues the update: once created, a session's restaurant_id and table_id
-- are immutable. Moving to a different table means starting a new session,
-- exactly as the QR route handler already does.
create or replace function public.prevent_customer_session_relocation()
returns trigger
language plpgsql
as $$
begin
  if new.restaurant_id <> old.restaurant_id or new.table_id <> old.table_id then
    raise exception 'customer_sessions.restaurant_id and table_id cannot change after creation — start a new session instead';
  end if;
  return new;
end;
$$;

create trigger trg_customer_sessions_prevent_relocation
  before update on public.customer_sessions
  for each row
  execute function public.prevent_customer_session_relocation();
