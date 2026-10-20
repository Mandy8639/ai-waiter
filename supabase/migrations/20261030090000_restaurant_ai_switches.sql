-- Admin Phase 6: per-restaurant AI switches (docs/admin.md).
--
-- The platform owner can switch off, for ONE restaurant, the diner's AI
-- waiter, the staff assistant, or the owner-side AI tools (menu photo
-- reading, dish details, nutrition and translation drafts). It overrides
-- the restaurant's own settings: if a restaurant misuses the AI or runs up
-- cost, it can be stopped for that restaurant alone, within a minute,
-- without touching anyone else.
--
-- A row means "switched off by Tableside"; no row means on. Both tables
-- are server-only, like platform_settings: RLS on with no policy and no
-- grants to anon or authenticated. The app reads them with the service
-- role (src/lib/admin/restaurant-switches.ts) and only /admin writes them
-- (platformAdminForAction()). Restaurant owners learn a switch is off from
-- what the app tells them ("Switched off by Tableside"), never by reading
-- these tables.

create table public.restaurant_ai_switches (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  feature text not null,
  -- Shown to nobody but the admin; why it was switched off.
  reason text,
  switched_off_by uuid references auth.users (id) on delete set null,
  switched_off_at timestamptz not null default now(),

  primary key (restaurant_id, feature),
  constraint restaurant_ai_switches_feature_valid
    check (feature in ('waiter', 'staff_assistant', 'owner_tools')),
  constraint restaurant_ai_switches_reason_length
    check (reason is null or char_length(reason) <= 200)
);

comment on table public.restaurant_ai_switches is
  'AI features Tableside has switched off for one restaurant (a row = off). Overrides the restaurant''s own settings. Server-only.';

create table public.restaurant_ai_switch_history (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  feature text not null,
  action text not null,
  reason text,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),

  constraint restaurant_ai_switch_history_feature_valid
    check (feature in ('waiter', 'staff_assistant', 'owner_tools')),
  constraint restaurant_ai_switch_history_action_valid
    check (action in ('off', 'on')),
  constraint restaurant_ai_switch_history_reason_length
    check (reason is null or char_length(reason) <= 200)
);

comment on table public.restaurant_ai_switch_history is
  'Every per-restaurant AI switch change made on /admin: who, when, which feature, off or on, and why. Server-only.';

create index restaurant_ai_switch_history_changed_at_idx
  on public.restaurant_ai_switch_history (changed_at desc);

alter table public.restaurant_ai_switches enable row level security;
alter table public.restaurant_ai_switch_history enable row level security;
revoke all on table public.restaurant_ai_switches from anon, authenticated;
revoke all on table public.restaurant_ai_switch_history from anon, authenticated;
