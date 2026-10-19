-- The free safety net, for the staff assistant too (docs/admin.md).
--
-- free_model_checks held one row per model, all for the waiter. Each job
-- now keeps its own results, because a model that reads staff commands
-- well may still be a poor waiter and the reverse: the key becomes
-- (job, model). Existing rows are the waiter's.
--
-- platform_switches gains the staff assistant's on/off switch. As before,
-- a missing row means on.

alter table public.free_model_checks
  add column job text not null default 'waiter';

alter table public.free_model_checks
  drop constraint free_model_checks_pkey;

alter table public.free_model_checks
  add constraint free_model_checks_pkey primary key (job, model);

alter table public.free_model_checks
  add constraint free_model_checks_job_valid check (
    job in ('waiter', 'staff_assistant')
  );

alter table public.free_model_checks
  alter column job drop default;

comment on table public.free_model_checks is
  'The latest daily Test of each free OpenRouter model, per job (waiter, staff assistant). Each job''s safety net is the models that passed its Test in the last three days. Server-only.';

alter table public.platform_switches
  drop constraint platform_switches_name_valid;

alter table public.platform_switches
  add constraint platform_switches_name_valid check (
    name in ('waiter_safety_net', 'staff_assistant_safety_net')
  );
