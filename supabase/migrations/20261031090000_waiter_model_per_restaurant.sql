-- Admin Phase 7: a waiter model per restaurant, or per plan (docs/admin.md).
--
-- The diner's waiter has used one platform-wide model list (platform_settings
-- job 'waiter', else AI_MODEL, else the built-in default). This lets the
-- platform owner give one restaurant, or every restaurant on a plan, its own
-- list: a paid, smarter waiter for Pro, say, while Starter stays free. The
-- app resolves restaurant first, then plan, then the platform list
-- (src/lib/ai/waiter-models.ts).
--
-- Same rules as the platform lists: a choice is saved only after a passing
-- Test of exactly that list, by the same person, in the last 15 minutes, and
-- a restaurant's choice must have been tested on THAT restaurant's own menu
-- (platform_model_tests.restaurant_id). Every change is recorded. All three
-- tables are server-only.

-- Which restaurant's menu a Test ran on; null for the sample menu.
alter table public.platform_model_tests
  add column restaurant_id uuid references public.restaurants (id) on delete cascade;

comment on column public.platform_model_tests.restaurant_id is
  'The restaurant whose menu this Test ran on (Phase 7), or null for the sample menu.';

create table public.waiter_model_overrides (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references public.restaurants (id) on delete cascade,
  plan_id uuid references public.platform_plans (id) on delete cascade,
  models text[] not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),

  -- Exactly one target: a restaurant or a plan.
  constraint waiter_model_overrides_one_target
    check ((restaurant_id is null) <> (plan_id is null)),
  constraint waiter_model_overrides_models_count
    check (cardinality(models) between 1 and 3),
  constraint waiter_model_overrides_models_no_blanks check (
    array_position(models, null) is null
    and array_position(models, '') is null
  )
);

create unique index waiter_model_overrides_restaurant_key
  on public.waiter_model_overrides (restaurant_id) where restaurant_id is not null;
create unique index waiter_model_overrides_plan_key
  on public.waiter_model_overrides (plan_id) where plan_id is not null;

comment on table public.waiter_model_overrides is
  'A waiter model list for one restaurant or one plan, set on /admin. Resolution: restaurant, then plan, then the platform list. Server-only.';

create table public.waiter_model_override_history (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references public.restaurants (id) on delete cascade,
  plan_id uuid references public.platform_plans (id) on delete cascade,
  action text not null,
  old_models text[],
  new_models text[],
  test_result jsonb,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),

  constraint waiter_model_override_history_one_target
    check ((restaurant_id is null) <> (plan_id is null)),
  constraint waiter_model_override_history_action_valid
    check (action in ('save', 'clear'))
);

create index waiter_model_override_history_changed_at_idx
  on public.waiter_model_override_history (changed_at desc);

comment on table public.waiter_model_override_history is
  'Every per-restaurant or per-plan waiter model change made on /admin, with the Test that allowed it. Server-only.';

alter table public.waiter_model_overrides enable row level security;
alter table public.waiter_model_override_history enable row level security;
revoke all on table public.waiter_model_overrides from anon, authenticated;
revoke all on table public.waiter_model_override_history from anon, authenticated;

-- Saves (or, with null p_models, clears) one restaurant's or one plan's
-- waiter list. The only way either is written.
create function public.save_waiter_model_override(
  p_restaurant_id uuid,
  p_plan_id uuid,
  p_models text[],
  p_test_id uuid,
  p_user uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_test public.platform_model_tests%rowtype;
  v_old text[];
begin
  if (p_restaurant_id is null) = (p_plan_id is null) then
    raise exception 'OVERRIDE_TARGET_INVALID';
  end if;

  if p_models is not null then
    select * into v_test from public.platform_model_tests where id = p_test_id;
    if not found
       or not v_test.passed
       or v_test.job is distinct from 'waiter'
       or v_test.models is distinct from p_models
       or v_test.tested_by is distinct from p_user
       -- A restaurant's choice is tested on its own menu; a plan's on the
       -- sample menu, as it will serve restaurants not yet signed up.
       or v_test.restaurant_id is distinct from p_restaurant_id then
      raise exception 'MODEL_TEST_REQUIRED'
        using hint = 'Run Test on exactly this list, and save once it passes.';
    end if;
    if v_test.tested_at < now() - interval '15 minutes' then
      raise exception 'MODEL_TEST_STALE';
    end if;
  end if;

  select models into v_old
  from public.waiter_model_overrides
  where restaurant_id is not distinct from p_restaurant_id
    and plan_id is not distinct from p_plan_id
  for update;

  delete from public.waiter_model_overrides
  where restaurant_id is not distinct from p_restaurant_id
    and plan_id is not distinct from p_plan_id;

  if p_models is not null then
    insert into public.waiter_model_overrides
      (restaurant_id, plan_id, models, updated_by, updated_at)
    values (p_restaurant_id, p_plan_id, p_models, p_user, now());
  end if;

  insert into public.waiter_model_override_history
    (restaurant_id, plan_id, action, old_models, new_models, test_result, changed_by)
  values (
    p_restaurant_id, p_plan_id,
    case when p_models is null then 'clear' else 'save' end,
    v_old, p_models,
    case when p_models is null then null else v_test.result end,
    p_user
  );
end;
$$;

comment on function public.save_waiter_model_override(uuid, uuid, text[], uuid, uuid) is
  'Saves one restaurant''s or plan''s waiter model list from /admin after a passing Test of that exact list (on that restaurant''s menu, or the sample menu for a plan) by the same person in the last 15 minutes; null models clears it back to the next level. Recorded in the history. service_role only.';

revoke execute on function public.save_waiter_model_override(uuid, uuid, text[], uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_waiter_model_override(uuid, uuid, text[], uuid, uuid) to service_role;
