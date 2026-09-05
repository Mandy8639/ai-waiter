-- Allergen suggestions must never be asserted as fact.
--
-- Menu import can propose ingredients and allergens from a dish name, which
-- saves a restaurant a great deal of typing. Ingredients are low stakes: a
-- wrong one is an odd list. Allergens are not. "Chicken Tikka Masala" does
-- not tell you whether THIS kitchen thickens it with cashew paste, and a
-- confident "no nuts" to someone with a nut allergy is an ambulance, not a
-- bad user experience.
--
-- The asymmetry that shapes this migration: **missing allergen data fails
-- safe** — the AI already says "the menu doesn't specify, please check with
-- staff" — while **wrong allergen data fails deadly**, because a diner
-- trusts it. So a suggestion has to be structurally distinguishable from a
-- fact, in the data and not merely in the UI: the moment it is read back,
-- anything that cannot tell them apart will treat a guess as an assertion.

alter table public.menu_item_allergens
  add column confirmed_at timestamptz,
  add column confirmed_by uuid references auth.users (id) on delete set null;

comment on column public.menu_item_allergens.confirmed_at is
  'When a human confirmed this allergen applies to this dish. NULL means it is an unconfirmed suggestion and MUST NOT be presented to a diner or asserted by the AI — see is_allergen_confirmed() and src/lib/ai/tools/menu.ts.';

comment on column public.menu_item_allergens.confirmed_by is
  'Who confirmed it. Kept because "the restaurant told us" is the only authority this platform ever has for an allergen claim.';

-- Every row that exists today was typed in by restaurant staff through the
-- dashboard — there was no other way to create one. Those are confirmed by
-- definition, and backfilling them is what stops this migration silently
-- hiding allergen data that diners are already relying on.
update public.menu_item_allergens
set confirmed_at = created_at
where confirmed_at is null;

-- A partial index over the only rows any customer-facing query wants.
create index menu_item_allergens_confirmed_idx
  on public.menu_item_allergens (menu_item_id)
  where confirmed_at is not null;

-- The single definition of "safe to tell a diner", so no read path has to
-- remember the rule. Used by application queries and readable from SQL.
create or replace function public.confirmed_allergen_ids(target_menu_item_id uuid)
returns setof uuid
language sql
stable
as $$
  select allergen_id
  from public.menu_item_allergens
  where menu_item_id = target_menu_item_id
    and confirmed_at is not null
$$;

comment on function public.confirmed_allergen_ids(uuid) is
  'Allergen ids a restaurant has actually confirmed for a dish. Unconfirmed suggestions are excluded on purpose: this platform never states an allergen on its own authority.';

-- Confirming is a deliberate, per-item act. Exposed as a function rather
-- than a plain update so the reviewer identity is always recorded, and so
-- "confirm" can never be done accidentally by a broad UPDATE.
create or replace function public.confirm_menu_item_allergens(
  p_menu_item_id uuid,
  p_allergen_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_confirmed integer;
begin
  select restaurant_id into v_restaurant_id
  from public.menu_items where id = p_menu_item_id;

  if not found then
    raise exception 'ALLERGEN_ITEM_NOT_FOUND';
  end if;

  -- SECURITY DEFINER bypasses RLS, so the caller's authority is checked
  -- explicitly. Manager/owner, not all staff: this is a safety claim about
  -- food, made in the restaurant's name.
  if not public.is_restaurant_manager_or_owner(v_restaurant_id) then
    raise exception 'ALLERGEN_FORBIDDEN';
  end if;

  -- Confirm the ones the reviewer ticked...
  update public.menu_item_allergens
  set confirmed_at = now(), confirmed_by = (select auth.uid())
  where menu_item_id = p_menu_item_id
    and allergen_id = any(p_allergen_ids)
    and confirmed_at is null;

  get diagnostics v_confirmed = row_count;

  -- ...and delete the suggestions they did not. An unticked suggestion is
  -- a rejection, and leaving it lying around unconfirmed would mean
  -- re-asking the same question forever.
  delete from public.menu_item_allergens
  where menu_item_id = p_menu_item_id
    and confirmed_at is null
    and not (allergen_id = any(p_allergen_ids));

  return v_confirmed;
end;
$$;

comment on function public.confirm_menu_item_allergens(uuid, uuid[]) is
  'Confirms the given allergens for one dish and discards the suggestions the reviewer rejected. Manager/owner only. Records who confirmed.';

revoke execute on function public.confirm_menu_item_allergens(uuid, uuid[]) from public;
grant execute on function public.confirm_menu_item_allergens(uuid, uuid[]) to authenticated;
