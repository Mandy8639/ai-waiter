-- Kitchen mode: the kitchen account may mark a dish, or one add-on, sold
-- out — and back — mid-service.
--
-- The kitchen knows first when the naan runs out. Until now only an owner
-- or manager could say so (menu_items_update_owner_manager, and the same
-- rule for modifier options), so a kitchen-only login had to find a
-- manager, or keep taking orders it couldn't make.
--
-- Widening the UPDATE policies would hand the kitchen the whole row:
-- prices, names, descriptions. These two functions change exactly one
-- column, is_available, and nothing else, which is the whole of what the
-- kitchen needs. Diners already can't order an unavailable dish or option:
-- submit_order() refuses both, and the menu hides them.
--
-- Staff (front of house) are deliberately not included; the switch belongs
-- to whoever is cooking, and to the managers.

create function public.set_menu_item_availability(
  p_menu_item_id uuid,
  p_available boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_role text;
begin
  if p_available is null then
    raise exception 'SOLD_OUT_INVALID: say whether the dish is available'
      using errcode = '22023';
  end if;

  select mi.restaurant_id into v_restaurant_id
  from public.menu_items mi where mi.id = p_menu_item_id;

  if not found then
    raise exception 'SOLD_OUT_NOT_FOUND: no such dish' using errcode = 'P0002';
  end if;

  -- SECURITY DEFINER bypasses RLS, so this role check IS the access control.
  v_role := public.current_restaurant_role(v_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'kitchen') then
    raise exception 'SOLD_OUT_FORBIDDEN: only the kitchen or a manager can change this'
      using errcode = '42501';
  end if;

  update public.menu_items
  set is_available = p_available
  where id = p_menu_item_id;
end;
$$;

comment on function public.set_menu_item_availability(uuid, boolean) is
  'Marks a dish sold out or back in stock. Owner, manager or kitchen; changes is_available and nothing else.';

revoke execute on function public.set_menu_item_availability(uuid, boolean) from public, anon;
grant execute on function public.set_menu_item_availability(uuid, boolean) to authenticated;


create function public.set_modifier_option_availability(
  p_option_id uuid,
  p_available boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_role text;
begin
  if p_available is null then
    raise exception 'SOLD_OUT_INVALID: say whether the option is available'
      using errcode = '22023';
  end if;

  -- modifier_options has no restaurant_id of its own: its tenant is its
  -- modifier group's.
  select mim.restaurant_id into v_restaurant_id
  from public.modifier_options mo
  join public.menu_item_modifiers mim on mim.id = mo.modifier_id
  where mo.id = p_option_id;

  if not found then
    raise exception 'SOLD_OUT_NOT_FOUND: no such option' using errcode = 'P0002';
  end if;

  v_role := public.current_restaurant_role(v_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'kitchen') then
    raise exception 'SOLD_OUT_FORBIDDEN: only the kitchen or a manager can change this'
      using errcode = '42501';
  end if;

  update public.modifier_options
  set is_available = p_available
  where id = p_option_id;
end;
$$;

comment on function public.set_modifier_option_availability(uuid, boolean) is
  'Marks one add-on or option sold out or back in stock. Owner, manager or kitchen; changes is_available and nothing else.';

revoke execute on function public.set_modifier_option_availability(uuid, boolean) from public, anon;
grant execute on function public.set_modifier_option_availability(uuid, boolean) to authenticated;
