-- Platform settings: the Admin page's store (docs/admin.md, Phase 1).
--
-- The AI models each job uses have lived in Vercel variables, so changing
-- one meant editing Vercel and redeploying. These two tables let the
-- platform owner change them from /admin instead. Phase 1 only reads
-- them; the Admin page's editor (Phase 2) writes them, through the
-- server, after a passing test.
--
-- Nobody but the server reads or writes either table. There is no policy
-- for any role, and the table privileges are revoked from anon and
-- authenticated as well, so a restaurant owner's session cannot see which
-- models the platform uses or who changed them. The app reads them with
-- the service-role client (src/lib/ai/model-settings.ts), and the Admin
-- page checks PLATFORM_ADMIN_EMAILS before it writes.
--
-- An empty table is the normal state: every job then uses its Vercel
-- variable and then its built-in default, exactly as before this
-- migration.

create table public.platform_settings (
  job text primary key,
  models text[] not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,

  constraint platform_settings_job_valid check (
    job in ('waiter', 'staff_assistant', 'vision', 'suggestions', 'drafts')
  ),
  -- OpenRouter tries at most three models per request.
  constraint platform_settings_models_count check (cardinality(models) between 1 and 3),
  constraint platform_settings_models_no_blanks check (
    array_position(models, null) is null
    and array_position(models, '') is null
  )
);

comment on table public.platform_settings is
  'The model list each AI job uses, saved from /admin. A missing row means the job uses its Vercel variable, then its built-in default. Server-only: no policies, no grants.';

create table public.platform_settings_history (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  action text not null,
  old_models text[],
  new_models text[],
  -- The Test that allowed the change: reply excerpt, pass/fail, time, cost.
  test_result jsonb,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),

  constraint platform_settings_history_job_valid check (
    job in ('waiter', 'staff_assistant', 'vision', 'suggestions', 'drafts', 'all')
  ),
  constraint platform_settings_history_action_valid check (
    action in ('save', 'undo', 'reset')
  )
);

comment on table public.platform_settings_history is
  'Every change made on /admin: who, when, from what, to what, and the test result that allowed it. job = ''all'' for an emergency reset. Server-only.';

create index platform_settings_history_changed_at_idx
  on public.platform_settings_history (changed_at desc);

alter table public.platform_settings enable row level security;
alter table public.platform_settings_history enable row level security;

revoke all on table public.platform_settings from anon, authenticated;
revoke all on table public.platform_settings_history from anon, authenticated;
