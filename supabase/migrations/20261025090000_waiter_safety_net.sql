-- The waiter's free safety net (docs/admin.md).
--
-- Once a day the app runs the Admin page's waiter Test on every free,
-- tool-calling model OpenRouter lists, and keeps the result here. When
-- every model in the waiter's own list is busy, the waiter makes one more
-- try with the fastest free models that passed in the last three days,
-- instead of telling the diner it can't answer.
--
-- free_model_checks holds each model's latest result. A model that was
-- only busy (rate limited) keeps its last pass: busy says nothing about
-- whether it is any good.
--
-- platform_switches holds on/off switches set from /admin. A missing row
-- means on.
--
-- Both are server-only, like platform_settings: RLS on with no policy and
-- privileges revoked from anon and authenticated.

create table public.free_model_checks (
  model text primary key,
  status text not null,
  -- The last time this model passed, and how long that passing Test took.
  last_passed_at timestamptz,
  pass_ms integer,
  checked_at timestamptz not null default now(),
  -- What the latest Test showed: checks, reply excerpt, error.
  result jsonb not null default '{}'::jsonb,

  constraint free_model_checks_status_valid check (
    status in ('passed', 'failed', 'busy')
  ),
  constraint free_model_checks_free_only check (model like '%:free')
);

comment on table public.free_model_checks is
  'The latest waiter Test of each free OpenRouter model, run daily. The waiter''s safety net is the fastest that passed in the last three days. Server-only.';

create table public.platform_switches (
  name text primary key,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,

  constraint platform_switches_name_valid check (name in ('waiter_safety_net'))
);

comment on table public.platform_switches is
  'On/off switches set from /admin. A missing row means on. Server-only.';

alter table public.free_model_checks enable row level security;
alter table public.platform_switches enable row level security;

revoke all on table public.free_model_checks from anon, authenticated;
revoke all on table public.platform_switches from anon, authenticated;
