-- Make restaurants deletable again.
--
-- Two independent triggers each blocked `delete from restaurants`, so a
-- restaurant could not be deleted by anyone, by any route. Both were
-- correct about the case they were written for and neither considered the
-- one case where the restaurant itself is going away. They are fixed
-- together because they are the same mistake twice.
--
--
-- BLOCKER 1 — the audit log's foreign key.
--
-- 20260828090000_admin_audit_log.sql introduced an AFTER trigger that
-- records one audit_log row per write on an audited table, and gave
-- audit_log.restaurant_id a foreign key to restaurants. Together those two
-- decisions made a restaurant impossible to delete:
--
--   1. `delete from restaurants` removes the parent row.
--   2. The delete cascades to categories, menu_items, tables,
--      restaurant_users, restaurant_settings and the rest.
--   3. Each cascaded child DELETE fires record_audit_log(), which inserts
--      an audit_log row carrying that restaurant_id.
--   4. The parent restaurant is already gone, so audit_log's foreign key
--      rejects the insert with 23503 and the whole delete rolls back.
--
-- The audit log made its own subject undeletable. This is not only about
-- clearing test fixtures: restaurant offboarding and any "delete my
-- account" path were broken by it too, which matters for a data-deletion
-- request.
--
-- The fix is to skip the audit write when the restaurant no longer exists.
-- Recording a change to a restaurant that has just been deleted has no
-- value to anyone — nothing can ever read it, because the same cascade
-- deletes that restaurant's audit_log rows on its way through. The guard
-- costs one primary-key lookup per audited write.
--
-- Deliberately NOT done instead:
--
--   * Dropping the foreign key. Audit rows would outlive their restaurant
--     and dangle, and audit_log's RLS is keyed on restaurant membership,
--     so orphans would be unreadable and unreachable rather than useful.
--   * Making the key DEFERRABLE. Deferring only moves the same violation
--     to commit time; the parent is still gone when it is checked.
--
-- Only the function body changes. The triggers created by
-- 20260828090000_admin_audit_log.sql call this function by name and are
-- left exactly as they are.
create or replace function public.record_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_row_id uuid;
begin
  if TG_TABLE_NAME = 'modifier_options' then
    select mim.restaurant_id into v_restaurant_id
    from public.menu_item_modifiers mim
    where mim.id = coalesce(NEW.modifier_id, OLD.modifier_id);
  else
    v_restaurant_id := coalesce(NEW.restaurant_id, OLD.restaurant_id);
  end if;

  -- The restaurant is gone: this write is a cascade from its deletion, and
  -- the audit row we would insert here could only violate audit_log's
  -- foreign key. Skipping is what makes `delete from restaurants` possible
  -- at all. This is reachable for no other reason — every ordinary write
  -- to an audited table has its restaurant present by that table's own
  -- foreign key, so normal auditing is unaffected.
  if v_restaurant_id is null
    or not exists (
      select 1 from public.restaurants r where r.id = v_restaurant_id
    )
  then
    return null;
  end if;

  v_row_id := coalesce(NEW.id, OLD.id);

  insert into public.audit_log (
    restaurant_id, table_name, row_id, operation,
    actor_id, actor_role, old_data, new_data
  ) values (
    v_restaurant_id,
    TG_TABLE_NAME,
    v_row_id,
    TG_OP,
    auth.uid(),
    public.current_restaurant_role(v_restaurant_id),
    case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(OLD) else null end,
    case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(NEW) else null end
  );

  return null; -- ignored for AFTER triggers
end;
$$;

comment on function public.record_audit_log() is
  'Generic AFTER-trigger: records one audit_log row per INSERT/UPDATE/DELETE on an audited admin table. Skips the write when the owning restaurant no longer exists, which is what allows a restaurant to be deleted — see 20260831120000_audit_log_allow_restaurant_delete.sql and docs/security.md#auditability.';


-- BLOCKER 2 — the last-owner guard.
--
-- 20260829090000_staff_management.sql added enforce_at_least_one_owner(),
-- a BEFORE UPDATE OR DELETE trigger on restaurant_users that refuses to
-- remove or demote a restaurant's final owner. That rule is right on its
-- own terms: a restaurant with no owner is permanently unmanageable,
-- because nobody is left who can add anyone.
--
-- But deleting a restaurant cascades to restaurant_users, and that cascade
-- necessarily removes the last owner. The guard fired and raised 23514,
-- rolling the delete back. It was protecting the manageability of a
-- restaurant that was in the middle of ceasing to exist.
--
-- Same fix, same reasoning as above: skip when the restaurant is gone. The
-- rule is unchanged for every case it was actually written for — while the
-- restaurant exists, its last owner still cannot be removed or demoted.
create or replace function public.enforce_at_least_one_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The restaurant is being deleted and this is its cascade. There is no
  -- restaurant left to strand without an owner, so the rule has nothing to
  -- protect here. Checked first so the guard below keeps its original
  -- meaning for every other caller.
  if not exists (
    select 1 from public.restaurants r where r.id = OLD.restaurant_id
  ) then
    if TG_OP = 'DELETE' then
      return OLD;
    end if;
    return NEW;
  end if;

  if OLD.role = 'owner' and (TG_OP = 'DELETE' or NEW.role <> 'owner') then
    if (
      select count(*) from public.restaurant_users
      where restaurant_id = OLD.restaurant_id and role = 'owner'
    ) <= 1 then
      raise exception 'Cannot remove or demote the last owner of a restaurant'
        using errcode = '23514';
    end if;
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

comment on function public.enforce_at_least_one_owner() is
  'Blocks demoting/removing a restaurant''s last remaining owner, except when the restaurant itself is being deleted and this is its cascade. See docs/security.md#staff-management and 20260831120000_allow_restaurant_delete.sql.';
