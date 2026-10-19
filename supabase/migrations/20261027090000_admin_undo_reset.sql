-- Admin Phase 3: Undo and Emergency reset (docs/admin.md).
--
-- save_platform_models() learns an action, so a list restored by Undo is
-- recorded as an undo rather than a save. It still needs a passing Test
-- of that exact list, by the same person, in the last 15 minutes: Undo
-- re-tests the earlier list before putting it back.
--
-- clear_platform_models() removes saved lists, so the app goes back to
-- its Vercel variables and built-in defaults:
--   - for one job, when Undo goes back to "nothing saved" (no Test: the
--     defaults are what the app ran on before anything was saved);
--   - for every job at once, the Emergency reset, recorded as one
--     'all' row whose test_result keeps what was cleared.
--
-- Both are service_role only, like save_platform_models().

drop function public.save_platform_models(text, text[], uuid, uuid);

create function public.save_platform_models(
  p_job text,
  p_models text[],
  p_test_id uuid,
  p_user uuid,
  p_action text default 'save'
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
  if p_action not in ('save', 'undo') then
    raise exception 'MODEL_ACTION_INVALID';
  end if;

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
    (p_job, p_action, v_old, p_models, v_test.result, p_user);
end;
$$;

comment on function public.save_platform_models(text, text[], uuid, uuid, text) is
  'Saves a job''s model list from /admin (action save, or undo when Undo restores an earlier list) after a passing Test of that exact list by the same person in the last 15 minutes, and records it in the history. service_role only.';

revoke execute on function public.save_platform_models(text, text[], uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.save_platform_models(text, text[], uuid, uuid, text) to service_role;

create function public.clear_platform_models(
  p_job text,
  p_user uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old text[];
  v_cleared jsonb;
  v_count integer;
begin
  if p_job is null then
    -- Emergency reset: every job back to Vercel variables and defaults.
    select coalesce(jsonb_object_agg(job, models), '{}'::jsonb), count(*)
      into v_cleared, v_count
    from public.platform_settings;

    -- A WHERE that matches every row: production loads pg_safeupdate,
    -- which refuses a bare DELETE (tests/unit/migrations-safe-writes.test.ts).
    delete from public.platform_settings where job is not null;

    insert into public.platform_settings_history
      (job, action, old_models, new_models, test_result, changed_by)
    values
      ('all', 'reset', null, null, jsonb_build_object('cleared', v_cleared), p_user);
    return v_count;
  end if;

  if p_job not in ('waiter', 'staff_assistant', 'vision', 'suggestions', 'drafts') then
    raise exception 'MODEL_JOB_INVALID';
  end if;

  delete from public.platform_settings
  where job = p_job
  returning models into v_old;

  if v_old is null then
    return 0;
  end if;

  insert into public.platform_settings_history
    (job, action, old_models, new_models, test_result, changed_by)
  values
    (p_job, 'undo', v_old, null, null, p_user);
  return 1;
end;
$$;

comment on function public.clear_platform_models(text, uuid) is
  'Removes saved model lists so the app uses its Vercel variables and defaults: one job (Undo back to nothing saved) or, with a null job, all of them (Emergency reset). Recorded in the history. service_role only.';

revoke execute on function public.clear_platform_models(text, uuid) from public, anon, authenticated;
grant execute on function public.clear_platform_models(text, uuid) to service_role;
