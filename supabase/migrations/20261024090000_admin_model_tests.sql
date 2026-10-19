-- Admin Phase 2: change a job's models from /admin, only after a passing
-- Test (docs/admin.md).
--
-- platform_model_tests keeps every Test run on /admin: which job, which
-- exact list, whether it passed, and what it showed (reply excerpt, time,
-- cost). save_platform_models() is the only way a list is saved, and it
-- refuses unless the person saving ran a passing Test of that exact list,
-- for that job, in the last 15 minutes. The server checks the same rules
-- first, with friendlier messages; this is the layer that holds if a
-- server bug ever skips them.
--
-- Like platform_settings, nobody but the server touches either: RLS on
-- with no policy, table privileges revoked, and the function callable by
-- service_role only.

create table public.platform_model_tests (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  models text[] not null,
  passed boolean not null,
  -- What the Test showed: reply excerpt, checks, served model, time, cost.
  result jsonb not null,
  tested_by uuid references auth.users (id) on delete set null,
  tested_at timestamptz not null default now(),

  constraint platform_model_tests_job_valid check (
    job in ('waiter', 'staff_assistant', 'vision', 'suggestions', 'drafts')
  ),
  constraint platform_model_tests_models_count check (cardinality(models) between 1 and 3)
);

comment on table public.platform_model_tests is
  'Every Test run on /admin. save_platform_models() needs a passing one of the exact list, by the same person, in the last 15 minutes. Server-only.';

create index platform_model_tests_tested_at_idx
  on public.platform_model_tests (tested_at desc);

alter table public.platform_model_tests enable row level security;
revoke all on table public.platform_model_tests from anon, authenticated;

create function public.save_platform_models(
  p_job text,
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
  select * into v_test from public.platform_model_tests where id = p_test_id;

  if not found
     or not v_test.passed
     or v_test.job is distinct from p_job
     or v_test.models is distinct from p_models
     or v_test.tested_by is distinct from p_user then
    raise exception 'MODEL_TEST_REQUIRED'
      using hint = 'Run Test on exactly this list, and save once it passes.';
  end if;

  if v_test.tested_at < now() - interval '15 minutes' then
    raise exception 'MODEL_TEST_STALE'
      using hint = 'The Test is more than 15 minutes old. Run it again.';
  end if;

  -- Free-only jobs never spend money, whatever reached this function.
  if p_job in ('suggestions', 'drafts') and exists (
    select 1 from unnest(p_models) m where m not like '%:free'
  ) then
    raise exception 'MODEL_NOT_FREE';
  end if;

  select models into v_old
  from public.platform_settings
  where job = p_job
  for update;

  insert into public.platform_settings (job, models, updated_at, updated_by)
  values (p_job, p_models, now(), p_user)
  on conflict (job) do update
    set models = excluded.models,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;

  insert into public.platform_settings_history
    (job, action, old_models, new_models, test_result, changed_by)
  values
    (p_job, 'save', v_old, p_models, v_test.result, p_user);
end;
$$;

comment on function public.save_platform_models(text, text[], uuid, uuid) is
  'Saves a job''s model list from /admin after a passing Test of that exact list by the same person in the last 15 minutes, and records it in the history. service_role only.';

revoke execute on function public.save_platform_models(text, text[], uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_platform_models(text, text[], uuid, uuid) to service_role;
