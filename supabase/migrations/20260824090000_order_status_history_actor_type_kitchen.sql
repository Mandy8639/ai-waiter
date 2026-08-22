-- Batch 5's order_status_history_actor_type_valid constraint predates the
-- staff-facing status workflow and only allowed
-- ('customer', 'staff', 'manager', 'owner', 'system') — missing 'kitchen',
-- one of the four real restaurant_users roles (see
-- 20260821130200_restaurant_users.sql) and the role most of this batch's
-- transitions (confirm/preparing/ready) are actually performed by. Widen it
-- rather than collapsing 'kitchen' into 'staff' in the audit trail — "who
-- did this" should reflect the real role, not a lossy approximation.
alter table public.order_status_history
  drop constraint order_status_history_actor_type_valid;

alter table public.order_status_history
  add constraint order_status_history_actor_type_valid check (
    actor_type in ('customer', 'owner', 'manager', 'kitchen', 'staff', 'system')
  );
