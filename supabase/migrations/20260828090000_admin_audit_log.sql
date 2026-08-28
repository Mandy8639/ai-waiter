-- Closes the Item-6 audit's last open gap: order lifecycle has
-- order_status_history and AI-driven mutations have ai_conversation_messages
-- (see docs/database.md), but no admin-side CRUD had any change history —
-- only `updated_at` (when), never who changed it or what it used to be. A
-- manager silently dropping a price, disabling AI for a restaurant
-- (restaurant_settings), or changing a staff member's role left no trail.
-- Not a security hole (RLS on the write itself was already correct) — a
-- missing "who did what" record. See docs/security.md#auditability.
--
-- One generic, reusable audit_log table + trigger function, attached to
-- every admin-writable table this batch covers, rather than nine bespoke
-- history tables — mirrors order_status_history's append-only philosophy
-- (no client-facing INSERT/UPDATE/DELETE policy for any role; the trigger
-- function is the only writer) while avoiding nine near-identical schemas.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  -- Strictly monotonic, independent of `created_at`: two writes to the same
  -- row in the same transaction/millisecond (e.g. a fixture INSERT
  -- immediately followed by a test's own UPDATE) can otherwise share an
  -- identical timestamp under low clock resolution, making "most recent"
  -- ambiguous by created_at alone — see the PGlite clock-precision issue
  -- documented in tests/integration/db/abuse-protection-rpcs.test.ts for
  -- the same class of problem. `seq` gives every row an unambiguous order.
  seq bigint generated always as identity,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  table_name text not null,
  row_id uuid not null,
  operation text not null,
  -- Nullable: a row created by a non-interactive path with no authenticated
  -- caller (none exist today, but future-proofing matches
  -- order_status_history.actor_id's own nullability for the same reason).
  actor_id uuid,
  -- Captured at write time from current_restaurant_role(), not joined at
  -- read time — a later role change or removal must never rewrite what an
  -- earlier audit entry says the actor's role was at the time.
  actor_role text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now(),

  constraint audit_log_operation_valid check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  constraint audit_log_table_name_valid check (
    table_name in (
      'restaurant_users', 'categories', 'restaurant_settings', 'menu_items',
      'modifier_options', 'menu_item_modifiers', 'allergens', 'ingredients', 'tables'
    )
  )
);

comment on table public.audit_log is
  'Append-only "who changed what" trail for admin-side CRUD (menu/settings/staff tables) — see docs/security.md#auditability. Populated exclusively by record_audit_log() triggers; no client-facing write policy exists for any role.';

create index audit_log_restaurant_id_seq_idx
  on public.audit_log (restaurant_id, seq desc);
create index audit_log_table_name_row_id_idx
  on public.audit_log (table_name, row_id);

alter table public.audit_log enable row level security;

-- Owner/manager only, not every restaurant member: unlike order_status_history
-- (operational data kitchen/service staff act on), this is oversight data —
-- "who changed the menu/settings/staff" is a manager/owner concern, not
-- something every role needs read access to.
create policy "audit_log_select_manager_or_owner"
  on public.audit_log
  for select
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

-- No INSERT/UPDATE/DELETE policy for any role: only record_audit_log()
-- (SECURITY DEFINER, invoked by triggers below) ever writes here.

-- Generic trigger function: one body for all nine tables rather than nine
-- near-identical ones. SECURITY DEFINER so its INSERT into audit_log
-- (RLS-enabled, no INSERT policy) succeeds regardless of which role's
-- ordinary write on the audited table fired it — same escalation reasoning
-- as order_belongs_to_caller()/submit_order() elsewhere in this schema.
--
-- restaurant_id resolution: every audited table except modifier_options
-- carries restaurant_id directly; modifier_options is scoped one hop away
-- via its owning modifier group (menu_item_modifiers.restaurant_id) — see
-- 20260821131000_modifier_options.sql, which deliberately has no
-- restaurant_id column of its own.
create function public.record_audit_log()
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
  'Generic AFTER-trigger: records one audit_log row per INSERT/UPDATE/DELETE on an audited admin table. See docs/security.md#auditability.';

create trigger trg_restaurant_users_audit
  after insert or update or delete on public.restaurant_users
  for each row execute function public.record_audit_log();

create trigger trg_categories_audit
  after insert or update or delete on public.categories
  for each row execute function public.record_audit_log();

create trigger trg_restaurant_settings_audit
  after insert or update or delete on public.restaurant_settings
  for each row execute function public.record_audit_log();

create trigger trg_menu_items_audit
  after insert or update or delete on public.menu_items
  for each row execute function public.record_audit_log();

create trigger trg_modifier_options_audit
  after insert or update or delete on public.modifier_options
  for each row execute function public.record_audit_log();

create trigger trg_menu_item_modifiers_audit
  after insert or update or delete on public.menu_item_modifiers
  for each row execute function public.record_audit_log();

create trigger trg_allergens_audit
  after insert or update or delete on public.allergens
  for each row execute function public.record_audit_log();

create trigger trg_ingredients_audit
  after insert or update or delete on public.ingredients
  for each row execute function public.record_audit_log();

create trigger trg_tables_audit
  after insert or update or delete on public.tables
  for each row execute function public.record_audit_log();
