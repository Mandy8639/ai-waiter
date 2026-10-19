-- Admin Phase 4: what AI costs, per restaurant (docs/admin.md).
--
-- ai_usage keeps one row per AI use: one diner turn of the waiter (all
-- its model calls added up), one staff command, one menu photo, one
-- suggestion or draft batch, one Admin page Test or safety-net check.
-- With restaurant, job, the model that answered, tokens and cost. Until
-- now these figures only reached the Vercel logs and were gone.
--
-- cost_usd is OpenRouter's own figure when it sends one; otherwise the
-- model's listed price times the tokens, marked cost_estimated. Null when
-- neither is known (never 0: free models are 0 because OpenRouter says
-- so).
--
-- ai_cost_summary() adds them up per restaurant for the Admin page and
-- the weekly email. platform_email_dispatches is the weekly email's
-- once-only log: email_dispatches needs a restaurant, and this email
-- belongs to none.
--
-- All server-only: RLS on with no policy, privileges revoked, functions
-- service_role only.

create table public.ai_usage (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- Null for platform use: Admin page Tests and safety-net checks.
  restaurant_id uuid references public.restaurants (id) on delete set null,
  job text not null,
  source text not null default 'app',
  model text,
  -- Model calls in this use: a waiter turn with tool calls makes several.
  calls integer not null default 1,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(12, 6),
  cost_estimated boolean not null default false,

  constraint ai_usage_job_valid check (
    job in ('waiter', 'staff_assistant', 'vision', 'suggestions', 'drafts')
  ),
  constraint ai_usage_source_valid check (
    source in ('app', 'admin_test', 'safety_check')
  ),
  constraint ai_usage_cost_not_negative check (cost_usd is null or cost_usd >= 0),
  constraint ai_usage_calls_positive check (calls >= 1)
);

comment on table public.ai_usage is
  'One row per AI use (a waiter turn, a staff command, a photo, a batch, an admin Test): restaurant, job, model, tokens, cost. For the Admin page''s cost table and weekly email. Server-only.';

create index ai_usage_created_at_idx on public.ai_usage (created_at);
create index ai_usage_restaurant_created_idx
  on public.ai_usage (restaurant_id, created_at);

alter table public.ai_usage enable row level security;
revoke all on table public.ai_usage from anon, authenticated;

create function public.ai_cost_summary(p_from timestamptz, p_to timestamptz)
returns table (
  restaurant_id uuid,
  restaurant_name text,
  waiter_chats bigint,
  uses bigint,
  cost_usd numeric,
  unpriced bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    u.restaurant_id,
    r.name,
    count(*) filter (where u.job = 'waiter' and u.source = 'app'),
    count(*),
    coalesce(sum(u.cost_usd), 0),
    count(*) filter (where u.cost_usd is null)
  from public.ai_usage u
  left join public.restaurants r on r.id = u.restaurant_id
  where u.created_at >= p_from and u.created_at < p_to
  group by u.restaurant_id, r.name
  order by coalesce(sum(u.cost_usd), 0) desc, count(*) desc;
$$;

comment on function public.ai_cost_summary(timestamptz, timestamptz) is
  'AI uses and cost per restaurant between two times (a null restaurant is platform use: Admin page Tests and safety-net checks). service_role only.';

revoke execute on function public.ai_cost_summary(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.ai_cost_summary(timestamptz, timestamptz) to service_role;

create table public.platform_email_dispatches (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  -- The week it covers, as its Monday: "2026-10-19".
  dedupe_key text not null,
  recipient text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  provider_message_id text,
  error text,

  constraint platform_email_dispatches_kind_valid check (kind in ('weekly_ai_cost')),
  constraint platform_email_dispatches_once unique (kind, dedupe_key, recipient)
);

comment on table public.platform_email_dispatches is
  'Once-only log of emails to platform admins (the weekly AI cost email). Server-only.';

alter table public.platform_email_dispatches enable row level security;
revoke all on table public.platform_email_dispatches from anon, authenticated;
