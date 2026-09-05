-- Let a reviewer ADD an allergen while confirming, not only remove one.
--
-- The review screen previously offered exactly the allergens the model had
-- suggested, pre-ticked. That is the wrong shape, because the suggestion
-- prompt deliberately tells the model to leave an allergen out when it is
-- unsure — so it under-suggests by design. A reviewer who can only untick
-- can correct the model in one direction and not the other, which is
-- precisely the direction that matters: a kitchen that knows its dahi vada
-- is finished with a wheat-based sev had no way to say so.
--
-- So the screen now shows the whole allergen vocabulary with suggestions
-- pre-ticked, and this function takes NAMES rather than ids: an allergen
-- the restaurant has never used before will not have a row in
-- public.allergens yet, and requiring the caller to create one first would
-- put a second, unaudited write path next to this one.

drop function if exists public.confirm_menu_item_allergens(uuid, uuid[]);

create or replace function public.confirm_menu_item_allergens(
  p_menu_item_id uuid,
  p_allergen_names text[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_name text;
  v_allergen_id uuid;
  v_confirmed_ids uuid[] := '{}';
  v_count integer := 0;
begin
  select restaurant_id into v_restaurant_id
  from public.menu_items where id = p_menu_item_id;

  if not found then
    raise exception 'ALLERGEN_ITEM_NOT_FOUND';
  end if;

  -- SECURITY DEFINER bypasses RLS, so the caller's authority is checked
  -- explicitly. Manager/owner only: this is a safety claim about food,
  -- published in the restaurant's name.
  if not public.is_restaurant_manager_or_owner(v_restaurant_id) then
    raise exception 'ALLERGEN_FORBIDDEN';
  end if;

  foreach v_name in array coalesce(p_allergen_names, '{}')
  loop
    v_name := trim(v_name);
    continue when v_name = '';

    -- Reuse the restaurant's existing allergen row where there is one, so
    -- confirming does not quietly create "Milk" twice.
    select id into v_allergen_id
    from public.allergens
    where restaurant_id = v_restaurant_id and name = v_name;

    if v_allergen_id is null then
      insert into public.allergens (restaurant_id, name)
      values (v_restaurant_id, v_name)
      returning id into v_allergen_id;
    end if;

    insert into public.menu_item_allergens (
      restaurant_id, menu_item_id, allergen_id, confirmed_at, confirmed_by
    )
    values (
      v_restaurant_id, p_menu_item_id, v_allergen_id, now(), (select auth.uid())
    )
    on conflict (menu_item_id, allergen_id) do update
      -- An already-confirmed row keeps its original confirmation: re-saving
      -- a dish must not rewrite who vouched for it or when.
      set confirmed_at = coalesce(public.menu_item_allergens.confirmed_at, now()),
          confirmed_by = coalesce(public.menu_item_allergens.confirmed_by, (select auth.uid()));

    v_confirmed_ids := v_confirmed_ids || v_allergen_id;
    v_count := v_count + 1;
  end loop;

  -- Anything left unticked and unconfirmed was a suggestion the reviewer
  -- rejected. Removed so the same question is not asked forever.
  -- Deliberately scoped to UNCONFIRMED rows: unticking cannot silently
  -- withdraw an allergen a human previously vouched for, which would be a
  -- safety claim disappearing without anyone deciding to withdraw it.
  delete from public.menu_item_allergens
  where menu_item_id = p_menu_item_id
    and confirmed_at is null
    and not (allergen_id = any(v_confirmed_ids));

  return v_count;
end;
$$;

comment on function public.confirm_menu_item_allergens(uuid, text[]) is
  'Confirms the given allergens for one dish BY NAME, creating the restaurant''s allergen row if it does not exist yet, and discards unconfirmed suggestions the reviewer rejected. Never rewrites an existing confirmation, and never removes an already-confirmed allergen. Manager/owner only.';

revoke execute on function public.confirm_menu_item_allergens(uuid, text[]) from public;
grant execute on function public.confirm_menu_item_allergens(uuid, text[]) to authenticated;
